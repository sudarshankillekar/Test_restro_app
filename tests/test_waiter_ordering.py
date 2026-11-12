"""Isolated endpoint tests: no external database, payments, or notifications."""
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
with patch.dict(os.environ, {'MONGO_URL': 'mongodb://127.0.0.1:27029', 'DB_NAME': 'waiter_unit_only', 'JWT_SECRET': 'test-only-secret', 'EVOLUTION_API_URL': ''}):
    import server
server.client.close()


class WaiterOrderingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.staff = {'user_id': 'w1', 'role': 'waiter', 'restaurant_id': 'r1'}
        self.docs = {}
        async def find_one(query, projection=None):
            return self.docs.get(query.get('_id'))
        async def insert_one(doc):
            if doc['_id'] in self.docs:
                raise DuplicateKeyError('duplicate submission')
            self.docs[doc['_id']] = dict(doc)
        self.db = SimpleNamespace(orders=SimpleNamespace(find_one=AsyncMock(side_effect=find_one), insert_one=AsyncMock(side_effect=insert_one)))
        self.patches = [patch.object(server, 'db', self.db),
                        patch.object(server, 'get_current_user', AsyncMock(return_value=self.staff)),
                        patch.object(server, 'build_order_items_from_input', AsyncMock(return_value=(100, [{'item_id': 'i1', 'quantity': 1, 'price': 100}]))),
                        patch.object(server, 'schedule_background_task', side_effect=lambda coroutine: coroutine.close())]
        for item in self.patches: item.start()
        self.addCleanup(lambda: [item.stop() for item in reversed(self.patches)])

    def payload(self, **changes):
        return server.CounterOrderCreate(**{'submission_token': 'test-submission-1234', 'order_type': 'takeaway',
            'items': [{'item_id': 'i1', 'quantity': 1}], **changes})

    async def test_retry_returns_same_order_and_emits_once(self):
        first = await server.create_counter_order(self.payload(), None)
        second = await server.create_counter_order(self.payload(), None)
        self.assertEqual(first['order_id'], second['order_id'])
        self.assertEqual(len(self.docs), 1)
        self.assertEqual(first['order_source'], 'waiter')
        self.assertEqual(server.schedule_background_task.call_count, 2)

    async def test_changed_payload_with_same_token_is_rejected(self):
        await server.create_counter_order(self.payload(), None)
        with self.assertRaises(HTTPException) as raised:
            await server.create_counter_order(self.payload(customer_name='Different'), None)
        self.assertEqual(raised.exception.status_code, 409)

    async def test_concurrent_insert_uses_unique_id(self):
        original = self.db.orders.find_one.side_effect
        self.db.orders.find_one.side_effect = None
        self.db.orders.find_one.return_value = None
        await server.create_counter_order(self.payload(), None)
        self.db.orders.find_one.side_effect = [None, next(iter(self.docs.values()))]
        retry = await server.create_counter_order(self.payload(), None)
        self.assertEqual(retry['order_id'], next(iter(self.docs.values()))['order_id'])
        self.assertEqual(len(self.docs), 1)
        self.db.orders.find_one.side_effect = original

    async def test_token_is_restaurant_scoped(self):
        await server.create_counter_order(self.payload(), None)
        self.staff['restaurant_id'] = 'r2'
        await server.create_counter_order(self.payload(), None)
        self.assertEqual(len(self.docs), 2)

    async def test_dine_in_addon_uses_unpaid_orders_including_served(self):
        self.db.tables = SimpleNamespace(find_one=AsyncMock(return_value={'table_number': 2}))
        cursor = MagicMock()
        cursor.sort.return_value = cursor
        cursor.to_list = AsyncMock(return_value=[{'order_id': 'OLD', 'status': 'served'}])
        self.db.orders.find = MagicMock(return_value=cursor)
        order = await server.create_counter_order(self.payload(order_type='dine_in', table_id='t2'), None)
        self.assertTrue(order['is_add_on'])
        self.assertEqual(order['add_on_to_order_id'], 'OLD')
        query = self.db.orders.find.call_args.args[0]
        self.assertEqual(query['payment_status'], {'$ne': 'completed'})
        self.assertEqual(query['restaurant_id'], 'r1')

    async def test_kitchen_role_cannot_create_waiter_order(self):
        self.staff['role'] = 'kitchen'
        with self.assertRaises(HTTPException) as raised:
            await server.create_counter_order(self.payload(), None)
        self.assertEqual(raised.exception.status_code, 403)

    async def test_waiter_cannot_change_kitchen_status(self):
        with self.assertRaises(HTTPException) as raised:
            await server.update_order_status('OLD', None)
        self.assertEqual(raised.exception.status_code, 403)

    async def test_waiter_cannot_take_payment(self):
        payment = server.PaymentCreate(order_ids=['OLD'], payment_method='cash')
        with self.assertRaises(HTTPException) as raised:
            await server.create_payment(payment, None)
        self.assertEqual(raised.exception.status_code, 403)

    async def test_bill_request_rejects_other_restaurant(self):
        request = SimpleNamespace(json=AsyncMock(return_value={}), query_params={})
        with self.assertRaises(HTTPException) as raised:
            await server.request_order_bill('OTHER', request)
        self.assertEqual(raised.exception.status_code, 404)
        self.assertEqual(self.db.orders.find_one.call_args.args[0]['restaurant_id'], 'r1')

    async def test_bill_request_scoped_and_requires_ready_orders(self):
        request = SimpleNamespace(json=AsyncMock(return_value={}), query_params={})
        self.db.orders.find_one.side_effect = [{'table_id': 't1', 'restaurant_id': 'r1'},
            {'order_id': 'OLD', 'table_id': 't1', 'restaurant_id': 'r1', 'status': 'accepted'}]
        cursor = MagicMock(); cursor.sort.return_value = cursor
        cursor.to_list = AsyncMock(return_value=[{'order_id': 'OLD', 'status': 'accepted'}])
        self.db.orders.find = MagicMock(return_value=cursor)
        with self.assertRaises(HTTPException) as raised:
            await server.request_order_bill('OLD', request)
        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(self.db.orders.find_one.call_args_list[0].args[0]['restaurant_id'], 'r1')

    async def test_ready_bill_request_notifies_billing(self):
        request = SimpleNamespace(json=AsyncMock(return_value={}), query_params={})
        order = {'order_id': 'OLD', 'table_id': 't1', 'restaurant_id': 'r1', 'status': 'prepared'}
        self.db.orders.find_one.side_effect = [order, order]
        cursor = MagicMock(); cursor.sort.return_value = cursor
        cursor.to_list = AsyncMock(return_value=[order])
        self.db.orders.find = MagicMock(return_value=cursor)
        self.db.orders.update_many = AsyncMock()
        with patch.object(server, 'enrich_orders', AsyncMock(return_value=[order])):
            result = await server.request_order_bill('OLD', request)
        self.assertEqual(result['message'], 'Bill requested successfully.')
        self.assertTrue(self.db.orders.update_many.call_args.args[1]['$set']['bill_requested'])


if __name__ == '__main__': unittest.main()
