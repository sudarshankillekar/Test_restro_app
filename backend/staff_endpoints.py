# ============ Staff Management (Restaurant Admin) ============

@api_router.post("/admin/staff")
async def create_staff(input: RegisterRequest, request: Request):
    """Restaurant admin creates kitchen/billing staff"""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin"]:
        raise HTTPException(status_code=403, detail="Restaurant admin access required")
    
    # Get and verify restaurant
    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")
    
    await check_restaurant_subscription(db, restaurant_id)
    
    # Validate role - admin can only create kitchen and billing
    if input.role not in ["kitchen", "billing"]:
        raise HTTPException(status_code=400, detail="Can only create kitchen or billing staff")
    
    # Check if email exists
    email = input.email.lower()
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    # Create staff user
    hashed = hash_password(input.password)
    user_doc = {
        "email": email,
        "password_hash": hashed,
        "name": input.name,
        "role": input.role,
        "restaurant_id": restaurant_id,
        "created_at": datetime.now(timezone.utc),
        "created_by": user["_id"]
    }
    await db.users.insert_one(user_doc)
    
    return {"email": email, "name": input.name, "role": input.role}

@api_router.get("/admin/staff")
async def get_staff(request: Request):
    """Restaurant admin views their staff"""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin"]:
        raise HTTPException(status_code=403, detail="Restaurant admin access required")
    
    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")
    
    await check_restaurant_subscription(db, restaurant_id)
    
    # Get all staff for this restaurant
    staff = await db.users.find(
        {"restaurant_id": restaurant_id, "role": {"$in": ["kitchen", "billing"]}},
        {"_id": 0, "password_hash": 0}
    ).to_list(1000)
    
    return staff

@api_router.delete("/admin/staff/{email}")
async def delete_staff(email: str, request: Request):
    """Restaurant admin deletes staff member"""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin"]:
        raise HTTPException(status_code=403, detail="Restaurant admin access required")
    
    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")
    
    await check_restaurant_subscription(db, restaurant_id)
    
    # Delete staff (only kitchen/billing)
    result = await db.users.delete_one({
        "email": email.lower(),
        "restaurant_id": restaurant_id,
        "role": {"$in": ["kitchen", "billing"]}
    })
    
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Staff member not found")
    
    return {"message": "Staff member deleted successfully"}
