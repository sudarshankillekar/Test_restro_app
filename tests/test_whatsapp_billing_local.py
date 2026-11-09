"""Offline integration checks. No MongoDB, payment, or real WhatsApp traffic."""
import base64
import asyncio
import copy
import io
import json
import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from pypdf import PdfReader
from backend import whatsapp_billing as billing

PAYMENT = dict(payment_id='PAY-LOCAL', bill_id='BILL-LOCAL', restaurant_id='LOCAL',
               status='completed', subtotal=460, tax=23, tax_percentage=5,
               total=483, payment_method='upi', created_at=datetime(2026, 9, 12, 8, tzinfo=timezone.utc))
ORDERS = [dict(customer_name='Local Test Customer', phone='8904356647', items=[
    dict(name='Paneer Tikka', quantity=2, price=200), dict(name='Coke', quantity=1, price=60)])]
RESTAURANT = dict(name='Dineflo Local Test')
ENV = dict(EVOLUTION_API_URL='https://evolution.invalid', EVOLUTION_API_KEY='local-fake-key',
           EVOLUTION_INSTANCE='local-test', WHATSAPP_DEFAULT_COUNTRY_CODE='91',
           EVOLUTION_WAKE_MAX_SECONDS='0', EVOLUTION_WAKE_RETRY_SECONDS='0')


class LocalBillingTests(unittest.IsolatedAsyncioTestCase):
    async def deliver(self, *, env=None, orders=None, status=201, body=None, timeout=False, payment=None, repeats=1):
        payment = copy.deepcopy(payment or PAYMENT)
        stored = copy.deepcopy(payment)
        async def claim(query, update):
            self.assertEqual(query['restaurant_id'], stored['restaurant_id'])
            self.assertEqual(query['payment_id'], stored['payment_id'])
            if (stored.get('whatsapp_status') not in query['whatsapp_status']['$in']
                    or stored.get('whatsapp_message_id') not in query['whatsapp_message_id']['$in']
                    or stored.get('whatsapp_sent_at') is not None):
                return None
            before = copy.deepcopy(stored)
            stored.update(update['$set'])
            return before
        async def update_payment(query, update):
            stored.update(update.get('$set', {}))
            for key in update.get('$unset', {}):
                stored.pop(key, None)
        requests = []
        def handler(request):
            requests.append(request)
            if timeout:
                raise httpx.ReadTimeout('simulated timeout', request=request)
            if str(request.url).endswith('/instance/connectionState/local-test'):
                return httpx.Response(200, json={'instance': {'state': 'open'}})
            return httpx.Response(status, json=body if body is not None else {'key': {'id': 'LOCAL-MESSAGE'}})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        db = SimpleNamespace(
            payments=SimpleNamespace(update_one=AsyncMock(side_effect=update_payment), find_one_and_update=AsyncMock(side_effect=claim)),
            customer_sessions=SimpleNamespace(find_one=AsyncMock(return_value=None)),
            customers=SimpleNamespace(find_one=AsyncMock(return_value=None)),
        )
        before = copy.deepcopy(payment)
        with patch.dict(os.environ, ENV if env is None else env, clear=True), \
             patch.object(billing.httpx, 'AsyncClient', return_value=client), \
             patch.object(billing.logger, 'exception'):
            await asyncio.gather(*(billing.send_bill_pdf_via_evolution(payment, ORDERS if orders is None else orders, RESTAURANT, db) for _ in range(repeats)))
        self.assertEqual(payment, before)
        calls = db.payments.update_one.call_args_list
        for call in calls:
            self.assertEqual(call.args[0], {'restaurant_id': 'LOCAL', 'payment_id': 'PAY-LOCAL'})
        return requests, stored

    async def test_pdf_sent_with_expected_payload_and_saved_message_id(self):
        requests, state = await self.deliver()
        self.assertEqual(len(requests), 2)
        self.assertEqual(str(requests[0].url), 'https://evolution.invalid/instance/connectionState/local-test')
        request = requests[1]
        self.assertEqual(str(request.url), 'https://evolution.invalid/message/sendMedia/local-test')
        self.assertEqual(request.headers['apikey'], 'local-fake-key')
        payload = json.loads(request.content)
        self.assertEqual(payload['number'], '918904356647')
        self.assertEqual(payload['mimetype'], 'application/pdf')
        self.assertEqual(payload['fileName'], 'BILL-LOCAL.pdf')
        self.assertIn('Dear Local Test Customer,', payload['caption'])
        self.assertIn('Thank you for your recent order at *Dineflo Local Test*!', payload['caption'])
        self.assertIn('💰 Amount : *Rs.483*', payload['caption'])
        self.assertIn('Reply with:', payload['caption'])
        reader = PdfReader(io.BytesIO(base64.b64decode(payload['media'], validate=True)))
        text = ''.join(page.extract_text() for page in reader.pages)
        for value in ['BILL-LOCAL', 'Paneer Tikka', '483.00', 'UPI']:
            self.assertIn(value, text)
        self.assertEqual(state['whatsapp_status'], 'sent')
        self.assertEqual(state['whatsapp_message_id'], 'LOCAL-MESSAGE')

    async def test_missing_configuration_skips_network(self):
        requests, state = await self.deliver(env={})
        self.assertFalse(requests)
        self.assertEqual(state['whatsapp_status'], 'skipped')

    async def test_missing_phone_skips_network(self):
        requests, state = await self.deliver(orders=[dict(phone='')])
        self.assertFalse(requests)
        self.assertEqual(state['whatsapp_status'], 'skipped')

    async def test_qr_session_phone_is_not_used_when_order_phone_missing(self):
        requests = []
        def handler(request):
            requests.append(request)
            if str(request.url).endswith('/instance/connectionState/local-test'):
                return httpx.Response(200, json={'instance': {'state': 'open'}})
            return httpx.Response(201, json={'key': {'id': 'SESSION-MESSAGE'}})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        db = SimpleNamespace(
            payments=SimpleNamespace(update_one=AsyncMock(), find_one_and_update=AsyncMock(return_value=dict(PAYMENT, table_id='table-1'))),
            customer_sessions=SimpleNamespace(find_one=AsyncMock(return_value={'phone': '7795446647'})),
            customers=SimpleNamespace(find_one=AsyncMock(return_value=None)),
        )
        payment = dict(PAYMENT, table_id='table-1')
        orders = [dict(ORDERS[0], phone='')]
        with patch.dict(os.environ, ENV, clear=True), patch.object(billing.httpx, 'AsyncClient', return_value=client):
            await billing.send_bill_pdf_via_evolution(payment, orders, RESTAURANT, db)
        self.assertEqual(requests, [])
        db.customer_sessions.find_one.assert_not_awaited()

    async def test_customer_record_phone_is_not_used_when_order_phone_missing(self):
        requests = []
        def handler(request):
            requests.append(request)
            if str(request.url).endswith('/instance/connectionState/local-test'):
                return httpx.Response(200, json={'instance': {'state': 'open'}})
            return httpx.Response(201, json={'key': {'id': 'CUSTOMER-MESSAGE'}})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        db = SimpleNamespace(
            payments=SimpleNamespace(update_one=AsyncMock(), find_one_and_update=AsyncMock(return_value=PAYMENT)),
            customer_sessions=SimpleNamespace(find_one=AsyncMock(return_value=None)),
            customers=SimpleNamespace(find_one=AsyncMock(return_value={'phone': '9620629975'})),
        )
        payment = dict(PAYMENT, table_id='')
        orders = [dict(ORDERS[0], phone='')]
        with patch.dict(os.environ, ENV, clear=True), patch.object(billing.httpx, 'AsyncClient', return_value=client):
            await billing.send_bill_pdf_via_evolution(payment, orders, RESTAURANT, db)
        self.assertEqual(requests, [])
        db.customers.find_one.assert_not_awaited()

    async def test_api_rejection_records_failure_without_raising(self):
        _, state = await self.deliver(status=401)
        self.assertEqual(state['whatsapp_status'], 'delivery_unknown')

    async def test_timeout_is_not_retried(self):
        requests, state = await self.deliver(timeout=True, env=dict(ENV, EVOLUTION_WAKE_MAX_SECONDS='90', EVOLUTION_WAKE_RETRY_SECONDS='1'))
        self.assertEqual(state['whatsapp_status'], 'delivery_unknown')
        self.assertEqual(len([request for request in requests if request.method == 'POST']), 1)

    async def test_conflicting_order_numbers_skip_delivery(self):
        requests, state = await self.deliver(orders=[ORDERS[0], dict(ORDERS[0], phone='7795446647')])
        self.assertFalse(requests)
        self.assertEqual(state['whatsapp_status'], 'skipped')

    async def test_saved_recipient_wins_over_changed_order_and_payment_phone(self):
        requests, state = await self.deliver(payment=dict(PAYMENT, phone='7795446647', whatsapp_recipient_phone='919620629975'))
        self.assertEqual(json.loads(requests[-1].content)['number'], '919620629975')
        self.assertEqual(state['whatsapp_recipient_phone'], '919620629975')

    async def test_saved_empty_recipient_does_not_fall_back(self):
        requests, state = await self.deliver(payment=dict(PAYMENT, whatsapp_recipient_phone=''))
        self.assertFalse(requests)
        self.assertEqual(state['whatsapp_status'], 'skipped')

    async def test_concurrent_delivery_claim_sends_once(self):
        requests, state = await self.deliver(repeats=3)
        self.assertEqual(len([request for request in requests if request.method == 'POST']), 1)
        self.assertEqual(state['whatsapp_status'], 'sent')

    async def test_sent_sending_and_uncertain_bills_cannot_be_resent(self):
        for status in ['sent', 'sending', 'delivery_unknown']:
            requests, state = await self.deliver(payment=dict(PAYMENT, whatsapp_status=status))
            self.assertFalse(requests)
            self.assertEqual(state['whatsapp_status'], status)

    async def test_recorded_delivery_blocks_retry_even_with_failed_status(self):
        for fields in [{'whatsapp_message_id': 'already-sent'}, {'whatsapp_sent_at': datetime.now(timezone.utc)}]:
            requests, _ = await self.deliver(payment=dict(PAYMENT, whatsapp_status='failed', **fields))
            self.assertFalse(requests)

    async def test_legacy_failure_requires_review(self):
        requests, state = await self.deliver(payment=dict(PAYMENT, whatsapp_status='failed'))
        self.assertFalse(requests)
        self.assertEqual(state['whatsapp_status'], 'delivery_unknown')

    async def test_retry_before_post_uses_saved_recipient(self):
        requests, state = await self.deliver(payment=dict(PAYMENT, whatsapp_status='failed', whatsapp_recipient_phone='919620629975'))
        self.assertEqual(json.loads(requests[-1].content)['number'], '919620629975')
        self.assertEqual(state['whatsapp_status'], 'sent')

    def test_same_phone_in_different_formats_is_unambiguous(self):
        self.assertEqual(billing.find_order_phone([{'phone': '8904356647'}, {'phone': '+91 89043 56647'}]), '918904356647')

    def test_long_bill_paginates(self):
        orders = copy.deepcopy(ORDERS)
        orders[0]['items'] = [dict(name=f'Long menu item {i} with extra description', quantity=1, price=10) for i in range(120)]
        reader = PdfReader(io.BytesIO(billing.build_bill_pdf(PAYMENT, orders, RESTAURANT)))
        self.assertGreater(len(reader.pages), 1)
        text = ''.join(page.extract_text() for page in reader.pages)
        self.assertIn('Long menu item 119', text)
        self.assertIn('Total Paid', text)

    def test_number_formats(self):
        with patch.dict(os.environ, ENV, clear=True):
            for value in ['8904356647', '+91 89043 56647', '00918904356647']:
                self.assertEqual(billing.normalize_whatsapp_number(value), '918904356647')
            self.assertEqual(billing.normalize_whatsapp_number('123'), '')


if __name__ == '__main__':
    unittest.main()
