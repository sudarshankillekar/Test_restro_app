#!/usr/bin/env python3

import requests
import sys
import json
from datetime import datetime

class FocusedIsolationTester:
    def __init__(self, base_url="https://resto-flow-24.preview.emergentagent.com"):
        self.base_url = base_url
        self.session = requests.Session()
        self.tests_run = 0
        self.tests_passed = 0

    def log(self, message):
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}")

    def run_test(self, name, method, endpoint, expected_status, data=None):
        """Run a single API test"""
        url = f"{self.base_url}/api/{endpoint}"
        headers = {'Content-Type': 'application/json'}

        self.tests_run += 1
        self.log(f"🔍 Testing {name}...")
        
        try:
            if method == 'GET':
                response = self.session.get(url, headers=headers)
            elif method == 'POST':
                response = self.session.post(url, json=data, headers=headers)

            success = response.status_code == expected_status
            if success:
                self.tests_passed += 1
                self.log(f"✅ {name} - Status: {response.status_code}")
                try:
                    return True, response.json()
                except:
                    return True, {}
            else:
                self.log(f"❌ {name} - Expected {expected_status}, got {response.status_code}")
                try:
                    error_detail = response.json()
                    self.log(f"   Error: {error_detail}")
                except:
                    self.log(f"   Response: {response.text}")
                return False, {}

        except Exception as e:
            self.log(f"❌ {name} - Error: {str(e)}")
            return False, {}

    def test_existing_data_isolation(self):
        """Test isolation using existing data"""
        self.log("\n=== Testing Data Isolation with Existing Data ===")
        
        # Login as existing admin user
        success, response = self.run_test(
            "Admin Login",
            "POST",
            "auth/login",
            200,
            data={"email": "admin@restaurant.com", "password": "admin123"}
        )
        
        if success:
            admin_restaurant_id = response.get('restaurant_id')
            self.log(f"   Admin restaurant_id: {admin_restaurant_id}")
            
            # Get orders for admin
            success, response = self.run_test(
                "Admin Get Orders",
                "GET",
                "orders",
                200
            )
            if success:
                admin_orders = response
                self.log(f"   Admin sees {len(admin_orders)} orders")
                
                # Check if all orders belong to admin's restaurant
                isolation_ok = True
                for order in admin_orders:
                    if order.get('restaurant_id') != admin_restaurant_id:
                        isolation_ok = False
                        self.log(f"   ❌ Found order from different restaurant: {order.get('restaurant_id')}")
                
                if isolation_ok:
                    self.log("   ✅ All orders belong to admin's restaurant")
                    self.tests_passed += 1
                self.tests_run += 1
        
        # Login as kitchen staff
        success, response = self.run_test(
            "Kitchen Staff Login",
            "POST",
            "auth/login",
            200,
            data={"email": "kitchen@restaurant.com", "password": "kitchen123"}
        )
        
        if success:
            kitchen_restaurant_id = response.get('restaurant_id')
            self.log(f"   Kitchen restaurant_id: {kitchen_restaurant_id}")
            
            # Get orders for kitchen
            success, response = self.run_test(
                "Kitchen Get Orders",
                "GET",
                "orders",
                200
            )
            if success:
                kitchen_orders = response
                self.log(f"   Kitchen sees {len(kitchen_orders)} orders")
                
                # Check isolation
                isolation_ok = True
                for order in kitchen_orders:
                    if order.get('restaurant_id') != kitchen_restaurant_id:
                        isolation_ok = False
                        self.log(f"   ❌ Kitchen sees order from different restaurant: {order.get('restaurant_id')}")
                
                if isolation_ok:
                    self.log("   ✅ Kitchen sees only own restaurant orders")
                    self.tests_passed += 1
                self.tests_run += 1
        
        # Login as billing staff
        success, response = self.run_test(
            "Billing Staff Login",
            "POST",
            "auth/login",
            200,
            data={"email": "billing@restaurant.com", "password": "billing123"}
        )
        
        if success:
            billing_restaurant_id = response.get('restaurant_id')
            self.log(f"   Billing restaurant_id: {billing_restaurant_id}")
            
            # Get orders for billing
            success, response = self.run_test(
                "Billing Get Orders",
                "GET",
                "orders",
                200
            )
            if success:
                billing_orders = response
                self.log(f"   Billing sees {len(billing_orders)} orders")
                
                # Check isolation
                isolation_ok = True
                for order in billing_orders:
                    if order.get('restaurant_id') != billing_restaurant_id:
                        isolation_ok = False
                        self.log(f"   ❌ Billing sees order from different restaurant: {order.get('restaurant_id')}")
                
                if isolation_ok:
                    self.log("   ✅ Billing sees only own restaurant orders")
                    self.tests_passed += 1
                self.tests_run += 1

    def test_order_continuation_with_existing_table(self):
        """Test order continuation using existing table"""
        self.log("\n=== Testing Order Continuation with Existing Table ===")
        
        # Get existing tables
        success, response = self.run_test(
            "Get Existing Tables",
            "GET",
            "tables",
            200
        )
        
        if success and response:
            table_id = response[0]['table_id']
            self.log(f"   Using existing table: {table_id}")
            
            # Get existing menu items
            success, response = self.run_test(
                "Get Existing Menu Items",
                "GET",
                "menu/items",
                200
            )
            
            if success and response:
                item_id = response[0]['item_id']
                item_price = response[0]['price']
                self.log(f"   Using existing item: {item_id} (₹{item_price})")
                
                # Create customer session
                success, response = self.run_test(
                    "Create Customer Session for Continuation Test",
                    "POST",
                    "customer/session",
                    200,
                    data={
                        "table_id": table_id,
                        "customer_name": "Continuation Test Customer",
                        "phone": "7777777777"
                    }
                )
                
                if success:
                    session_token = response.get('session_token')
                    restaurant_id = response.get('restaurant_id')
                    self.log(f"   Session created for restaurant: {restaurant_id}")
                    
                    # Create first order
                    success, response = self.run_test(
                        "Create First Order",
                        "POST",
                        "orders",
                        200,
                        data={
                            "customer_session_token": session_token,
                            "items": [{
                                "item_id": item_id,
                                "quantity": 1,
                                "instructions": "First order"
                            }]
                        }
                    )
                    
                    if success:
                        first_order_id = response.get('order_id')
                        first_total = response.get('total', 0)
                        first_items_count = len(response.get('items', []))
                        self.log(f"   First order: {first_order_id}, Total: ₹{first_total}, Items: {first_items_count}")
                        
                        # Create second order (should merge)
                        success, response = self.run_test(
                            "Create Second Order (Should Merge)",
                            "POST",
                            "orders",
                            200,
                            data={
                                "customer_session_token": session_token,
                                "items": [{
                                    "item_id": item_id,
                                    "quantity": 2,
                                    "instructions": "Second order - should merge"
                                }]
                            }
                        )
                        
                        if success:
                            second_order_id = response.get('order_id')
                            second_total = response.get('total', 0)
                            second_items_count = len(response.get('items', []))
                            self.log(f"   Second order: {second_order_id}, Total: ₹{second_total}, Items: {second_items_count}")
                            
                            # Check if orders merged
                            if first_order_id == second_order_id:
                                if second_total > first_total and second_items_count > first_items_count:
                                    self.log("   ✅ Order continuation working - orders merged correctly")
                                    self.tests_passed += 1
                                else:
                                    self.log("   ❌ Order continuation failed - totals/items didn't increase properly")
                            else:
                                self.log("   ❌ Order continuation failed - new order created instead of merging")
                            self.tests_run += 1

    def test_customer_data_per_restaurant(self):
        """Test customer data storage per restaurant"""
        self.log("\n=== Testing Customer Data Per Restaurant ===")
        
        # Get existing tables
        success, response = self.run_test(
            "Get Tables for Customer Data Test",
            "GET",
            "tables",
            200
        )
        
        if success and response:
            table_id = response[0]['table_id']
            
            # Create customer session
            success, response = self.run_test(
                "Create Customer Session for Data Test",
                "POST",
                "customer/session",
                200,
                data={
                    "table_id": table_id,
                    "customer_name": "Customer Data Test",
                    "phone": "6666666666"
                }
            )
            
            if success:
                restaurant_id = response.get('restaurant_id')
                session_token = response.get('session_token')
                
                if restaurant_id:
                    self.log(f"   ✅ Customer session includes restaurant_id: {restaurant_id}")
                    self.tests_passed += 1
                else:
                    self.log("   ❌ Customer session missing restaurant_id")
                self.tests_run += 1
                
                # Verify session
                success, response = self.run_test(
                    "Verify Customer Session",
                    "GET",
                    f"customer/session/{session_token}",
                    200
                )
                
                if success:
                    self.log("   ✅ Customer session verification working")
                    self.tests_passed += 1
                self.tests_run += 1

    def run_focused_tests(self):
        """Run focused isolation tests"""
        self.log("🚀 Starting Focused Multi-Tenant Isolation Tests")
        self.log(f"📍 Testing against: {self.base_url}")
        
        try:
            self.test_existing_data_isolation()
            self.test_order_continuation_with_existing_table()
            self.test_customer_data_per_restaurant()
            
            # Print results
            self.log(f"\n📊 Focused Test Results: {self.tests_passed}/{self.tests_run} passed")
            success_rate = (self.tests_passed / self.tests_run * 100) if self.tests_run > 0 else 0
            self.log(f"Success rate: {success_rate:.1f}%")
            
            return 0 if success_rate >= 80 else 1
                
        except Exception as e:
            self.log(f"💥 Test suite failed with error: {str(e)}")
            return 1

def main():
    tester = FocusedIsolationTester()
    return tester.run_focused_tests()

if __name__ == "__main__":
    sys.exit(main())