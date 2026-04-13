import asyncio
import os
from motor.motor_asyncio import AsyncIOMotorClient
from datetime import datetime, timezone, timedelta
import secrets

async def migrate_to_multitenant():
    """Migrate existing single-tenant data to multi-tenant structure"""
    mongo_url = "mongodb://localhost:27017"
    client = AsyncIOMotorClient(mongo_url)
    db = client["test_database"]
    
    print("Starting multi-tenant migration...")
    
    # Create default restaurant for existing data
    default_restaurant_id = "rest_default_001"
    
    existing_rest = await db.restaurants.find_one({"restaurant_id": default_restaurant_id})
    
    if not existing_rest:
        restaurant_doc = {
            "restaurant_id": default_restaurant_id,
            "name": "Demo Restaurant",
            "owner_email": "admin@restaurant.com",
            "status": "ACTIVE",
            "plan": "PREMIUM",
            "subscriptionStart": datetime.now(timezone.utc),
            "subscriptionEnd": datetime.now(timezone.utc) + timedelta(days=365),  # 1 year trial
            "paymentStatus": "PAID",
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
            "approval_pending": False
        }
        await db.restaurants.insert_one(restaurant_doc)
        print(f"✓ Created default restaurant: {default_restaurant_id}")
    
    # Update existing users to link to default restaurant
    await db.users.update_many(
        {"restaurant_id": {"$exists": False}, "role": {"$ne": "super_admin"}},
        {"$set": {"restaurant_id": default_restaurant_id}}
    )
    print("✓ Linked existing users to default restaurant")
    
    # Update existing menu categories
    await db.menu_categories.update_many(
        {"restaurant_id": {"$exists": False}},
        {"$set": {"restaurant_id": default_restaurant_id}}
    )
    print("✓ Linked menu categories to default restaurant")
    
    # Update existing menu items
    await db.menu_items.update_many(
        {"restaurant_id": {"$exists": False}},
        {"$set": {"restaurant_id": default_restaurant_id}}
    )
    print("✓ Linked menu items to default restaurant")
    
    # Update existing tables
    await db.tables.update_many(
        {"restaurant_id": {"$exists": False}},
        {"$set": {"restaurant_id": default_restaurant_id}}
    )
    print("✓ Linked tables to default restaurant")
    
    # Update existing orders
    await db.orders.update_many(
        {"restaurant_id": {"$exists": False}},
        {"$set": {"restaurant_id": default_restaurant_id}}
    )
    print("✓ Linked orders to default restaurant")
    
    print("\n✅ Migration complete!")
    print(f"Default restaurant ID: {default_restaurant_id}")
    print(f"All existing data has been migrated to multi-tenant structure")
    
    client.close()

if __name__ == "__main__":
    asyncio.run(migrate_to_multitenant())
