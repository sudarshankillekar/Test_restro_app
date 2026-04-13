import asyncio
import os
from motor.motor_asyncio import AsyncIOMotorClient
from datetime import datetime, timezone
import secrets

async def seed_database():
    # Connect to MongoDB
    mongo_url = "mongodb://localhost:27017"
    client = AsyncIOMotorClient(mongo_url)
    db = client["test_database"]
    
    print("Starting database seeding...")
    
    # Seed Categories
    categories = [
        {"category_id": "cat_starters", "name": "Starters", "order": 0, "created_at": datetime.now(timezone.utc)},
        {"category_id": "cat_mains", "name": "Main Course", "order": 1, "created_at": datetime.now(timezone.utc)},
        {"category_id": "cat_desserts", "name": "Desserts", "order": 2, "created_at": datetime.now(timezone.utc)},
        {"category_id": "cat_beverages", "name": "Beverages", "order": 3, "created_at": datetime.now(timezone.utc)},
    ]
    
    existing_cats = await db.menu_categories.count_documents({})
    if existing_cats == 0:
        await db.menu_categories.insert_many(categories)
        print(f"✓ Created {len(categories)} categories")
    else:
        print(f"✓ Categories already exist ({existing_cats} found)")
    
    # Seed Menu Items
    menu_items = [
        {
            "item_id": f"item_{secrets.token_hex(8)}",
            "name": "Crispy Spring Rolls",
            "category_id": "cat_starters",
            "price": 180.0,
            "description": "Golden fried vegetable spring rolls with sweet chili sauce",
            "image": "https://images.unsplash.com/photo-1611309454921-16cef3438ee0?w=500",
            "available": True,
            "created_at": datetime.now(timezone.utc)
        },
        {
            "item_id": f"item_{secrets.token_hex(8)}",
            "name": "Paneer Tikka",
            "category_id": "cat_starters",
            "price": 220.0,
            "description": "Grilled cottage cheese marinated in spices",
            "image": "https://images.unsplash.com/photo-1567188040759-fb8a883dc6d8?w=500",
            "available": True,
            "created_at": datetime.now(timezone.utc)
        },
        {
            "item_id": f"item_{secrets.token_hex(8)}",
            "name": "Margherita Pizza",
            "category_id": "cat_mains",
            "price": 350.0,
            "description": "Fresh mozzarella, tomatoes, and basil on thin crust",
            "image": "https://images.unsplash.com/photo-1622880833523-7cf1c0bd4296?w=500",
            "available": True,
            "created_at": datetime.now(timezone.utc)
        },
        {
            "item_id": f"item_{secrets.token_hex(8)}",
            "name": "Butter Chicken",
            "category_id": "cat_mains",
            "price": 380.0,
            "description": "Tender chicken in rich tomato cream sauce",
            "image": "https://images.unsplash.com/photo-1603894584373-5ac82b2ae398?w=500",
            "available": True,
            "created_at": datetime.now(timezone.utc)
        },
        {
            "item_id": f"item_{secrets.token_hex(8)}",
            "name": "Veg Biryani",
            "category_id": "cat_mains",
            "price": 280.0,
            "description": "Aromatic basmati rice with mixed vegetables and spices",
            "image": "https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=500",
            "available": True,
            "created_at": datetime.now(timezone.utc)
        },
        {
            "item_id": f"item_{secrets.token_hex(8)}",
            "name": "Chocolate Lava Cake",
            "category_id": "cat_desserts",
            "price": 180.0,
            "description": "Warm chocolate cake with molten center",
            "image": "https://images.unsplash.com/photo-1624353365286-3f8d62daad51?w=500",
            "available": True,
            "created_at": datetime.now(timezone.utc)
        },
        {
            "item_id": f"item_{secrets.token_hex(8)}",
            "name": "Gulab Jamun",
            "category_id": "cat_desserts",
            "price": 120.0,
            "description": "Traditional Indian sweet dumplings in sugar syrup",
            "image": "https://images.unsplash.com/photo-1589996447763-cf857c65cb45?w=500",
            "available": True,
            "created_at": datetime.now(timezone.utc)
        },
        {
            "item_id": f"item_{secrets.token_hex(8)}",
            "name": "Fresh Lime Soda",
            "category_id": "cat_beverages",
            "price": 80.0,
            "description": "Refreshing lime soda with mint",
            "image": "https://images.unsplash.com/photo-1668431456502-a96f8619fd66?w=500",
            "available": True,
            "created_at": datetime.now(timezone.utc)
        },
        {
            "item_id": f"item_{secrets.token_hex(8)}",
            "name": "Mango Lassi",
            "category_id": "cat_beverages",
            "price": 100.0,
            "description": "Creamy yogurt drink with fresh mango",
            "image": "https://images.unsplash.com/photo-1623065422902-30a2d299bbe4?w=500",
            "available": True,
            "created_at": datetime.now(timezone.utc)
        }
    ]
    
    existing_items = await db.menu_items.count_documents({})
    if existing_items == 0:
        await db.menu_items.insert_many(menu_items)
        print(f"✓ Created {len(menu_items)} menu items")
    else:
        print(f"✓ Menu items already exist ({existing_items} found)")
    
    # Seed Tables
    frontend_url = os.environ.get('REACT_APP_BACKEND_URL', 'https://resto-flow-24.preview.emergentagent.com')
    tables_data = []
    for table_num in range(1, 11):
        table_id = f"table_{secrets.token_hex(6)}"
        tables_data.append({
            "table_id": table_id,
            "table_number": table_num,
            "status": "available",
            "qr_code": f"{frontend_url}/customer/{table_id}",
            "created_at": datetime.now(timezone.utc)
        })
    
    existing_tables = await db.tables.count_documents({})
    if existing_tables == 0:
        await db.tables.insert_many(tables_data)
        print(f"✓ Created {len(tables_data)} tables")
    else:
        print(f"✓ Tables already exist ({existing_tables} found)")
    
    # Create staff users
    from auth import hash_password
    
    staff_users = [
        {
            "email": "kitchen@restaurant.com",
            "password_hash": hash_password("kitchen123"),
            "name": "Kitchen Staff",
            "role": "kitchen",
            "created_at": datetime.now(timezone.utc)
        },
        {
            "email": "billing@restaurant.com",
            "password_hash": hash_password("billing123"),
            "name": "Billing Counter",
            "role": "billing",
            "created_at": datetime.now(timezone.utc)
        }
    ]
    
    for staff in staff_users:
        existing = await db.users.find_one({"email": staff["email"]})
        if not existing:
            await db.users.insert_one(staff)
            print(f"✓ Created staff user: {staff['email']}")
    
    print("\n✅ Database seeding complete!")
    print("\n📝 Test Credentials:")
    print("  Admin: admin@restaurant.com / admin123")
    print("  Kitchen: kitchen@restaurant.com / kitchen123")
    print("  Billing: billing@restaurant.com / billing123")
    
    client.close()

if __name__ == "__main__":
    import sys
    sys.path.insert(0, '/app/backend')
    asyncio.run(seed_database())
