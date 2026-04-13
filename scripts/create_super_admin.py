#!/usr/bin/env python3
"""
Super Admin Initialization Script
Run this script ONCE to create the initial super admin account for the platform.
"""

import asyncio
import os
import sys
from motor.motor_asyncio import AsyncIOMotorClient
from datetime import datetime, timezone
import getpass

# Add backend to path
sys.path.insert(0, '/app/backend')
from auth import hash_password

async def create_super_admin():
    """Interactive super admin creation"""
    print("=" * 60)
    print("SUPER ADMIN INITIALIZATION")
    print("=" * 60)
    print("\nThis script will create the platform super admin account.")
    print("The super admin has full control over the platform and can:")
    print("  - Create and manage restaurants")
    print("  - Manage subscriptions")
    print("  - View platform-wide analytics")
    print("\n⚠️  WARNING: Keep these credentials secure!\n")
    
    # Get credentials
    email = input("Enter super admin email: ").strip()
    if not email or '@' not in email:
        print("❌ Invalid email address")
        return
    
    password = getpass.getpass("Enter super admin password (min 8 characters): ")
    if len(password) < 8:
        print("❌ Password must be at least 8 characters")
        return
    
    password_confirm = getpass.getpass("Confirm password: ")
    if password != password_confirm:
        print("❌ Passwords do not match")
        return
    
    name = input("Enter super admin name: ").strip() or "Super Admin"
    
    # Connect to database
    mongo_url = os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
    db_name = os.environ.get('DB_NAME', 'test_database')
    
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    
    # Check if super admin already exists
    existing = await db.users.find_one({"role": "super_admin"})
    if existing:
        print(f"\n⚠️  A super admin already exists: {existing['email']}")
        overwrite = input("Do you want to replace it? (yes/no): ").lower()
        if overwrite != 'yes':
            print("❌ Cancelled")
            client.close()
            return
        
        # Delete existing super admin
        await db.users.delete_one({"role": "super_admin"})
        print("✓ Removed existing super admin")
    
    # Create new super admin
    hashed = hash_password(password)
    user_doc = {
        "email": email.lower(),
        "password_hash": hashed,
        "name": name,
        "role": "super_admin",
        "created_at": datetime.now(timezone.utc)
    }
    
    await db.users.insert_one(user_doc)
    
    print("\n" + "=" * 60)
    print("✅ SUPER ADMIN CREATED SUCCESSFULLY!")
    print("=" * 60)
    print(f"\nEmail: {email}")
    print(f"Name: {name}")
    print(f"\n🔒 Please save these credentials in a secure location!")
    print(f"\nYou can now login at: /super-admin")
    print("=" * 60)
    
    # Update .env file
    env_path = '/app/backend/.env'
    try:
        with open(env_path, 'r') as f:
            lines = f.readlines()
        
        # Update or add super admin credentials
        updated = False
        for i, line in enumerate(lines):
            if line.startswith('SUPER_ADMIN_EMAIL='):
                lines[i] = f'SUPER_ADMIN_EMAIL="{email}"\n'
                updated = True
            elif line.startswith('SUPER_ADMIN_PASSWORD='):
                lines[i] = f'SUPER_ADMIN_PASSWORD="{password}"\n'
        
        if not updated:
            lines.append(f'\nSUPER_ADMIN_EMAIL="{email}"\n')
            lines.append(f'SUPER_ADMIN_PASSWORD="{password}"\n')
        
        with open(env_path, 'w') as f:
            f.writelines(lines)
        
        print(f"\n✓ Credentials saved to {env_path}")
    except Exception as e:
        print(f"\n⚠️  Could not update .env file: {e}")
    
    client.close()

if __name__ == "__main__":
    try:
        asyncio.run(create_super_admin())
    except KeyboardInterrupt:
        print("\n\n❌ Cancelled by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Error: {e}")
        sys.exit(1)
