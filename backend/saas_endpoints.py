# ============ Super Admin & Restaurant Management Endpoints ============

@api_router.post("/super-admin/restaurants")
async def create_restaurant_super(input: RestaurantCreate, request: Request):
    """Super admin creates a new restaurant"""
    user = await get_current_user(request, db)
    if user["role"] != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin access required")
    
    # Check if restaurant email already exists
    existing = await db.users.find_one({"email": input.owner_email.lower()})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    # Create restaurant
    restaurant_id = f"rest_{secrets.token_hex(8)}"
    plan_info = SUBSCRIPTION_PLANS.get(input.plan, SUBSCRIPTION_PLANS["BASIC"])
    
    restaurant_doc = {
        "restaurant_id": restaurant_id,
        "name": input.name,
        "owner_email": input.owner_email.lower(),
        "status": "ACTIVE",
        "plan": input.plan,
        "subscriptionStart": datetime.now(timezone.utc),
        "subscriptionEnd": datetime.now(timezone.utc) + timedelta(days=plan_info["duration_days"]),
        "paymentStatus": "PAID",
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc)
    }
    await db.restaurants.insert_one(restaurant_doc)
    
    # Create owner user account
    hashed = hash_password(input.owner_password)
    user_doc = {
        "email": input.owner_email.lower(),
        "password_hash": hashed,
        "name": input.owner_name,
        "role": "admin",
        "restaurant_id": restaurant_id,
        "created_at": datetime.now(timezone.utc)
    }
    await db.users.insert_one(user_doc)
    
    # Create subscription log
    await create_subscription_log(
        db, restaurant_id, "RESTAURANT_CREATED",
        {"plan": input.plan, "created_by": "super_admin"},
        user["_id"]
    )
    
    return {k: v for k, v in restaurant_doc.items() if k != "_id"}

@api_router.post("/restaurants/register")
async def register_restaurant(input: RestaurantCreate):
    """Self-service restaurant registration (requires super admin approval)"""
    # Check if email already exists
    existing = await db.users.find_one({"email": input.owner_email.lower()})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    # Create restaurant with SUSPENDED status (pending approval)
    restaurant_id = f"rest_{secrets.token_hex(8)}"
    
    restaurant_doc = {
        "restaurant_id": restaurant_id,
        "name": input.name,
        "owner_email": input.owner_email.lower(),
        "status": "SUSPENDED",  # Pending approval
        "plan": input.plan,
        "subscriptionStart": None,
        "subscriptionEnd": None,
        "paymentStatus": "PENDING",
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
        "approval_pending": True
    }
    await db.restaurants.insert_one(restaurant_doc)
    
    # Create owner user account
    hashed = hash_password(input.owner_password)
    user_doc = {
        "email": input.owner_email.lower(),
        "password_hash": hashed,
        "name": input.owner_name,
        "role": "admin",
        "restaurant_id": restaurant_id,
        "created_at": datetime.now(timezone.utc)
    }
    await db.users.insert_one(user_doc)
    
    # Create notification for super admin (would send email in production)
    print(f"[REGISTRATION] New restaurant '{input.name}' pending approval")
    
    return {
        "message": "Restaurant registration submitted. Awaiting super admin approval.",
        "restaurant_id": restaurant_id
    }

@api_router.get("/super-admin/restaurants")
async def list_all_restaurants(request: Request):
    """Super admin views all restaurants"""
    user = await get_current_user(request, db)
    if user["role"] != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin access required")
    
    restaurants = await db.restaurants.find({}, {"_id": 0}).to_list(1000)
    
    # Enrich with owner info
    for rest in restaurants:
        owner = await db.users.find_one(
            {"restaurant_id": rest["restaurant_id"], "role": "admin"},
            {"_id": 0, "email": 1, "name": 1}
        )
        rest["owner"] = owner
    
    return restaurants

@api_router.put("/super-admin/restaurants/{restaurant_id}")
async def update_restaurant_super(restaurant_id: str, input: RestaurantUpdate, request: Request):
    """Super admin updates restaurant status/plan"""
    user = await get_current_user(request, db)
    if user["role"] != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin access required")
    
    restaurant = await db.restaurants.find_one({"restaurant_id": restaurant_id})
    if not restaurant:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    
    update_data = {k: v for k, v in input.model_dump().items() if v is not None}
    update_data["updated_at"] = datetime.now(timezone.utc)
    
    # If activating a pending restaurant
    if update_data.get("status") == "ACTIVE" and restaurant.get("approval_pending"):
        plan_info = SUBSCRIPTION_PLANS.get(restaurant["plan"], SUBSCRIPTION_PLANS["BASIC"])
        update_data["subscriptionStart"] = datetime.now(timezone.utc)
        update_data["subscriptionEnd"] = datetime.now(timezone.utc) + timedelta(days=plan_info["duration_days"])
        update_data["paymentStatus"] = "PAID"
        update_data["approval_pending"] = False
        
        # Create notification
        await create_notification(
            db, restaurant_id, "RESTAURANT_APPROVED",
            f"Your restaurant has been approved! Your {restaurant['plan']} subscription is now active."
        )
    
    await db.restaurants.update_one(
        {"restaurant_id": restaurant_id},
        {"$set": update_data}
    )
    
    # Create log
    await create_subscription_log(
        db, restaurant_id, "MANUAL_UPDATE",
        {"changes": update_data, "updated_by": "super_admin"},
        user["_id"]
    )
    
    updated = await db.restaurants.find_one({"restaurant_id": restaurant_id}, {"_id": 0})
    return updated

@api_router.post("/super-admin/restaurants/{restaurant_id}/extend")
async def extend_subscription_super(restaurant_id: str, request: Request):
    """Super admin manually extends subscription"""
    user = await get_current_user(request, db)
    if user["role"] != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin access required")
    
    data = await request.json()
    days = data.get("days", 30)
    
    restaurant = await db.restaurants.find_one({"restaurant_id": restaurant_id})
    if not restaurant:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    
    # Extend subscription
    current_end = restaurant["subscriptionEnd"]
    if isinstance(current_end, str):
        current_end = datetime.fromisoformat(current_end)
    if current_end.tzinfo is None:
        current_end = current_end.replace(tzinfo=timezone.utc)
    
    new_end = current_end + timedelta(days=days)
    
    await db.restaurants.update_one(
        {"restaurant_id": restaurant_id},
        {"$set": {
            "subscriptionEnd": new_end,
            "status": "ACTIVE",
            "updated_at": datetime.now(timezone.utc)
        }}
    )
    
    # Create log
    await create_subscription_log(
        db, restaurant_id, "SUBSCRIPTION_EXTENDED",
        {"days": days, "new_end": new_end.isoformat(), "extended_by": "super_admin"},
        user["_id"]
    )
    
    return {"message": f"Subscription extended by {days} days", "new_end": new_end.isoformat()}

@api_router.get("/super-admin/analytics")
async def super_admin_analytics(request: Request):
    """Super admin views platform-wide analytics"""
    user = await get_current_user(request, db)
    if user["role"] != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin access required")
    
    # Total restaurants
    total_restaurants = await db.restaurants.count_documents({})
    active_restaurants = await db.restaurants.count_documents({"status": "ACTIVE"})
    suspended_restaurants = await db.restaurants.count_documents({"status": "SUSPENDED"})
    expired_restaurants = await db.restaurants.count_documents({"status": "EXPIRED"})
    pending_approval = await db.restaurants.count_documents({"approval_pending": True})
    
    # Revenue calculation (from subscription payments)
    revenue_pipeline = [
        {"$match": {"payment_type": "SUBSCRIPTION"}},
        {"$group": {
            "_id": None,
            "total_revenue": {"$sum": "$amount"},
            "total_payments": {"$sum": 1}
        }}
    ]
    revenue_result = await db.payments.aggregate(revenue_pipeline).to_list(1)
    total_revenue = revenue_result[0]["total_revenue"] if revenue_result else 0
    
    # MRR calculation (active subscriptions * plan price)
    mrr = 0
    cursor = db.restaurants.find({"status": "ACTIVE"})
    async for rest in cursor:
        plan_price = SUBSCRIPTION_PLANS.get(rest["plan"], SUBSCRIPTION_PLANS["BASIC"])["price"]
        mrr += plan_price
    
    # Plan distribution
    plan_distribution = {}
    for plan in ["BASIC", "PRO", "PREMIUM"]:
        count = await db.restaurants.count_documents({"plan": plan})
        plan_distribution[plan] = count
    
    return {
        "total_restaurants": total_restaurants,
        "active_restaurants": active_restaurants,
        "suspended_restaurants": suspended_restaurants,
        "expired_restaurants": expired_restaurants,
        "pending_approval": pending_approval,
        "total_revenue": total_revenue,
        "mrr": mrr,
        "plan_distribution": plan_distribution
    }

# ============ Restaurant Owner Subscription Management ============

@api_router.get("/restaurant/subscription")
async def get_my_subscription(request: Request):
    """Restaurant owner views their subscription details"""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin"]:
        raise HTTPException(status_code=403, detail="Restaurant admin access required")
    
    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")
    
    restaurant = await db.restaurants.find_one({"restaurant_id": restaurant_id}, {"_id": 0})
    if not restaurant:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    
    # Get notifications
    notifications = await db.notifications.find(
        {"restaurant_id": restaurant_id, "read": False},
        {"_id": 0}
    ).sort("created_at", -1).limit(10).to_list(10)
    
    return {
        "restaurant": restaurant,
        "notifications": notifications,
        "plan_details": SUBSCRIPTION_PLANS.get(restaurant["plan"])
    }

@api_router.post("/restaurant/subscription/renew")
async def renew_subscription(input: SubscriptionRenew, request: Request):
    """Restaurant owner renews subscription"""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin"]:
        raise HTTPException(status_code=403, detail="Restaurant admin access required")
    
    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")
    
    restaurant = await db.restaurants.find_one({"restaurant_id": restaurant_id})
    if not restaurant:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    
    # Get plan details
    plan_info = SUBSCRIPTION_PLANS.get(input.plan)
    if not plan_info:
        raise HTTPException(status_code=400, detail="Invalid plan")
    
    # Mock payment processing (in production, integrate actual gateway)
    payment_id = f"pay_{secrets.token_hex(8)}"
    payment_doc = {
        "payment_id": payment_id,
        "restaurant_id": restaurant_id,
        "amount": plan_info["price"],
        "payment_type": "SUBSCRIPTION",
        "payment_method": input.payment_method,
        "plan": input.plan,
        "status": "SUCCESS",
        "created_at": datetime.now(timezone.utc)
    }
    await db.payments.insert_one(payment_doc)
    
    # Update subscription
    subscription_start = datetime.now(timezone.utc)
    subscription_end = subscription_start + timedelta(days=plan_info["duration_days"])
    
    await db.restaurants.update_one(
        {"restaurant_id": restaurant_id},
        {"$set": {
            "status": "ACTIVE",
            "plan": input.plan,
            "subscriptionStart": subscription_start,
            "subscriptionEnd": subscription_end,
            "paymentStatus": "PAID",
            "updated_at": datetime.now(timezone.utc)
        }}
    )
    
    # Create log
    await create_subscription_log(
        db, restaurant_id, "SUBSCRIPTION_RENEWED",
        {"plan": input.plan, "amount": plan_info["price"], "payment_id": payment_id},
        user["_id"]
    )
    
    # Create notification
    await create_notification(
        db, restaurant_id, "SUBSCRIPTION_RENEWED",
        f"Your {input.plan} subscription has been renewed successfully. Valid until {subscription_end.strftime('%Y-%m-%d')}."
    )
    
    return {
        "message": "Subscription renewed successfully",
        "payment_id": payment_id,
        "subscription_end": subscription_end.isoformat()
    }

@api_router.get("/subscription/plans")
async def get_subscription_plans():
    """Public endpoint to view available subscription plans"""
    return SUBSCRIPTION_PLANS

