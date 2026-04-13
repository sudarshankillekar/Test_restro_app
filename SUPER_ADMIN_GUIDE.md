# Quick Reference - Super Admin Setup

## Current Super Admin Credentials

**Default super admin is already created:**

```
Email: superadmin@platform.com
Password: superadmin123
Role: super_admin
```

⚠️ **SECURITY WARNING:** Change this password in production!

---

## How to Create/Reset Super Admin

### Interactive Method

```bash
cd /app/scripts
python3 create_super_admin.py
```

Follow the prompts to:
1. Enter email
2. Enter password (min 8 chars)
3. Confirm password
4. Enter name
5. Confirm to replace existing (if any)

### Manual Method (via MongoDB)

```bash
cd /app && mongosh --quiet
use test_database

// Check existing super admin
db.users.findOne({role: "super_admin"})

// Delete existing (if replacing)
db.users.deleteOne({role: "super_admin"})

// Create new super admin using backend script
exit
```

Then run the Python script above.

---

## Verification

Test super admin login:

```bash
curl -X POST "https://resto-flow-24.preview.emergentagent.com/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"superadmin@platform.com","password":"superadmin123"}'
```

Should return:
```json
{
  "email": "superadmin@platform.com",
  "name": "Super Admin",
  "role": "super_admin"
}
```

---

## Access Super Admin Dashboard

1. Navigate to: **https://resto-flow-24.preview.emergentagent.com/login**
2. Enter super admin email and password
3. Click **Sign In**
4. You'll be redirected to: **/super-admin**

---

## Key Changes Made

✅ **Removed Google OAuth from public login** - Only username/password authentication
✅ **Created super admin initialization script** - Located at `/app/scripts/create_super_admin.py`
✅ **Auto-seeding from .env** - Super admin created automatically on startup
✅ **Role hierarchy enforced** - Super admin → Restaurant admin → Staff
✅ **All currency in ₹** - Rupees displayed throughout the platform

---

## What Super Admin Can Do

1. **Create Restaurants** - With restaurant admin credentials
2. **Approve Registrations** - From self-service signups
3. **Manage Subscriptions** - Activate, suspend, extend
4. **View Analytics** - Platform-wide MRR, revenue, restaurant count
5. **Manual Overrides** - Extend subscriptions, change plans

## What Super Admin CANNOT Do

❌ Create kitchen or billing staff directly
❌ Access individual restaurant operations
❌ Modify menu items for restaurants

---

## Login Flow

**Everyone uses `/login` page:**

- **Super Admin** → Redirected to `/super-admin`
- **Restaurant Admin** → Redirected to `/admin`
- **Kitchen Staff** → Redirected to `/kitchen`
- **Billing Staff** → Redirected to `/billing`

**No Google OAuth button visible** - Username/password only!
