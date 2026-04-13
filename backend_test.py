#!/usr/bin/env python3

import requests
import sys
import json
from datetime import datetime
import time

class SaaSPlatformTester:
    def __init__(self, base_url="https://resto-flow-24.preview.emergentagent.com"):
        self.base_url = base_url
        self.session = requests.Session()
        self.tests_run = 0
        self.tests_passed = 0
        self.super_admin_token = None
        self.admin_token = None
        self.kitchen_token = None
        self.billing_token = None
        self.customer_session = None
        self.test_table_id = None
        self.test_order_id = None
        self.test_category_id = None
        self.test_item_id = None
        self.restaurant_id = None

    def log(self, message):
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}")

    def run_test(self, name, method, endpoint, expected_status, data=None, headers=None, cookies=None):
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

    def test_super_admin_analytics(self):
        """Test super admin analytics dashboard"""
        success, response = self.run_test(
            "Super Admin Analytics",
            "GET",
            "super-admin/analytics",
            200
        )
        if success:
            self.log(f"   Total restaurants: {response.get('total_restaurants', 0)}")
            self.log(f"   Active restaurants: {response.get('active_restaurants', 0)}")
            self.log(f"   MRR: ₹{response.get('mrr', 0)}")
            self.log(f"   Pending approval: {response.get('pending_approval', 0)}")
            return True
        return False

    def test_create_restaurant_super_admin(self):
        """Test super admin creating a restaurant"""
        restaurant_data = {
            "name": "Test Restaurant",
            "owner_name": "Test Owner",
            "owner_email": "testowner@restaurant.com",
            "owner_password": "testpass123",
            "plan": "PRO"
        }
        success, response = self.run_test(
            "Super Admin Create Restaurant",
            "POST",
            "super-admin/restaurants",
            200,
            data=restaurant_data
        )
        if success:
            self.restaurant_id = response.get('restaurant_id')
            self.log(f"   Created restaurant: {response.get('name')} (ID: {self.restaurant_id})")
            return True
        return False

    def test_list_restaurants_super_admin(self):
        """Test super admin listing all restaurants"""
        success, response = self.run_test(
            "Super Admin List Restaurants",
            "GET",
            "super-admin/restaurants",
            200
        )
        if success and isinstance(response, list):
            self.log(f"   Found {len(response)} restaurants")
            for rest in response[:3]:  # Show first 3
                self.log(f"   - {rest.get('name')} ({rest.get('status')})")
            return True
        return False

    def test_restaurant_registration(self):
        """Test self-service restaurant registration"""
        self.log("\n=== Testing Restaurant Registration ===")
        
        registration_data = {
            "name": "Self Registered Restaurant",
            "owner_name": "Self Owner",
            "owner_email": "selfowner@restaurant.com",
            "owner_password": "selfpass123",
            "plan": "BASIC"
        }
        success, response = self.run_test(
            "Restaurant Self Registration",
            "POST",
            "restaurants/register",
            200,
            data=registration_data
        )
        if success:
            self.log(f"   Registration submitted: {response.get('restaurant_id')}")
            return True
        return False

    def test_admin_subscription_view(self):
        """Test admin viewing subscription details"""
        success, response = self.run_test(
            "Admin View Subscription",
            "GET",
            "restaurant/subscription",
            200
        )
        if success:
            restaurant = response.get('restaurant', {})
            self.log(f"   Restaurant: {restaurant.get('name', 'N/A')}")
            self.log(f"   Plan: {restaurant.get('plan', 'N/A')}")
            self.log(f"   Status: {restaurant.get('status', 'N/A')}")
            return True
        return False

    def test_staff_management(self):
        """Test staff creation and management"""
        self.log("\n=== Testing Staff Management ===")
        
        # Test creating kitchen staff
        kitchen_staff_data = {
            "email": "testkitchen@restaurant.com",
            "password": "kitchen123",
            "name": "Test Kitchen Staff",
            "role": "kitchen"
        }
        success, response = self.run_test(
            "Admin Create Kitchen Staff",
            "POST",
            "admin/staff",
            200,
            data=kitchen_staff_data
        )
        if success:
            self.log(f"   Created kitchen staff: {response.get('name')}")
        
        # Test creating billing staff
        billing_staff_data = {
            "email": "testbilling@restaurant.com",
            "password": "billing123",
            "name": "Test Billing Staff",
            "role": "billing"
        }
        success, response = self.run_test(
            "Admin Create Billing Staff",
            "POST",
            "admin/staff",
            200,
            data=billing_staff_data
        )
        if success:
            self.log(f"   Created billing staff: {response.get('name')}")
        
        # Test listing staff
        success, response = self.run_test(
            "Admin List Staff",
            "GET",
            "admin/staff",
            200
        )
        if success and isinstance(response, list):
            self.log(f"   Found {len(response)} staff members")
            for staff in response:
                self.log(f"   - {staff.get('name')} ({staff.get('role')})")
            return True
        return False

    def test_subscription_plans(self):
        """Test viewing subscription plans"""
        success, response = self.run_test(
            "View Subscription Plans",
            "GET",
            "subscription/plans",
            200
        )
        if success:
            self.log(f"   Available plans: {list(response.keys())}")
            for plan, details in response.items():
                self.log(f"   - {plan}: ₹{details['price']}/month")
            return True
        return False

    def test_extend_subscription(self):
        """Test super admin extending subscription"""
        if not self.restaurant_id:
            self.log("❌ No restaurant ID available for extension test")
            return False
            
        success, response = self.run_test(
            "Super Admin Extend Subscription",
            "POST",
            f"super-admin/restaurants/{self.restaurant_id}/extend",
            200,
            data={"days": 30}
        )
        if success:
            self.log(f"   Subscription extended: {response.get('message')}")
            return True
        return False

    def test_auth_flows(self):
        """Test authentication for all user types"""
        self.log("\n=== Testing Authentication ===")
        
        # Test admin login
        success, response = self.run_test(
            "Admin Login",
            "POST",
            "auth/login",
            200,
            data={"email": "admin@restaurant.com", "password": "admin123"}
        )
        if success:
            self.log("✅ Admin login successful")
        
        # Test kitchen staff login
        success, response = self.run_test(
            "Kitchen Staff Login",
            "POST",
            "auth/login",
            200,
            data={"email": "kitchen@restaurant.com", "password": "kitchen123"}
        )
        if success:
            self.log("✅ Kitchen staff login successful")
        
        # Test billing staff login
        success, response = self.run_test(
            "Billing Staff Login",
            "POST",
            "auth/login",
            200,
            data={"email": "billing@restaurant.com", "password": "billing123"}
        )
        if success:
            self.log("✅ Billing staff login successful")
        
        # Test invalid credentials
        success, response = self.run_test(
            "Invalid Login",
            "POST",
            "auth/login",
            401,
            data={"email": "invalid@test.com", "password": "wrongpass"}
        )
        if success:
            self.log("✅ Invalid login properly rejected")
        """Test menu categories and items management"""
        self.log("\n=== Testing Menu Management ===")
        
        # Get existing categories
        success, response = self.run_test(
            "Get Categories",
            "GET",
            "menu/categories",
            200
        )
        if success:
            categories = response
            self.log(f"✅ Found {len(categories)} categories")
        
        # Get existing menu items
        success, response = self.run_test(
            "Get Menu Items",
            "GET",
            "menu/items",
            200
        )
        if success:
            items = response
            self.log(f"✅ Found {len(items)} menu items")
            if items:
                self.test_item_id = items[0]['item_id']
        
        # Test creating category (requires admin auth)
        success, response = self.run_test(
            "Create Category (No Auth)",
            "POST",
            "menu/categories",
            401,
            data={"name": "Test Category"}
        )
        if success:
            self.log("✅ Category creation properly requires auth")

    def test_table_management(self):
        """Test table management"""
        self.log("\n=== Testing Table Management ===")
        
        # Get existing tables
        success, response = self.run_test(
            "Get Tables",
            "GET",
            "tables",
            200
        )
        if success:
            tables = response
            self.log(f"✅ Found {len(tables)} tables")
            if tables:
                self.test_table_id = tables[0]['table_id']
                self.log(f"✅ Using table ID: {self.test_table_id}")

    def test_customer_session(self):
        """Test customer session creation"""
        self.log("\n=== Testing Customer Session ===")
        
        if not self.test_table_id:
            self.log("❌ No table ID available for customer session test")
            return
        
        # Create customer session
        success, response = self.run_test(
            "Create Customer Session",
            "POST",
            "customer/session",
            200,
            data={
                "table_id": self.test_table_id,
                "customer_name": "Test Customer",
                "phone": "9876543210"
            }
        )
        if success:
            self.customer_session = response.get('session_token')
            self.log(f"✅ Customer session created: {self.customer_session[:10]}...")
        
        # Verify customer session
        if self.customer_session:
            success, response = self.run_test(
                "Verify Customer Session",
                "GET",
                f"customer/session/{self.customer_session}",
                200
            )
            if success:
                self.log("✅ Customer session verified")

    def test_order_flow(self):
        """Test complete order flow"""
        self.log("\n=== Testing Order Flow ===")
        
        if not self.customer_session or not self.test_item_id:
            self.log("❌ Missing customer session or menu item for order test")
            return
        
        # Create order
        success, response = self.run_test(
            "Create Order",
            "POST",
            "orders",
            200,
            data={
                "customer_session_token": self.customer_session,
                "items": [
                    {
                        "item_id": self.test_item_id,
                        "quantity": 2,
                        "instructions": "Extra spicy"
                    }
                ]
            }
        )
        if success:
            self.test_order_id = response.get('order_id')
            self.log(f"✅ Order created: {self.test_order_id}")
        
        # Get order details
        if self.test_order_id:
            success, response = self.run_test(
                "Get Order Details",
                "GET",
                f"orders/{self.test_order_id}",
                200
            )
            if success:
                self.log("✅ Order details retrieved")
        
        # Test order status update (requires auth)
        if self.test_order_id:
            success, response = self.run_test(
                "Update Order Status (No Auth)",
                "PUT",
                f"orders/{self.test_order_id}/status",
                401,
                data={"status": "accepted"}
            )
            if success:
                self.log("✅ Order status update properly requires auth")

    def test_orders_listing(self):
        """Test orders listing (requires auth)"""
        self.log("\n=== Testing Orders Listing ===")
        
        # Test without auth
        success, response = self.run_test(
            "Get Orders (No Auth)",
            "GET",
            "orders",
            401
        )
        if success:
            self.log("✅ Orders listing properly requires auth")

    def test_analytics(self):
        """Test analytics endpoint (requires admin auth)"""
        self.log("\n=== Testing Analytics ===")
        
        # Test without auth
        success, response = self.run_test(
            "Get Analytics (No Auth)",
            "GET",
            "analytics/dashboard",
            401
        )
        if success:
            self.log("✅ Analytics properly requires admin auth")

    def test_payment_flow(self):
        """Test payment processing (requires auth)"""
        self.log("\n=== Testing Payment Flow ===")
        
        if not self.test_order_id:
            self.log("❌ No order ID available for payment test")
            return
        
        # Test payment creation without auth
        success, response = self.run_test(
            "Create Payment (No Auth)",
            "POST",
            "payments",
            401,
            data={
                "order_id": self.test_order_id,
                "payment_method": "cash",
                "discount": 0
            }
        )
        if success:
            self.log("✅ Payment creation properly requires auth")

    def test_error_handling(self):
        """Test error handling for various scenarios"""
        self.log("\n=== Testing Error Handling ===")
        
        # Test non-existent order
        success, response = self.run_test(
            "Get Non-existent Order",
            "GET",
            "orders/INVALID_ORDER_ID",
            404
        )
        if success:
            self.log("✅ Non-existent order properly returns 404")
        
        # Test invalid customer session
        success, response = self.run_test(
            "Invalid Customer Session",
            "GET",
            "customer/session/invalid_token",
            404
        )
        if success:
            self.log("✅ Invalid customer session properly returns 404")
        
        # Test order with invalid session token
        success, response = self.run_test(
            "Order with Invalid Session",
            "POST",
            "orders",
            401,
            data={
                "customer_session_token": "invalid_token",
                "items": [{"item_id": "test", "quantity": 1}]
            }
        )
        if success:
            self.log("✅ Order with invalid session properly rejected")

    def test_menu_management(self):
        """Test menu categories and items management"""
        self.log("\n=== Testing Menu Management ===")
        
        # Get existing categories
        success, response = self.run_test(
            "Get Categories",
            "GET",
            "menu/categories",
            200
        )
        if success:
            categories = response
            self.log(f"✅ Found {len(categories)} categories")
        
        # Get existing menu items
        success, response = self.run_test(
            "Get Menu Items",
            "GET",
            "menu/items",
            200
        )
        if success:
            items = response
            self.log(f"✅ Found {len(items)} menu items")
            if items:
                self.test_item_id = items[0]['item_id']
        
        # Test creating category (requires admin auth)
        success, response = self.run_test(
            "Create Category (No Auth)",
            "POST",
            "menu/categories",
            401,
            data={"name": "Test Category"}
        )
        if success:
            self.log("✅ Category creation properly requires auth")

    def test_table_management(self):
        """Test table management"""
        self.log("\n=== Testing Table Management ===")
        
        # Get existing tables
        success, response = self.run_test(
            "Get Tables",
            "GET",
            "tables",
            200
        )
        if success:
            tables = response
            self.log(f"✅ Found {len(tables)} tables")
            if tables:
                self.test_table_id = tables[0]['table_id']
                self.log(f"✅ Using table ID: {self.test_table_id}")

    def test_customer_session(self):
        """Test customer session creation"""
        self.log("\n=== Testing Customer Session ===")
        
        if not self.test_table_id:
            self.log("❌ No table ID available for customer session test")
            return
        
        # Create customer session
        success, response = self.run_test(
            "Create Customer Session",
            "POST",
            "customer/session",
            200,
            data={
                "table_id": self.test_table_id,
                "customer_name": "Test Customer",
                "phone": "9876543210"
            }
        )
        if success:
            self.customer_session = response.get('session_token')
            self.log(f"✅ Customer session created: {self.customer_session[:10]}...")
        
        # Verify customer session
        if self.customer_session:
            success, response = self.run_test(
                "Verify Customer Session",
                "GET",
                f"customer/session/{self.customer_session}",
                200
            )
            if success:
                self.log("✅ Customer session verified")

    def test_order_flow(self):
        """Test complete order flow"""
        self.log("\n=== Testing Order Flow ===")
        
        if not self.customer_session or not self.test_item_id:
            self.log("❌ Missing customer session or menu item for order test")
            return
        
        # Create order
        success, response = self.run_test(
            "Create Order",
            "POST",
            "orders",
            200,
            data={
                "customer_session_token": self.customer_session,
                "items": [
                    {
                        "item_id": self.test_item_id,
                        "quantity": 2,
                        "instructions": "Extra spicy"
                    }
                ]
            }
        )
        if success:
            self.test_order_id = response.get('order_id')
            self.log(f"✅ Order created: {self.test_order_id}")
        
        # Get order details
        if self.test_order_id:
            success, response = self.run_test(
                "Get Order Details",
                "GET",
                f"orders/{self.test_order_id}",
                200
            )
            if success:
                self.log("✅ Order details retrieved")
        
        # Test order status update (requires auth)
        if self.test_order_id:
            success, response = self.run_test(
                "Update Order Status (No Auth)",
                "PUT",
                f"orders/{self.test_order_id}/status",
                401,
                data={"status": "accepted"}
            )
            if success:
                self.log("✅ Order status update properly requires auth")

    def test_orders_listing(self):
        """Test orders listing (requires auth)"""
        self.log("\n=== Testing Orders Listing ===")
        
        # Test without auth
        success, response = self.run_test(
            "Get Orders (No Auth)",
            "GET",
            "orders",
            401
        )
        if success:
            self.log("✅ Orders listing properly requires auth")

    def test_analytics(self):
        """Test analytics endpoint (requires admin auth)"""
        self.log("\n=== Testing Analytics ===")
        
        # Test without auth
        success, response = self.run_test(
            "Get Analytics (No Auth)",
            "GET",
            "analytics/dashboard",
            401
        )
        if success:
            self.log("✅ Analytics properly requires admin auth")

    def test_payment_flow(self):
        """Test payment processing (requires auth)"""
        self.log("\n=== Testing Payment Flow ===")
        
        if not self.test_order_id:
            self.log("❌ No order ID available for payment test")
            return
        
        # Test payment creation without auth
        success, response = self.run_test(
            "Create Payment (No Auth)",
            "POST",
            "payments",
            401,
            data={
                "order_id": self.test_order_id,
                "payment_method": "cash",
                "discount": 0
            }
        )
        if success:
            self.log("✅ Payment creation properly requires auth")

    def test_error_handling(self):
        """Test error handling for various scenarios"""
        self.log("\n=== Testing Error Handling ===")
        
        # Test non-existent order
        success, response = self.run_test(
            "Get Non-existent Order",
            "GET",
            "orders/INVALID_ORDER_ID",
            404
        )
        if success:
            self.log("✅ Non-existent order properly returns 404")
        
        # Test invalid customer session
        success, response = self.run_test(
            "Invalid Customer Session",
            "GET",
            "customer/session/invalid_token",
            404
        )
        if success:
            self.log("✅ Invalid customer session properly returns 404")
        
        # Test order with invalid session token
        success, response = self.run_test(
            "Order with Invalid Session",
            "POST",
            "orders",
            401,
            data={
                "customer_session_token": "invalid_token",
                "items": [{"item_id": "test", "quantity": 1}]
            }
        )
        if success:
            self.log("✅ Order with invalid session properly rejected")

    def run_all_tests(self):
        """Run all test suites"""
        self.log("🚀 Starting SaaS Platform Tests")
        self.log(f"📍 Testing against: {self.base_url}")
        
        try:
            # Test Super Admin functionality first
            if not self.test_super_admin_login():
                self.log("❌ Super admin login failed, stopping tests")
                return 1
            
            self.test_super_admin_analytics()
            self.test_create_restaurant_super_admin()
            self.test_list_restaurants_super_admin()
            self.test_extend_subscription()
            
            # Test Restaurant Registration
            self.test_restaurant_registration()
            
            # Test Restaurant Admin functionality
            self.test_auth_flows()
            self.test_admin_subscription_view()
            self.test_staff_management()
            
            # Test General functionality
            self.test_subscription_plans()
            self.test_menu_management()
            self.test_table_management()
            self.test_customer_session()
            self.test_order_flow()
            self.test_orders_listing()
            self.test_analytics()
            self.test_payment_flow()
            self.test_error_handling()
            
            # Print final results
            self.log(f"\n📊 Test Results: {self.tests_passed}/{self.tests_run} passed")
            success_rate = (self.tests_passed / self.tests_run * 100) if self.tests_run > 0 else 0
            self.log(f"Success rate: {success_rate:.1f}%")
            
            if success_rate >= 80:
                self.log("🎉 Backend testing completed successfully!")
                return 0
            else:
                self.log(f"⚠️  {self.tests_run - self.tests_passed} tests failed")
                return 1
                
        except Exception as e:
            self.log(f"💥 Test suite failed with error: {str(e)}")
            return 1

def main():
    tester = SaaSPlatformTester()
    return tester.run_all_tests()

if __name__ == "__main__":
    sys.exit(main())