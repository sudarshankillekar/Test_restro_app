"""Pure rules and optional isolated MongoDB transaction integration tests.

Set LOYALTY_TEST_MONGO=1 only for the disposable replica set on localhost:27029.
No real payments or WhatsApp requests are made.
"""
import asyncio
import os
import unittest
import uuid
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch
from datetime import datetime, timezone

from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import DuplicateKeyError
from backend.loyalty import calculate_coins, normalize_phone, save_payment, delete_loyalty_bill
from backend.whatsapp_billing import build_whatsapp_bill_message
from backend.models import PaymentCreate, PosCheckoutCreate, PosBillDeleteRequest


class CoinRulesTests(unittest.TestCase):
    def test_earning_boundaries(self):
        for paid, earned in [(0, 0), (99.99, 0), (100, 8), (199.99, 8), (250, 16), (2500, 200)]:
            self.assertEqual(calculate_coins(paid, 0, 0), (paid, earned, earned))

    def test_redemption_only_earns_on_cash_value(self):
        self.assertEqual(calculate_coins(550, 300, 200), (350, 24, 124))
        self.assertEqual(calculate_coins(200, 200, 200), (0, 0, 0))

    def test_invalid_redemption(self):
        for total, balance, redeem in [(300, 199, 1), (300, 200, 201), (99, 200, 100), (300, 200, -1), (300, 200, 1.5), (300, 200, True)]:
            with self.assertRaises(HTTPException):
                calculate_coins(total, balance, redeem)
        for total in ['NaN', 'Infinity', '-1', 'invalid']:
            with self.assertRaises(HTTPException): calculate_coins(total, 200, 0)

    def test_normalization(self):
        for value in ['9876543210', '+91 98765 43210', '00919876543210']:
            self.assertEqual(normalize_phone(value), '919876543210')
        for value in ['', 'abc9876543210', '123', '1234567890']:
            with self.assertRaises(HTTPException): normalize_phone(value)

    def test_message_balance_and_zero_payment(self):
        text = build_whatsapp_bill_message({'total': 0, 'loyalty_phone': '919876543210', 'loyalty_earned': 0,
            'loyalty_redeemed': 200, 'loyalty_balance': 0}, [], {'name': 'Test'})
        self.assertIn('Rs.0', text)
        self.assertIn('Coins redeemed: 200', text)
        self.assertIn('Balance after this bill: 0 coins', text)


@unittest.skipUnless(os.getenv('LOYALTY_TEST_MONGO') == '1', 'Requires disposable local replica set')
class LoyaltyTransactionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncIOMotorClient('mongodb://127.0.0.1:27029/?replicaSet=loyaltyTest', serverSelectionTimeoutMS=5000)
        self.db = self.client['loyalty_test_' + uuid.uuid4().hex]
        self.phone = '919876543210'
        await self.db.loyalty_accounts.insert_one({'_id': 'rest:' + self.phone, 'balance': 200})
        # Create collections before running concurrent transactions.
        for name in ['loyalty_ledger', 'payments', 'orders', 'deleted_bills']:
            await self.db.create_collection(name)

    async def asyncTearDown(self):
        await self.client.drop_database(self.db.name)
        self.client.close()

    def payment(self, identifier='PAY1', total=500, restaurant='rest'):
        return {'payment_id': identifier, 'bill_id': 'BILL' + identifier, 'restaurant_id': restaurant,
                'total': total, 'status': 'completed', 'created_at': datetime.now(timezone.utc)}

    async def balance(self, restaurant='rest'):
        account = await self.db.loyalty_accounts.find_one({'_id': restaurant + ':' + self.phone})
        return (account or {}).get('balance', 0)

    async def test_atomic_payment_and_order(self):
        payment = self.payment()
        await save_payment(self.db, payment, self.phone, 200, new_order={'order_id': 'O1'})
        self.assertEqual(payment['total'], 300)
        self.assertEqual(await self.balance(), 24)
        self.assertEqual(await self.db.payments.count_documents({}), 1)
        self.assertEqual(await self.db.orders.count_documents({}), 1)

    async def test_duplicate_bill_does_not_earn_twice(self):
        await save_payment(self.db, self.payment(), self.phone)
        with self.assertRaises(DuplicateKeyError):
            await save_payment(self.db, self.payment(), self.phone)
        self.assertEqual(await self.balance(), 240)
        self.assertEqual(await self.db.payments.count_documents({}), 1)

    async def test_two_counters_cannot_spend_same_coins(self):
        results = await asyncio.gather(*(save_payment(self.db, self.payment(str(i), 200), self.phone, 200)
                                         for i in range(2)), return_exceptions=True)
        self.assertEqual(sum(isinstance(result, HTTPException) for result in results), 1)
        self.assertEqual(await self.balance(), 0)
        self.assertEqual(await self.db.payments.count_documents({}), 1)

    async def test_transaction_failure_rolls_back_all_changes(self):
        await self.db.orders.insert_one({'_id': 'collision'})
        with self.assertRaises(DuplicateKeyError):
            await save_payment(self.db, self.payment(), self.phone, 200, new_order={'_id': 'collision'})
        self.assertEqual(await self.balance(), 200)
        self.assertEqual(await self.db.payments.count_documents({}), 0)
        self.assertEqual(await self.db.loyalty_ledger.count_documents({}), 0)

    async def test_restaurants_are_isolated(self):
        await save_payment(self.db, self.payment(restaurant='other'), self.phone)
        self.assertEqual(await self.balance(), 200)
        self.assertEqual(await self.balance('other'), 40)

    async def test_delete_reverses_once_and_preserves_audit(self):
        payment = self.payment()
        await save_payment(self.db, payment, self.phone, 200)
        await delete_loyalty_bill(self.db, payment, {'reason': 'Test reversal'}, [])
        self.assertEqual(await self.balance(), 200)
        self.assertEqual(await self.db.loyalty_ledger.count_documents({}), 2)
        self.assertEqual(await self.db.payments.count_documents({}), 0)
        with self.assertRaises(HTTPException):
            await delete_loyalty_bill(self.db, payment, {'reason': 'Again'}, [])
        self.assertEqual(await self.balance(), 200)

    async def test_missing_phone_with_redemption_is_rejected(self):
        with self.assertRaises(HTTPException):
            await save_payment(self.db, self.payment(), '', 200)
        self.assertEqual(await self.db.payments.count_documents({}), 0)

    def api(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
        with patch.dict(os.environ, {'MONGO_URL': 'mongodb://127.0.0.1:27029/?replicaSet=loyaltyTest',
                                    'DB_NAME': 'loyalty_test_api', 'JWT_SECRET': 'local-loyalty-test-only', 'EVOLUTION_API_URL': ''}):
            import server
        server.client.close()
        return server

    async def test_billing_api_payment_lookup_and_reversal(self):
        server = self.api()
        await self.db.orders.insert_one({'order_id': 'O1', 'restaurant_id': 'rest', 'table_id': 'T1',
            'table_number': 1, 'status': 'prepared', 'total': 500, 'items': [], 'order_type': 'dine_in'})
        await self.db.restaurants.insert_one({'restaurant_id': 'rest', 'tax_enabled': False})
        staff = {'_id': 'staff', 'restaurant_id': 'rest', 'role': 'billing'}
        with patch.object(server, 'db', self.db), patch.object(server, 'get_current_user', AsyncMock(return_value=staff)), \
             patch.object(server, 'schedule_background_task', side_effect=lambda coroutine: coroutine.close()):
            payment = await server.create_payment(PaymentCreate(order_ids=['O1'], payment_method='cash', loyalty_phone=self.phone, loyalty_redeem=200), None)
            self.assertEqual(payment['total'], 300)
            self.assertEqual(payment['loyalty_balance'], 24)
            self.assertEqual((await self.db.orders.find_one({'order_id': 'O1'}))['payment_status'], 'completed')
            account = await server.get_loyalty_customer(None, self.phone)
            self.assertEqual(account['balance'], 24)
            self.assertEqual(account['history'][0]['redeemed'], 200)
            with self.assertRaises(HTTPException):
                await server.create_payment(PaymentCreate(order_ids=['O1'], payment_method='cash', loyalty_phone=self.phone), None)
            await server.delete_completed_payment_bill(payment['bill_id'], PosBillDeleteRequest(reason='Test cancellation'), None)
            self.assertEqual(await self.balance(), 200)

    async def test_rejected_redemption_releases_order_lock(self):
        server = self.api()
        await self.db.orders.insert_one({'order_id': 'O1', 'restaurant_id': 'rest', 'table_id': 'T1',
            'status': 'prepared', 'total': 500, 'items': [], 'order_type': 'dine_in'})
        with patch.object(server, 'db', self.db), patch.object(server, 'get_current_user', AsyncMock(return_value={'_id': 'staff', 'role': 'billing', 'restaurant_id': 'rest'})):
            with self.assertRaises(HTTPException):
                await server.create_payment(PaymentCreate(order_ids=['O1'], payment_method='cash', loyalty_phone=self.phone, loyalty_redeem=300), None)
        order = await self.db.orders.find_one({'order_id': 'O1'})
        self.assertEqual(order['payment_status'], 'pending')
        self.assertNotIn('billing_lock_id', order)
        self.assertEqual(await self.balance(), 200)

    async def test_pos_api_replayed_request_does_not_award_twice(self):
        server = self.api()
        staff = {'_id': 'staff', 'restaurant_id': 'rest', 'role': 'pos'}
        request = PosCheckoutCreate(order_type='takeaway', phone=self.phone, items=[{'item_id': 'I1', 'quantity': 1}],
                                    payment_method='cash', checkout_token='test-idempotency-token')
        with patch.object(server, 'db', self.db), patch.object(server, 'get_current_user', AsyncMock(return_value=staff)), \
             patch.object(server, 'check_restaurant_subscription', AsyncMock(return_value={'tax_enabled': False})), \
             patch.object(server, 'build_order_items_from_input', AsyncMock(return_value=(500, []))), \
             patch.object(server, 'schedule_background_task', side_effect=lambda coroutine: coroutine.close()):
            first = await server.create_pos_checkout(request, None)
            second = await server.create_pos_checkout(request, None)
        self.assertEqual(first['bill_id'], second['bill_id'])
        self.assertEqual(await self.balance(), 240)
        self.assertEqual(await self.db.payments.count_documents({}), 1)

    async def test_reversal_of_spent_earnings_records_debt(self):
        original = self.payment(total=2500)
        await save_payment(self.db, original, self.phone)
        await save_payment(self.db, self.payment('SPEND', total=400), self.phone, 400)
        self.assertEqual(await self.balance(), 0)
        await delete_loyalty_bill(self.db, original, {'reason': 'Refund'}, [])
        self.assertEqual(await self.balance(), -200)

    async def test_lookup_does_not_expose_another_restaurant(self):
        server = self.api()
        with patch.object(server, 'db', self.db), patch.object(server, 'get_current_user', AsyncMock(return_value={'_id': 'staff', 'role': 'billing', 'restaurant_id': 'other'})):
            account = await server.get_loyalty_customer(None, self.phone)
            self.assertEqual(account['balance'], 0)
            self.assertEqual(account['history'], [])


if __name__ == '__main__':
    unittest.main()
