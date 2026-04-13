# Restaurant QR Ordering SaaS Platform - Setup Guide

## 🚀 Initial Platform Setup

### Step 1: Create Super Admin (First Time Only)

The super admin is the platform owner who manages all restaurants.

**Option A: Using the initialization script (Recommended)**

```bash
cd /app/scripts
python3 create_super_admin.py
```

The script will prompt you for:
- Email address
- Password (minimum 8 characters)
- Name

**Option B: Using environment variables (Automatic)**

The super admin is auto-created from `.env` file on first startup:

```env
SUPER_ADMIN_EMAIL="superadmin@platform.com"
SUPER_ADMIN_PASSWORD="superadmin123"
```

⚠️ **IMPORTANT:** Change the default password immediately in production!

### Step 2: Access Super Admin Dashboard

1. Navigate to: `/login`
2. Login with super admin credentials
3. You'll be redirected to: `/super-admin`

---

## 👥 User Hierarchy

```
Super Admin (Platform Owner)
    ↓ Creates
Restaurant Admin (Restaurant Owner)
    ↓ Creates
Kitchen Staff & Billing Counter Staff
```

### Role Capabilities:

**Super Admin**
- ✅ Create restaurants and restaurant admin accounts
- ✅ Manage subscriptions (activate, suspend, extend)
- ✅ View platform-wide analytics
- ✅ Approve/reject restaurant registrations
- ❌ Cannot create kitchen or billing staff directly

**Restaurant Admin**
- ✅ Manage their restaurant (menu, tables, QR codes)
- ✅ Create kitchen and billing staff
- ✅ View restaurant analytics
- ✅ Manage subscription and renewals
- ❌ Cannot access other restaurants
- ❌ Cannot create other admins

**Kitchen Staff**
- ✅ View and manage orders
- ✅ Update order status
- ❌ Cannot create users
- ❌ Cannot access billing or admin features

**Billing Counter Staff**
- ✅ Process payments
- ✅ Generate bills
- ✅ View order history
- ❌ Cannot create users
- ❌ Cannot access kitchen or admin features

---

## 🏢 Creating Restaurants

### Method 1: Super Admin Creates Restaurant

1. Login as super admin
2. Go to **Restaurants** tab
3. Fill in restaurant details:
   - Restaurant name
   - Owner name
   - Owner email
   - Password (for restaurant admin)
   - Subscription plan (BASIC/PRO/PREMIUM)
4. Click **Create Restaurant**
5. Restaurant is **immediately active**

### Method 2: Self-Service Registration (Requires Approval)

1. Navigate to `/restaurant/register`
2. Fill in registration form
3. Submit application
4. **Status: Pending Approval**
5. Super admin reviews and approves
6. Restaurant becomes **active** after approval

---

## 👨‍💼 Creating Staff (Restaurant Admin Only)

1. Login as restaurant admin
2. Go to **Staff** tab in Admin Dashboard
3. Fill in staff details:
   - Name
   - Email
   - Password
   - Role: **Kitchen Staff** or **Billing Counter**
4. Click **Add Staff Member**
5. Staff can immediately login with provided credentials

---

## 💳 Subscription Plans

| Plan | Price | Features |
|------|-------|----------|
| **BASIC** | ₹1,999/month | QR ordering, Menu management, Basic analytics |
| **PRO** | ₹2,599/month | All BASIC + Billing counter + Kitchen dashboard + Advanced analytics |
| **PREMIUM** | ₹3,000/month | All PRO + Priority support + Custom branding + API access |

### Subscription Management

**Super Admin Can:**
- Extend subscriptions manually (+30 days)
- Change subscription plans
- Suspend/activate restaurants

**Restaurant Admin Can:**
- View subscription status
- Renew subscription (mock payment)
- Upgrade/downgrade plans

### Automatic Expiry

- System checks subscriptions **every hour**
- Expired subscriptions are automatically blocked
- Notifications sent: 3 days before, 1 day before, on expiry

---

## 🔐 Security & Access Control

### Authentication Methods

**Public Login:** Username/password only (Google OAuth removed from public access)

**Login Page:** `/login`
- All users (super admin, restaurant admin, staff) use this page
- Redirects based on role after login

### Access Enforcement

All API endpoints check:
1. User authentication (valid session)
2. User role permissions
3. Restaurant subscription status (for non-super-admin users)

**When Subscription Expires:**
- Restaurant admin: Blocked from all operations
- Kitchen staff: Cannot access kitchen dashboard
- Billing staff: Cannot access billing dashboard
- Customers: See "Restaurant unavailable" message

---

## 💰 Currency

All amounts are displayed in **Indian Rupees (₹)**:
- Menu prices
- Order totals
- Bills (with 18% GST)
- Subscription plans
- Analytics (MRR, revenue)

---

## 📊 Platform Analytics (Super Admin)

**Dashboard Metrics:**
- Total Restaurants
- Active Restaurants
- Monthly Recurring Revenue (MRR) in ₹
- Pending Approvals
- Plan Distribution (BASIC/PRO/PREMIUM)

**Example:**
```
Total Restaurants: 6
Active: 5
MRR: ₹12,196
Pending Approval: 1
```

---

## 🔧 Technical Details

### Database Collections

```
users              → All users (super_admin, admin, kitchen, billing)
restaurants        → Restaurant details and subscription status
subscription_logs  → Audit trail of all subscription changes
notifications      → Expiry alerts and system notifications
payments           → Subscription payment tracking
menu_categories    → Menu categories (linked to restaurant_id)
menu_items         → Menu items (linked to restaurant_id)
tables             → Restaurant tables with QR codes
orders             → Customer orders
customer_sessions  → Customer table sessions
```

### Environment Variables

```env
MONGO_URL="mongodb://localhost:27017"
DB_NAME="test_database"
JWT_SECRET="[secure-random-string]"
SUPER_ADMIN_EMAIL="[your-email]"
SUPER_ADMIN_PASSWORD="[secure-password]"
```

---

## 🆘 Common Operations

### Reset Super Admin Password

```bash
cd /app/scripts
python3 create_super_admin.py
# Select "yes" when asked to replace existing super admin
```

### Manually Activate Restaurant

1. Login as super admin
2. Go to Restaurants tab
3. Find the restaurant
4. Click **Activate** button

### Extend Subscription

1. Login as super admin
2. Go to Restaurants tab
3. Click **Extend +30d** on any restaurant

### Create Staff for Restaurant

1. Login as restaurant admin
2. Go to **Staff** tab
3. Fill form and click **Add Staff Member**

---

## ⚠️ Important Notes

1. **Super Admin Credentials:** Store securely, they have full platform access
2. **Subscription Enforcement:** Automatic and cannot be bypassed (except by super admin)
3. **Staff Creation:** Only restaurant admins can create kitchen/billing staff
4. **Google OAuth:** Not available for public use (removed from login page)
5. **Currency:** All transactions in ₹ (Indian Rupees)

---

## 📞 Support

For platform issues or questions, contact the super admin or development team.
