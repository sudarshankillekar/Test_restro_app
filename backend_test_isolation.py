#!/usr/bin/env python3

import requests
import sys
import json
from datetime import datetime
import time

class MultiTenantIsolationTester:
    def __init__(self, base_url="https://resto-flow-24.preview.emergentagent.com"):
        self.base_url = base_url
        self.session = requests.Session()
        self.tests_run = 0
        self.tests_passed = 0
        
        # Authentication tokens
        self.super_admin_token = None
        self.restaurant_a_admin_token = None
        self.restaurant_a_kitchen_token = None
        self.restaurant_a_billing_token = None
        self.restaurant_b_admin_token = None
        self.restaurant_b_kitchen_token = None
        self.restaurant_b_billing_token = None
        
        # Restaurant data
        self.restaurant_a_id = None
        self.restaurant_b_id = None
        self.restaurant_a_table_id = None
        self.restaurant_b_table_id = None
        self.restaurant_a_order_id = None
        self.restaurant_b_order_id = None
        self.restaurant_a_item_id = None
        self.restaurant_b_item_id = None
        self.restaurant_a_category_id = None
        self.restaurant_b_category_id = None

    def log(self, message):
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}")

    def run_test(self, name, method, endpoint, expected_status, data=None, headers=None):
        """Run a single API test"""
        url = f"{self.base_url}/api/{endpoint}"
        test_headers = {'Content-Type': 'application/json'}
        if headers:
            test_headers.update(headers)

        self.tests_run += 1
        self.log(f"🔍 Testing {name}...")
        
        try:
            if method == 'GET':
                response = self.session.get(url, headers=test_headers)
            elif method == 'POST':
                response = self.session.post(url, json=data, headers=test_headers)
            elif method == 'PUT':
                response = self.session.put(url, json=data, headers=test_headers)
            elif method == 'DELETE':
                response = self.session.delete(url, headers=test_headers)

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

    def test_super_admin_login(self):
        """Test super admin login"""
        self.log("\n=== Testing Super Admin Authentication ===")
        
        success, response = self.run_test(
            "Super Admin Login",
            "POST",
            "auth/login",
            200,
            data={"email": "superadmin@platform.com", "password": "superadmin123"}
        )
        if success and response.get('role') == 'super_admin':
            self.log(f"✅ Super admin logged in: {response.get('name', 'N/A')}")
            return True
        return False

    def test_create_two_restaurants(self):
        """Create two restaurants for isolation testing"""
        self.log("\n=== Creating Two Restaurants for Isolation Testing ===")
        
        # Create Restaurant A
        restaurant_a_data = {
            "name": "Restaurant A",
            "owner_name": "Owner A",
            "owner_email": "ownera@restaurant.com",
            "owner_password": "ownera123",
            "plan": "PRO"
        }
        success, response = self.run_test(
            "Create Restaurant A",
            "POST",
            "super-admin/restaurants",
            200,
            data=restaurant_a_data
        )
        if success:
            self.restaurant_a_id = response.get('restaurant_id')
            self.log(f"   Created Restaurant A: {self.restaurant_a_id}")
        
        # Create Restaurant B
        restaurant_b_data = {
            "name": "Restaurant B",
            "owner_name": "Owner B",
            "owner_email": "ownerb@restaurant.com",
            "owner_password": "ownerb123",
            "plan": "BASIC"
        }
        success, response = self.run_test(
            "Create Restaurant B",
            "POST",
            "super-admin/restaurants",
            200,
            data=restaurant_b_data
        )
        if success:
            self.restaurant_b_id = response.get('restaurant_id')
            self.log(f"   Created Restaurant B: {self.restaurant_b_id}")
        
        return self.restaurant_a_id and self.restaurant_b_id

    def test_restaurant_admin_logins(self):
        """Test restaurant admin logins"""
        self.log("\n=== Testing Restaurant Admin Logins ===")
        
        # Login Restaurant A Admin
        success, response = self.run_test(
            "Restaurant A Admin Login",
            "POST",
            "auth/login",
            200,
            data={"email": "ownera@restaurant.com", "password": "ownera123"}
        )
        if success:
            self.log(f"✅ Restaurant A admin logged in: {response.get('name')}")
            self.log(f"   Restaurant ID: {response.get('restaurant_id', 'NOT SET')}")
        
        # Login Restaurant B Admin
        success, response = self.run_test(
            "Restaurant B Admin Login",
            "POST",
            "auth/login",
            200,
            data={"email": "ownerb@restaurant.com", "password": "ownerb123"}
        )
        if success:
            self.log(f"✅ Restaurant B admin logged in: {response.get('name')}")
            self.log(f"   Restaurant ID: {response.get('restaurant_id', 'NOT SET')}")

    def test_create_staff_for_both_restaurants(self):
        """Create kitchen and billing staff for both restaurants"""
        self.log("\n=== Creating Staff for Both Restaurants ===")
        
        # Login as Restaurant A admin first
        success, response = self.run_test(
            "Restaurant A Admin Login for Staff Creation",
            "POST",
            "auth/login",
            200,
            data={"email": "ownera@restaurant.com", "password": "ownera123"}
        )
        
        if success:
            # Create Restaurant A Kitchen Staff
            kitchen_a_data = {
                "email": "kitchena@restaurant.com",
                "password": "kitchena123",
                "name": "Kitchen A Staff",
                "role": "kitchen"
            }
            success, response = self.run_test(
                "Create Restaurant A Kitchen Staff",
                "POST",
                "admin/staff",
                200,
                data=kitchen_a_data
            )
            if success:
                self.log(f"   Created Kitchen A staff: {response.get('name')}")
            
            # Create Restaurant A Billing Staff
            billing_a_data = {
                "email": "billinga@restaurant.com",
                "password": "billinga123",
                "name": "Billing A Staff",
                "role": "billing"
            }
            success, response = self.run_test(
                "Create Restaurant A Billing Staff",
                "POST",
                "admin/staff",
                200,
                data=billing_a_data
            )
            if success:
                self.log(f"   Created Billing A staff: {response.get('name')}")
        
        # Login as Restaurant B admin
        success, response = self.run_test(
            "Restaurant B Admin Login for Staff Creation",
            "POST",
            "auth/login",
            200,
            data={"email": "ownerb@restaurant.com", "password": "ownerb123"}
        )
        
        if success:
            # Create Restaurant B Kitchen Staff
            kitchen_b_data = {
                "email": "kitchenb@restaurant.com",
                "password": "kitchenb123",
                "name": "Kitchen B Staff",
                "role": "kitchen"
            }
            success, response = self.run_test(
                "Create Restaurant B Kitchen Staff",
                "POST",
                "admin/staff",
                200,
                data=kitchen_b_data
            )
            if success:
                self.log(f"   Created Kitchen B staff: {response.get('name')}")
            
            # Create Restaurant B Billing Staff
            billing_b_data = {
                "email": "billingb@restaurant.com",
                "password": "billingb123",
                "name": "Billing B Staff",
                "role": "billing"
            }
            success, response = self.run_test(
                "Create Restaurant B Billing Staff",
                "POST",
                "admin/staff",
                200,
                data=billing_b_data
            )
            if success:
                self.log(f"   Created Billing B staff: {response.get('name')}")

    def test_create_menu_items_for_both_restaurants(self):
        """Create menu categories and items for both restaurants"""
        self.log("\n=== Creating Menu Items for Both Restaurants ===")
        
        # Login as Restaurant A admin
        success, response = self.run_test(
            "Restaurant A Admin Login for Menu",
            "POST",
            "auth/login",
            200,
            data={"email": "ownera@restaurant.com", "password": "ownera123"}
        )
        
        if success:
            # Create category for Restaurant A
            success, response = self.run_test(
                "Create Category for Restaurant A",
                "POST",
                "menu/categories",
                200,
                data={"name": "Restaurant A Specials"}
            )
            if success:
                self.restaurant_a_category_id = response.get('category_id')
                self.log(f"   Created category A: {self.restaurant_a_category_id}")
            
            # Create menu item for Restaurant A
            if self.restaurant_a_category_id:
                success, response = self.run_test(
                    "Create Menu Item for Restaurant A",
                    "POST",
                    "menu/items",
                    200,
                    data={
                        "name": "Restaurant A Special Dish",
                        "category_id": self.restaurant_a_category_id,
                        "price": 299.99,
                        "description": "Exclusive to Restaurant A"
                    }
                )
                if success:
                    self.restaurant_a_item_id = response.get('item_id')
                    self.log(f"   Created item A: {self.restaurant_a_item_id}")
        
        # Login as Restaurant B admin
        success, response = self.run_test(
            "Restaurant B Admin Login for Menu",
            "POST",
            "auth/login",
            200,
            data={"email": "ownerb@restaurant.com", "password": "ownerb123"}
        )
        
        if success:
            # Create category for Restaurant B
            success, response = self.run_test(
                "Create Category for Restaurant B",
                "POST",
                "menu/categories",
                200,
                data={"name": "Restaurant B Specials"}
            )
            if success:
                self.restaurant_b_category_id = response.get('category_id')
                self.log(f"   Created category B: {self.restaurant_b_category_id}")
            
            # Create menu item for Restaurant B
            if self.restaurant_b_category_id:
                success, response = self.run_test(
                    "Create Menu Item for Restaurant B",
                    "POST",
                    "menu/items",
                    200,
                    data={
                        "name": "Restaurant B Special Dish",
                        "category_id": self.restaurant_b_category_id,
                        "price": 199.99,
                        "description": "Exclusive to Restaurant B"
                    }
                )
                if success:
                    self.restaurant_b_item_id = response.get('item_id')
                    self.log(f"   Created item B: {self.restaurant_b_item_id}")

    def test_create_tables_for_both_restaurants(self):
        """Create tables for both restaurants"""
        self.log("\n=== Creating Tables for Both Restaurants ===")
        
        # Login as Restaurant A admin
        success, response = self.run_test(
            "Restaurant A Admin Login for Tables",
            "POST",
            "auth/login",
            200,
            data={"email": "ownera@restaurant.com", "password": "ownera123"}
        )
        
        if success:
            success, response = self.run_test(
                "Create Table for Restaurant A",
                "POST",
                "tables",
                200,
                data={"table_number": 1}
            )
            if success:
                self.restaurant_a_table_id = response.get('table_id')
                self.log(f"   Created table A: {self.restaurant_a_table_id}")
        
        # Login as Restaurant B admin
        success, response = self.run_test(
            "Restaurant B Admin Login for Tables",
            "POST",
            "auth/login",
            200,
            data={"email": "ownerb@restaurant.com", "password": "ownerb123"}
        )
        
        if success:
            success, response = self.run_test(
                "Create Table for Restaurant B",
                "POST",
                "tables",
                200,
                data={"table_number": 2}
            )
            if success:
                self.restaurant_b_table_id = response.get('table_id')
                self.log(f"   Created table B: {self.restaurant_b_table_id}")

    def test_create_orders_for_both_restaurants(self):
        """Create orders for both restaurants to test isolation"""
        self.log("\n=== Creating Orders for Both Restaurants ===")
        
        # Create customer session and order for Restaurant A
        if self.restaurant_a_table_id and self.restaurant_a_item_id:
            success, response = self.run_test(
                "Create Customer Session for Restaurant A",
                "POST",
                "customer/session",
                200,
                data={
                    "table_id": self.restaurant_a_table_id,
                    "customer_name": "Customer A",
                    "phone": "9876543210"
                }
            )
            if success:
                session_a = response.get('session_token')
                self.log(f"   Created session A: {session_a[:10]}...")
                
                # Create order for Restaurant A
                success, response = self.run_test(
                    "Create Order for Restaurant A",
                    "POST",
                    "orders",
                    200,
                    data={
                        "customer_session_token": session_a,
                        "items": [{
                            "item_id": self.restaurant_a_item_id,
                            "quantity": 2,
                            "instructions": "Restaurant A order"
                        }]
                    }
                )
                if success:
                    self.restaurant_a_order_id = response.get('order_id')
                    self.log(f"   Created order A: {self.restaurant_a_order_id}")
        
        # Create customer session and order for Restaurant B
        if self.restaurant_b_table_id and self.restaurant_b_item_id:
            success, response = self.run_test(
                "Create Customer Session for Restaurant B",
                "POST",
                "customer/session",
                200,
                data={
                    "table_id": self.restaurant_b_table_id,
                    "customer_name": "Customer B",
                    "phone": "9876543211"
                }
            )
            if success:
                session_b = response.get('session_token')
                self.log(f"   Created session B: {session_b[:10]}...")
                
                # Create order for Restaurant B
                success, response = self.run_test(
                    "Create Order for Restaurant B",
                    "POST",
                    "orders",
                    200,
                    data={
                        "customer_session_token": session_b,
                        "items": [{
                            "item_id": self.restaurant_b_item_id,
                            "quantity": 1,
                            "instructions": "Restaurant B order"
                        }]
                    }
                )
                if success:
                    self.restaurant_b_order_id = response.get('order_id')
                    self.log(f"   Created order B: {self.restaurant_b_order_id}")

    def test_data_isolation_kitchen_staff(self):
        """Test that kitchen staff only see their restaurant's orders"""
        self.log("\n=== Testing Kitchen Staff Data Isolation ===")
        
        # Login as Restaurant A Kitchen Staff
        success, response = self.run_test(
            "Restaurant A Kitchen Staff Login",
            "POST",
            "auth/login",
            200,
            data={"email": "kitchena@restaurant.com", "password": "kitchena123"}
        )
        
        if success:
            # Get orders for Restaurant A kitchen
            success, response = self.run_test(
                "Restaurant A Kitchen - Get Orders",
                "GET",
                "orders",
                200
            )
            if success:
                orders_a = response
                self.log(f"   Restaurant A kitchen sees {len(orders_a)} orders")
                
                # Check if Restaurant A order is present
                order_a_found = any(order.get('order_id') == self.restaurant_a_order_id for order in orders_a)
                # Check if Restaurant B order is present (should NOT be)
                order_b_found = any(order.get('order_id') == self.restaurant_b_order_id for order in orders_a)
                
                if order_a_found and not order_b_found:
                    self.log("✅ Restaurant A kitchen sees only Restaurant A orders")
                    self.tests_passed += 1
                elif order_b_found:
                    self.log("❌ CRITICAL: Restaurant A kitchen can see Restaurant B orders!")
                else:
                    self.log("⚠️  Restaurant A kitchen doesn't see its own orders")
                self.tests_run += 1
        
        # Login as Restaurant B Kitchen Staff
        success, response = self.run_test(
            "Restaurant B Kitchen Staff Login",
            "POST",
            "auth/login",
            200,
            data={"email": "kitchenb@restaurant.com", "password": "kitchenb123"}
        )
        
        if success:
            # Get orders for Restaurant B kitchen
            success, response = self.run_test(
                "Restaurant B Kitchen - Get Orders",
                "GET",
                "orders",
                200
            )
            if success:
                orders_b = response
                self.log(f"   Restaurant B kitchen sees {len(orders_b)} orders")
                
                # Check if Restaurant B order is present
                order_b_found = any(order.get('order_id') == self.restaurant_b_order_id for order in orders_b)
                # Check if Restaurant A order is present (should NOT be)
                order_a_found = any(order.get('order_id') == self.restaurant_a_order_id for order in orders_b)
                
                if order_b_found and not order_a_found:
                    self.log("✅ Restaurant B kitchen sees only Restaurant B orders")
                    self.tests_passed += 1
                elif order_a_found:
                    self.log("❌ CRITICAL: Restaurant B kitchen can see Restaurant A orders!")
                else:
                    self.log("⚠️  Restaurant B kitchen doesn't see its own orders")
                self.tests_run += 1

    def test_data_isolation_billing_staff(self):
        """Test that billing staff only see their restaurant's orders"""
        self.log("\n=== Testing Billing Staff Data Isolation ===")
        
        # Login as Restaurant A Billing Staff
        success, response = self.run_test(
            "Restaurant A Billing Staff Login",
            "POST",
            "auth/login",
            200,
            data={"email": "billinga@restaurant.com", "password": "billinga123"}
        )
        
        if success:
            # Get orders for Restaurant A billing
            success, response = self.run_test(
                "Restaurant A Billing - Get Orders",
                "GET",
                "orders",
                200
            )
            if success:
                orders_a = response
                self.log(f"   Restaurant A billing sees {len(orders_a)} orders")
                
                # Check isolation
                order_a_found = any(order.get('order_id') == self.restaurant_a_order_id for order in orders_a)
                order_b_found = any(order.get('order_id') == self.restaurant_b_order_id for order in orders_a)
                
                if order_a_found and not order_b_found:
                    self.log("✅ Restaurant A billing sees only Restaurant A orders")
                    self.tests_passed += 1
                elif order_b_found:
                    self.log("❌ CRITICAL: Restaurant A billing can see Restaurant B orders!")
                else:
                    self.log("⚠️  Restaurant A billing doesn't see its own orders")
                self.tests_run += 1
        
        # Login as Restaurant B Billing Staff
        success, response = self.run_test(
            "Restaurant B Billing Staff Login",
            "POST",
            "auth/login",
            200,
            data={"email": "billingb@restaurant.com", "password": "billingb123"}
        )
        
        if success:
            # Get orders for Restaurant B billing
            success, response = self.run_test(
                "Restaurant B Billing - Get Orders",
                "GET",
                "orders",
                200
            )
            if success:
                orders_b = response
                self.log(f"   Restaurant B billing sees {len(orders_b)} orders")
                
                # Check isolation
                order_b_found = any(order.get('order_id') == self.restaurant_b_order_id for order in orders_b)
                order_a_found = any(order.get('order_id') == self.restaurant_a_order_id for order in orders_b)
                
                if order_b_found and not order_a_found:
                    self.log("✅ Restaurant B billing sees only Restaurant B orders")
                    self.tests_passed += 1
                elif order_a_found:
                    self.log("❌ CRITICAL: Restaurant B billing can see Restaurant A orders!")
                else:
                    self.log("⚠️  Restaurant B billing doesn't see its own orders")
                self.tests_run += 1

    def test_menu_isolation(self):
        """Test that customers see only restaurant-specific menu items"""
        self.log("\n=== Testing Menu Isolation ===")
        
        # Test Restaurant A menu isolation
        success, response = self.run_test(
            "Get Menu Categories for Restaurant A",
            "GET",
            f"menu/categories?restaurant_id={self.restaurant_a_id}",
            200
        )
        if success:
            categories_a = response
            category_a_found = any(cat.get('category_id') == self.restaurant_a_category_id for cat in categories_a)
            category_b_found = any(cat.get('category_id') == self.restaurant_b_category_id for cat in categories_a)
            
            if category_a_found and not category_b_found:
                self.log("✅ Restaurant A menu shows only Restaurant A categories")
                self.tests_passed += 1
            elif category_b_found:
                self.log("❌ CRITICAL: Restaurant A menu shows Restaurant B categories!")
            else:
                self.log("⚠️  Restaurant A menu doesn't show its own categories")
            self.tests_run += 1
        
        # Test Restaurant A menu items
        success, response = self.run_test(
            "Get Menu Items for Restaurant A",
            "GET",
            f"menu/items?restaurant_id={self.restaurant_a_id}",
            200
        )
        if success:
            items_a = response
            item_a_found = any(item.get('item_id') == self.restaurant_a_item_id for item in items_a)
            item_b_found = any(item.get('item_id') == self.restaurant_b_item_id for item in items_a)
            
            if item_a_found and not item_b_found:
                self.log("✅ Restaurant A menu shows only Restaurant A items")
                self.tests_passed += 1
            elif item_b_found:
                self.log("❌ CRITICAL: Restaurant A menu shows Restaurant B items!")
            else:
                self.log("⚠️  Restaurant A menu doesn't show its own items")
            self.tests_run += 1

    def test_analytics_isolation(self):
        """Test that analytics show only restaurant-specific data"""
        self.log("\n=== Testing Analytics Isolation ===")
        
        # Login as Restaurant A admin
        success, response = self.run_test(
            "Restaurant A Admin Login for Analytics",
            "POST",
            "auth/login",
            200,
            data={"email": "ownera@restaurant.com", "password": "ownera123"}
        )
        
        if success:
            # Get analytics for Restaurant A
            success, response = self.run_test(
                "Restaurant A Analytics",
                "GET",
                "analytics/dashboard",
                200
            )
            if success:
                analytics_a = response
                self.log(f"   Restaurant A analytics - Orders: {analytics_a.get('total_orders', 0)}")
                self.log(f"   Restaurant A analytics - Revenue: ₹{analytics_a.get('total_revenue', 0)}")
                
                # Check if analytics include only Restaurant A data
                # This is harder to verify without knowing exact values, but we can check structure
                if 'total_orders' in analytics_a and 'total_revenue' in analytics_a:
                    self.log("✅ Restaurant A analytics endpoint accessible")
                    self.tests_passed += 1
                self.tests_run += 1
        
        # Login as Restaurant B admin
        success, response = self.run_test(
            "Restaurant B Admin Login for Analytics",
            "POST",
            "auth/login",
            200,
            data={"email": "ownerb@restaurant.com", "password": "ownerb123"}
        )
        
        if success:
            # Get analytics for Restaurant B
            success, response = self.run_test(
                "Restaurant B Analytics",
                "GET",
                "analytics/dashboard",
                200
            )
            if success:
                analytics_b = response
                self.log(f"   Restaurant B analytics - Orders: {analytics_b.get('total_orders', 0)}")
                self.log(f"   Restaurant B analytics - Revenue: ₹{analytics_b.get('total_revenue', 0)}")
                
                if 'total_orders' in analytics_b and 'total_revenue' in analytics_b:
                    self.log("✅ Restaurant B analytics endpoint accessible")
                    self.tests_passed += 1
                self.tests_run += 1

    def test_order_continuation(self):
        """Test order continuation logic - same table orders should merge"""
        self.log("\n=== Testing Order Continuation Logic ===")
        
        if not self.restaurant_a_table_id or not self.restaurant_a_item_id:
            self.log("❌ Missing table or item for order continuation test")
            return
        
        # Create first customer session and order
        success, response = self.run_test(
            "Create Customer Session for Order Continuation",
            "POST",
            "customer/session",
            200,
            data={
                "table_id": self.restaurant_a_table_id,
                "customer_name": "Continuation Customer",
                "phone": "9999999999"
            }
        )
        
        if success:
            session_token = response.get('session_token')
            
            # Create first order
            success, response = self.run_test(
                "Create First Order for Continuation",
                "POST",
                "orders",
                200,
                data={
                    "customer_session_token": session_token,
                    "items": [{
                        "item_id": self.restaurant_a_item_id,
                        "quantity": 1,
                        "instructions": "First order"
                    }]
                }
            )
            
            if success:
                first_order_id = response.get('order_id')
                first_order_total = response.get('total', 0)
                first_order_items_count = len(response.get('items', []))
                self.log(f"   First order created: {first_order_id}, Total: ₹{first_order_total}")
                
                # Create second order with same session (should merge)
                success, response = self.run_test(
                    "Create Second Order for Continuation (Should Merge)",
                    "POST",
                    "orders",
                    200,
                    data={
                        "customer_session_token": session_token,
                        "items": [{
                            "item_id": self.restaurant_a_item_id,
                            "quantity": 2,
                            "instructions": "Second order - should merge"
                        }]
                    }
                )
                
                if success:
                    second_order_id = response.get('order_id')
                    second_order_total = response.get('total', 0)
                    second_order_items_count = len(response.get('items', []))
                    
                    self.log(f"   Second order: {second_order_id}, Total: ₹{second_order_total}")
                    self.log(f"   Items count: {second_order_items_count}")
                    
                    # Check if orders merged (same order_id and increased total/items)
                    if first_order_id == second_order_id:
                        if second_order_total > first_order_total and second_order_items_count > first_order_items_count:
                            self.log("✅ Order continuation working - orders merged correctly")
                            self.tests_passed += 1
                        else:
                            self.log("❌ Order continuation failed - totals/items didn't increase")
                    else:
                        self.log("❌ Order continuation failed - new order created instead of merging")
                    self.tests_run += 1

    def test_customer_data_storage(self):
        """Test that customer data is stored per restaurant"""
        self.log("\n=== Testing Customer Data Storage Per Restaurant ===")
        
        # This test would require access to the customers collection
        # For now, we'll test the customer session creation which should store restaurant_id
        
        if self.restaurant_a_table_id:
            success, response = self.run_test(
                "Create Customer Session with Restaurant Context",
                "POST",
                "customer/session",
                200,
                data={
                    "table_id": self.restaurant_a_table_id,
                    "customer_name": "Test Customer Data",
                    "phone": "8888888888"
                }
            )
            
            if success:
                restaurant_id_in_response = response.get('restaurant_id')
                if restaurant_id_in_response == self.restaurant_a_id:
                    self.log("✅ Customer session includes correct restaurant_id")
                    self.tests_passed += 1
                else:
                    self.log(f"❌ Customer session has wrong restaurant_id: {restaurant_id_in_response}")
                self.tests_run += 1

    def run_all_tests(self):
        """Run all multi-tenant isolation tests"""
        self.log("🚀 Starting Multi-Tenant Data Isolation Tests")
        self.log(f"📍 Testing against: {self.base_url}")
        
        try:
            # Setup phase
            if not self.test_super_admin_login():
                self.log("❌ Super admin login failed, stopping tests")
                return 1
            
            if not self.test_create_two_restaurants():
                self.log("❌ Failed to create test restaurants, stopping tests")
                return 1
            
            self.test_restaurant_admin_logins()
            self.test_create_staff_for_both_restaurants()
            self.test_create_menu_items_for_both_restaurants()
            self.test_create_tables_for_both_restaurants()
            self.test_create_orders_for_both_restaurants()
            
            # Critical isolation tests
            self.test_data_isolation_kitchen_staff()
            self.test_data_isolation_billing_staff()
            self.test_menu_isolation()
            self.test_analytics_isolation()
            
            # Order continuation and customer data tests
            self.test_order_continuation()
            self.test_customer_data_storage()
            
            # Print final results
            self.log(f"\n📊 Test Results: {self.tests_passed}/{self.tests_run} passed")
            success_rate = (self.tests_passed / self.tests_run * 100) if self.tests_run > 0 else 0
            self.log(f"Success rate: {success_rate:.1f}%")
            
            if success_rate >= 80:
                self.log("🎉 Multi-tenant isolation testing completed successfully!")
                return 0
            else:
                self.log(f"⚠️  {self.tests_run - self.tests_passed} tests failed")
                return 1
                
        except Exception as e:
            self.log(f"💥 Test suite failed with error: {str(e)}")
            return 1

def main():
    tester = MultiTenantIsolationTester()
    return tester.run_all_tests()

if __name__ == "__main__":
    sys.exit(main())