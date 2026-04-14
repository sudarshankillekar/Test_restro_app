from fastapi import FastAPI, APIRouter, HTTPException, Request, Response
from fastapi.encoders import jsonable_encoder
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import StreamingResponse
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import DuplicateKeyError
import os
import logging
from pathlib import Path
from datetime import datetime, timezone, timedelta
from io import BytesIO
from typing import Optional
from fastapi.middleware.cors import CORSMiddleware
import socketio
import uvicorn

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

from auth import (
    hash_password, verify_password, create_access_token, create_refresh_token,
    get_current_user, get_jwt_secret, JWT_ALGORITHM, seed_admin, attach_restaurant_context,
    check_brute_force, record_failed_login, clear_failed_logins
)
from subscription import (
    check_restaurant_subscription, get_restaurant_from_user,
    create_subscription_log, create_notification,
    check_and_expire_subscriptions, send_expiry_reminders,
    SUBSCRIPTION_PLANS
)
from models import (
    LoginRequest, RegisterRequest, UserResponse, MenuItemCreate, MenuItemUpdate,
    TableCreate, CategoryCreate, CustomerSessionCreate, OrderCreate, OrderResponse,
    PaymentCreate, AnalyticsResponse, RestaurantCreate, RestaurantUpdate, RestaurantProfileUpdate, SubscriptionRenew
)
from xlsx_export import build_xlsx_bytes
import jwt
import secrets

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Socket.IO setup
sio = socketio.AsyncServer(
    async_mode='asgi',
    cors_allowed_origins='*',
    logger=False,
    engineio_logger=False
)

# Create the main app
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000"
    ],
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
api_router = APIRouter(prefix="/api")

# ============ Socket.IO Events ============
@sio.event
async def connect(sid, environ):
    logging.info(f"Client connected: {sid}")

@sio.event
async def disconnect(sid):
    logging.info(f"Client disconnected: {sid}")

@sio.event
async def join_room(sid, data):
    room = data.get('room')
    await sio.enter_room(sid, room)
    logging.info(f"Client {sid} joined room {room}")


def parse_date_value(value: Optional[str], end_of_day: bool = False):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD.")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    if end_of_day:
        parsed = parsed + timedelta(days=1)
    return parsed


async def resolve_restaurant_access(request: Request, allowed_roles: list[str], restaurant_id: Optional[str] = None, allow_super_admin_filter: bool = False):
    user = await get_current_user(request, db)
    if user["role"] not in allowed_roles:
        raise HTTPException(status_code=403, detail="Not authorized")

    if user["role"] == "super_admin":
        if allow_super_admin_filter:
            return user, restaurant_id
        raise HTTPException(status_code=403, detail="Restaurant access required")

    user_restaurant_id = user.get("restaurant_id")
    if not user_restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")
    if restaurant_id and restaurant_id != user_restaurant_id:
        raise HTTPException(status_code=403, detail="Cross-restaurant access is not allowed")
    return user, user_restaurant_id


async def get_restaurant_id_from_request(request: Request, restaurant_id: Optional[str] = None):
    if restaurant_id:
        return restaurant_id

    try:
        _, resolved_restaurant_id = await resolve_restaurant_access(
            request,
            ["admin", "kitchen", "billing"],
        )
        return resolved_restaurant_id
    except HTTPException:
        raise HTTPException(status_code=400, detail="restaurant_id is required")


def build_date_match(start_date: Optional[str] = None, end_date: Optional[str] = None):
    match = {}
    parsed_start = parse_date_value(start_date)
    parsed_end = parse_date_value(end_date, end_of_day=True)
    if parsed_start:
        match["$gte"] = parsed_start
    if parsed_end:
        match["$lt"] = parsed_end
    if parsed_start and parsed_end and parsed_start >= parsed_end:
        raise HTTPException(status_code=400, detail="End date must be after start date.")
    return match


def to_socket_payload(data):
    return jsonable_encoder(data)

# ============ Auth Endpoints ============
@api_router.post("/auth/register")
async def register(input: RegisterRequest, response: Response):
    """Register new staff user - ONLY restaurant admins can create kitchen/billing staff"""
    email = input.email.lower()
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    # Validate role - only kitchen and billing can be registered this way
    # Restaurant admins are created by super admin through restaurant creation
    if input.role not in ["kitchen", "billing"]:
        raise HTTPException(status_code=400, detail="Invalid role. Only kitchen and billing staff can be registered here.")
    
    hashed = hash_password(input.password)
    user_doc = {
        "email": email,
        "password_hash": hashed,
        "name": input.name,
        "role": input.role,
        "created_at": datetime.now(timezone.utc)
    }
    result = await db.users.insert_one(user_doc)
    user_id = str(result.inserted_id)
    
    access_token = create_access_token(user_id, email)
    refresh_token = create_refresh_token(user_id)
    
    response.set_cookie(key="access_token", value=access_token, httponly=True, secure=False, samesite="lax", max_age=900, path="/")
    response.set_cookie(key="refresh_token", value=refresh_token, httponly=True, secure=False, samesite="lax", max_age=604800, path="/")
    
    return {"email": email, "name": input.name, "role": input.role, "_id": user_id}

@api_router.post("/auth/login")
async def login(input: LoginRequest, request: Request, response: Response):
    email = input.email.lower()
    
    # Check brute force
    client_ip = request.client.host
    await check_brute_force(db, client_ip, email)
    
    user = await db.users.find_one({"email": email})
    if not user or not verify_password(input.password, user["password_hash"]):
        await record_failed_login(db, client_ip, email)
        raise HTTPException(status_code=401, detail="Invalid credentials")

    restaurant_id = user.get("restaurant_id")
    if user.get("role") != "super_admin" and restaurant_id:
        restaurant = await db.restaurants.find_one({"restaurant_id": restaurant_id}, {"_id": 0, "status": 1})
        if restaurant and restaurant.get("status") == "SUSPENDED":
            raise HTTPException(status_code=403, detail="Restaurant account is suspended. Please contact support.")
        if restaurant and restaurant.get("status") == "EXPIRED":
            raise HTTPException(status_code=403, detail="Restaurant subscription has expired. Please contact support.")
    
    await clear_failed_logins(db, client_ip, email)
    
    user_id = str(user["_id"])
    access_token = create_access_token(user_id, email)
    refresh_token = create_refresh_token(user_id)
    
    response.set_cookie(key="access_token", value=access_token, httponly=True, secure=False, samesite="lax", max_age=900, path="/")
    response.set_cookie(key="refresh_token", value=refresh_token, httponly=True, secure=False, samesite="lax", max_age=604800, path="/")
    
    response_user = await attach_restaurant_context(dict(user), db)
    return {
        "email": response_user["email"],
        "name": response_user["name"],
        "role": response_user["role"],
        "_id": response_user["_id"],
        "restaurant_id": response_user.get("restaurant_id"),
        "restaurant_name": response_user.get("restaurant_name"),
        "restaurant_gst_number": response_user.get("restaurant_gst_number"),
        "access_token": access_token
    }

@api_router.get("/auth/me")
async def get_me(request: Request):
    user = await get_current_user(request, db)
    return user

@api_router.post("/auth/logout")
async def logout(response: Response):
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("refresh_token", path="/")
    return {"message": "Logged out successfully"}

@api_router.post("/auth/google/session")
async def google_session(request: Request, response: Response):
    """Exchange session_id for user data via Emergent Auth"""
    import httpx
    
    data = await request.json()
    session_id = data.get("session_id")
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id required")
    
    # Call Emergent Auth API
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            "https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data",
            headers={"X-Session-ID": session_id}
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=401, detail="Invalid session_id")
        
        oauth_data = resp.json()
    
    # Store/update user in DB
    email = oauth_data["email"].lower()
    user = await db.users.find_one({"email": email})
    
    if user:
        # Update existing user
        await db.users.update_one(
            {"email": email},
            {"$set": {"name": oauth_data["name"], "picture": oauth_data.get("picture")}}
        )
        user_id = str(user["_id"])
    else:
        # Create new admin user
        user_doc = {
            "email": email,
            "name": oauth_data["name"],
            "picture": oauth_data.get("picture"),
            "role": "admin",
            "created_at": datetime.now(timezone.utc)
        }
        result = await db.users.insert_one(user_doc)
        user_id = str(result.inserted_id)
    
    # Store session token
    session_token = oauth_data["session_token"]
    expires_at = datetime.now(timezone.utc) + timedelta(days=7)
    await db.user_sessions.insert_one({
        "user_id": user_id,
        "session_token": session_token,
        "expires_at": expires_at,
        "created_at": datetime.now(timezone.utc)
    })
    
    # Set cookie
    response.set_cookie(
        key="session_token",
        value=session_token,
        httponly=True,
        secure=True,
        samesite="none",
        max_age=604800,
        path="/"
    )
    
response_user = await attach_restaurant_context(dict(user), db)

return {
    "email": response_user["email"],
    "name": response_user["name"],
    "role": response_user["role"],
    "_id": response_user["_id"],
    "restaurant_id": response_user.get("restaurant_id"),
    "restaurant_name": response_user.get("restaurant_name"),
    "restaurant_gst_number": response_user.get("restaurant_gst_number"),

    # 🔥 REQUIRED
    "access_token": access_token
}

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

@api_router.get("/restaurant/profile")
async def get_restaurant_profile(request: Request):
    """Restaurant admin/staff views their restaurant profile details"""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "kitchen", "billing"]:
        raise HTTPException(status_code=403, detail="Restaurant access required")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    restaurant = await db.restaurants.find_one(
        {"restaurant_id": restaurant_id},
        {"_id": 0, "restaurant_id": 1, "name": 1, "gst_number": 1}
    )
    if not restaurant:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    return restaurant

@api_router.put("/restaurant/profile")
async def update_restaurant_profile(input: RestaurantProfileUpdate, request: Request):
    """Restaurant admin updates editable profile details"""
    user = await get_current_user(request, db)
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Restaurant admin access required")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    gst_number = (input.gst_number or "").strip() or None
    if gst_number and len(gst_number) > 30:
        raise HTTPException(status_code=400, detail="GST number must be 30 characters or fewer.")

    await db.restaurants.update_one(
        {"restaurant_id": restaurant_id},
        {"$set": {
            "gst_number": gst_number,
            "updated_at": datetime.now(timezone.utc)
        }}
    )

    updated_restaurant = await db.restaurants.find_one(
        {"restaurant_id": restaurant_id},
        {"_id": 0, "restaurant_id": 1, "name": 1, "gst_number": 1}
    )
    if not updated_restaurant:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    return updated_restaurant

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


# ============ Customer Session Endpoints ============
@api_router.post("/customer/session")
async def create_customer_session(input: CustomerSessionCreate):
    """Create customer session for table ordering"""
    # Verify table exists
    table = await db.tables.find_one({"table_id": input.table_id})
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")
    
    # Check restaurant subscription status
    restaurant_id = table.get("restaurant_id")
    if restaurant_id:
        try:
            await check_restaurant_subscription(db, restaurant_id)
        except HTTPException:
            raise HTTPException(status_code=503, detail="Restaurant currently unavailable. Please try again later.")
    
    session_token = secrets.token_urlsafe(32)
    session_doc = {
        "session_token": session_token,
        "table_id": input.table_id,
        "restaurant_id": restaurant_id,
        "customer_name": input.customer_name,
        "phone": input.phone,
        "created_at": datetime.now(timezone.utc),
        "expires_at": datetime.now(timezone.utc) + timedelta(hours=4)
    }
    await db.customer_sessions.insert_one(session_doc)
    
    return {"session_token": session_token, "table_id": input.table_id, "restaurant_id": restaurant_id}

@api_router.get("/customer/session/{token}")
async def get_customer_session(token: str):
    """Verify customer session"""
    session = await db.customer_sessions.find_one({"session_token": token})
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    # Check expiry
    expires_at = session["expires_at"]
    if isinstance(expires_at, str):
        expires_at = datetime.fromisoformat(expires_at)
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    
    if expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=401, detail="Session expired")
    
    return {
        "table_id": session["table_id"],
        "customer_name": session["customer_name"],
        "phone": session["phone"]
    }

# ============ Menu Endpoints ============
@api_router.get("/menu/categories")
async def get_categories(request: Request, restaurant_id: str = None):
    """Get menu categories (public for customers, filtered by restaurant)"""
    resolved_restaurant_id = await get_restaurant_id_from_request(request, restaurant_id)
    query = {"restaurant_id": resolved_restaurant_id}
    categories = await db.menu_categories.find(query, {"_id": 0}).sort("order", 1).to_list(100)
    return categories

@api_router.post("/menu/categories")
async def create_category(input: CategoryCreate, request: Request):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    # Get restaurant_id and check subscription
    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")
    
    await check_restaurant_subscription(db, restaurant_id)

    category_name = (input.name or "").strip()
    if not category_name:
        raise HTTPException(status_code=400, detail="Please enter a category name.")
    
    # Get max order
    last_cat = await db.menu_categories.find_one({"restaurant_id": restaurant_id}, sort=[("order", -1)])
    order = (last_cat["order"] + 1) if last_cat else 0
    
    cat_doc = {
        "category_id": f"cat_{secrets.token_hex(6)}",
        "name": category_name,
        "order": order,
        "restaurant_id": restaurant_id,
        "created_at": datetime.now(timezone.utc)
    }
    await db.menu_categories.insert_one(cat_doc)
    return {k: v for k, v in cat_doc.items() if k != "_id"}

@api_router.get("/menu/items")
async def get_menu_items(request: Request, restaurant_id: str = None):
    """Get menu items - filtered by restaurant for customers"""
    resolved_restaurant_id = await get_restaurant_id_from_request(request, restaurant_id)
    query = {"restaurant_id": resolved_restaurant_id}
    items = await db.menu_items.find(query, {"_id": 0}).to_list(1000)
    return items

@api_router.post("/menu/items")
async def create_menu_item(input: MenuItemCreate, request: Request):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    # Get restaurant_id
    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")
    
    await check_restaurant_subscription(db, restaurant_id)

    item_name = (input.name or "").strip()
    category_id = (input.category_id or "").strip()
    description = (input.description or "").strip()
    image = (input.image or "").strip()

    if not item_name:
        raise HTTPException(status_code=400, detail="Please enter an item name.")
    if not category_id:
        raise HTTPException(status_code=400, detail="Please select a category.")
    if input.price is None or input.price <= 0:
        raise HTTPException(status_code=400, detail="Please enter a valid item price.")
    category = await db.menu_categories.find_one({
        "category_id": category_id,
        "restaurant_id": restaurant_id
    })
    if not category:
        raise HTTPException(status_code=400, detail="Selected category was not found.")
    
    item_doc = {
        "item_id": f"item_{secrets.token_hex(8)}",
        "name": item_name,
        "category_id": category_id,
        "price": input.price,
        "description": description,
        "image": image,
        "available": True,
        "restaurant_id": restaurant_id,
        "created_at": datetime.now(timezone.utc)
    }
    await db.menu_items.insert_one(item_doc)
    return {k: v for k, v in item_doc.items() if k != "_id"}

@api_router.put("/menu/items/{item_id}")
async def update_menu_item(item_id: str, input: MenuItemUpdate, request: Request):
    user, restaurant_id = await resolve_restaurant_access(request, ["admin"])
    
    update_data = {k: v for k, v in input.model_dump().items() if v is not None}
    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "name" in update_data:
        update_data["name"] = update_data["name"].strip()
        if not update_data["name"]:
            raise HTTPException(status_code=400, detail="Please enter an item name.")
    if "description" in update_data:
        update_data["description"] = update_data["description"].strip()
    if "category_id" in update_data:
        update_data["category_id"] = update_data["category_id"].strip()
        if not update_data["category_id"]:
            raise HTTPException(status_code=400, detail="Please select a category.")
        category = await db.menu_categories.find_one({
            "category_id": update_data["category_id"],
            "restaurant_id": restaurant_id
        })
        if not category:
            raise HTTPException(status_code=400, detail="Selected category was not found.")
    if "image" in update_data:
        update_data["image"] = update_data["image"].strip()
    if "price" in update_data and update_data["price"] <= 0:
        raise HTTPException(status_code=400, detail="Please enter a valid item price.")
    
    result = await db.menu_items.update_one(
        {"item_id": item_id, "restaurant_id": restaurant_id},
        {"$set": update_data}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Item not found")
    
    item = await db.menu_items.find_one({"item_id": item_id, "restaurant_id": restaurant_id}, {"_id": 0})
    return item

@api_router.delete("/menu/items/{item_id}")
async def delete_menu_item(item_id: str, request: Request):
    _, restaurant_id = await resolve_restaurant_access(request, ["admin"])
    
    result = await db.menu_items.delete_one({"item_id": item_id, "restaurant_id": restaurant_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Item not found")
    
    return {"message": "Item deleted successfully"}

# ============ Table Endpoints ============
@api_router.get("/tables")
async def get_tables(request: Request = None, restaurant_id: str = None):
    """Get tables - filtered by restaurant for staff, or by restaurant_id param for customers"""
    resolved_restaurant_id = await get_restaurant_id_from_request(request, restaurant_id)
    query = {"restaurant_id": resolved_restaurant_id}
    
    tables = await db.tables.find(query, {"_id": 0}).sort("table_number", 1).to_list(1000)
    return tables

@api_router.post("/tables")
async def create_table(input: TableCreate, request: Request):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    # Get restaurant_id
    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")
    
    await check_restaurant_subscription(db, restaurant_id)

    if input.table_number is None:
        raise HTTPException(status_code=400, detail="Please add one table number to create QR code.")
    if input.table_number <= 0:
        raise HTTPException(status_code=400, detail="Please enter a valid table number.")

    table_id = f"table_{secrets.token_hex(6)}"
    
    # Get frontend URL from env or use local dev default
    frontend_url = os.environ.get('FRONTEND_URL', 'http://127.0.0.1:3000')
    
    table_doc = {
        "table_id": table_id,
        "table_number": input.table_number,
        "restaurant_id": restaurant_id,
        "status": "available",
        "qr_code": f"{frontend_url}/customer/{table_id}",
        "created_at": datetime.now(timezone.utc)
    }
    try:
        await db.tables.insert_one(table_doc)
    except DuplicateKeyError:
        raise HTTPException(status_code=400, detail=f"Table number {input.table_number} already exists.")
    return {k: v for k, v in table_doc.items() if k != "_id"}

async def enrich_orders(order_docs):
    if not order_docs:
        return []

    table_ids = [order["table_id"] for order in order_docs if order.get("table_id")]
    order_ids = [order["order_id"] for order in order_docs if order.get("order_id")]

    tables = await db.tables.find({"table_id": {"$in": table_ids}}, {"_id": 0, "table_id": 1, "table_number": 1}).to_list(1000)
    payments = await db.payments.find({
        "$or": [
            {"order_id": {"$in": order_ids}},
            {"order_ids": {"$in": order_ids}},
        ]
    }, {"_id": 0}).to_list(1000)

    table_map = {table["table_id"]: table for table in tables}
    payment_map = {}
    for payment in payments:
        linked_order_ids = payment.get("order_ids") or [payment.get("order_id")]
        for linked_order_id in linked_order_ids:
            if linked_order_id:
                payment_map[linked_order_id] = payment

    enriched = []
    for order in order_docs:
        cloned = dict(order)
        table = table_map.get(cloned.get("table_id"), {})
        cloned["table_number"] = cloned.get("table_number") or table.get("table_number")
        if cloned["table_number"] is not None:
            cloned["table_label"] = f"Table {cloned['table_number']}"
        else:
            cloned["table_label"] = cloned.get("table_id")
        payment = payment_map.get(cloned.get("order_id"))
        if payment:
            cloned["payment"] = payment
            cloned["payment_status"] = "completed"
        else:
            cloned["payment_status"] = cloned.get("payment_status", "pending")
        enriched.append(cloned)
    return enriched


def build_table_order_summary(orders):
    if not orders:
        return {
            "active_order_count": 0,
            "combined_total": 0,
            "orders": [],
        }

    active_orders = [order for order in orders if order.get("status") not in ["served", "cancelled"]]
    combined_total = round(sum(order.get("total", 0) for order in active_orders), 2)
    return {
        "active_order_count": len(active_orders),
        "combined_total": combined_total,
        "orders": active_orders,
    }

@api_router.delete("/tables/{table_id}")
async def delete_table(table_id: str, request: Request):
    """Delete a table"""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")
    
    # Delete only if it belongs to this restaurant
    result = await db.tables.delete_one({
        "table_id": table_id,
        "restaurant_id": restaurant_id
    })
    
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Table not found")
    
    return {"message": "Table deleted successfully"}

# ============ Order Endpoints ============
@api_router.post("/orders")
async def create_order(input: OrderCreate):
    """Create a new order ticket linked to a table."""
    # Verify customer session
    session = await db.customer_sessions.find_one({"session_token": input.customer_session_token})
    if not session:
        raise HTTPException(status_code=401, detail="Invalid session")
    
    # Get table to find restaurant_id
    table = await db.tables.find_one({"table_id": session["table_id"]})
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")
    
    restaurant_id = table.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="Table not associated with restaurant")
    
    # Check restaurant subscription
    await check_restaurant_subscription(db, restaurant_id)
    
    existing_active_orders = await db.orders.find({
        "table_id": session["table_id"],
        "restaurant_id": restaurant_id,
        "status": {"$nin": ["served", "cancelled"]}
    }, {"_id": 0, "order_id": 1, "status": 1, "created_at": 1}).sort("created_at", -1).to_list(50)
    
    # Calculate total
    total = 0
    order_items = []
    for item in input.items:
        menu_item = await db.menu_items.find_one({
            "item_id": item.item_id,
            "restaurant_id": restaurant_id
        }, {"_id": 0})
        if not menu_item:
            raise HTTPException(status_code=404, detail=f"Item {item.item_id} not found")
        if not menu_item["available"]:
            raise HTTPException(status_code=400, detail=f"{menu_item['name']} is not available")
        
        item_total = menu_item["price"] * item.quantity
        total += item_total
        order_items.append({
            "item_id": item.item_id,
            "name": menu_item["name"],
            "quantity": item.quantity,
            "price": menu_item["price"],
            "instructions": item.instructions or ""
        })
    
    latest_active_order = existing_active_orders[0] if existing_active_orders else None
    prioritized_add_on = any(order["status"] in ["pending", "accepted"] for order in existing_active_orders)

    order_id = f"ORD{secrets.token_hex(6).upper()}"
    
    # Store/update customer data in customers collection
    customer_data = {
        "customer_name": session["customer_name"],
        "phone": session["phone"],
        "restaurant_id": restaurant_id,
        "last_visit": datetime.now(timezone.utc)
    }
    
    existing_customer = await db.customers.find_one({
        "phone": session["phone"],
        "restaurant_id": restaurant_id
    })
    
    if existing_customer:
        await db.customers.update_one(
            {"phone": session["phone"], "restaurant_id": restaurant_id},
            {
                "$set": customer_data,
                "$inc": {"total_orders": 1}
            }
        )
    else:
        customer_data["total_orders"] = 1
        customer_data["created_at"] = datetime.now(timezone.utc)
        await db.customers.insert_one(customer_data)
    
    order_doc = {
        "order_id": order_id,
        "table_id": session["table_id"],
        "table_number": table.get("table_number"),
        "restaurant_id": restaurant_id,
        "customer_name": session["customer_name"],
        "phone": session["phone"],
        "items": order_items,
        "total": total,
        "status": "pending",
        "payment_status": "pending",
        "is_add_on": bool(latest_active_order),
        "add_on_to_order_id": latest_active_order["order_id"] if latest_active_order else None,
        "priority": "high" if latest_active_order and prioritized_add_on else "normal",
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
        "timestamps": {
            "pending": datetime.now(timezone.utc).isoformat()
        }
    }
    await db.orders.insert_one(order_doc)

    created_order = (await enrich_orders([{k: v for k, v in order_doc.items() if k != "_id"}]))[0]

    await sio.emit('new_order', to_socket_payload(created_order), room=f'restaurant_{restaurant_id}')
    if created_order.get("is_add_on"):
        await sio.emit('kitchen_notification', {
            "type": "add_on",
            "order_id": created_order["order_id"],
            "table_id": created_order["table_id"],
            "table_label": created_order.get("table_label"),
            "message": f"Add-on order received for {created_order.get('table_label') or created_order['table_id']}"
        }, room=f'restaurant_{restaurant_id}')
    
    return created_order

@api_router.get("/orders")
async def get_orders(request: Request, status: str = None):
    """Get all orders (kitchen/billing dashboard - requires auth)"""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "kitchen", "billing"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    # Get restaurant_id for data isolation
    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")
    
    # CRITICAL: Filter by restaurant_id for data isolation
    query = {"restaurant_id": restaurant_id}
    if status:
        query["status"] = status
    
    orders = await db.orders.find(query, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return await enrich_orders(orders)

@api_router.get("/orders/{order_id}")
async def get_order(order_id: str, request: Request, customer_session_token: str = None):
    """Get single order (customer tracking)"""
    query = {"order_id": order_id}

    try:
        user = await get_current_user(request, db)
        if user["role"] == "super_admin":
            pass
        else:
            restaurant_id = user.get("restaurant_id")
            if not restaurant_id:
                raise HTTPException(status_code=400, detail="User not associated with any restaurant")
            query["restaurant_id"] = restaurant_id
    except HTTPException:
        session = None
        if not customer_session_token:
            raise HTTPException(status_code=401, detail="customer_session_token is required")
        session = await db.customer_sessions.find_one({"session_token": customer_session_token})
        if not session:
            raise HTTPException(status_code=401, detail="Invalid session")
        query["table_id"] = session["table_id"]
        query["restaurant_id"] = session.get("restaurant_id")

    order = await db.orders.find_one(query, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    enriched = await enrich_orders([order])
    response_order = enriched[0]

    if customer_session_token and session:
        related_orders = await db.orders.find({
            "table_id": session["table_id"],
            "restaurant_id": session.get("restaurant_id"),
            "status": {"$nin": ["cancelled"]},
        }, {"_id": 0}).sort("created_at", 1).to_list(100)
        enriched_related_orders = await enrich_orders(related_orders)
        response_order["table_order_summary"] = build_table_order_summary(enriched_related_orders)

    return response_order

@api_router.put("/orders/{order_id}/status")
async def update_order_status(order_id: str, request: Request):
    """Update order status (kitchen/billing - requires auth)"""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "kitchen", "billing"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    data = await request.json()
    new_status = data.get("status")
    
    if new_status not in ["accepted", "prepared", "served", "cancelled"]:
        raise HTTPException(status_code=400, detail="Invalid status")
    
    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    order = await db.orders.find_one({"order_id": order_id, "restaurant_id": restaurant_id})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    
    # Update timestamps
    timestamps = order.get("timestamps", {})
    timestamps[new_status] = datetime.now(timezone.utc).isoformat()
    
    await db.orders.update_one(
        {"order_id": order_id, "restaurant_id": restaurant_id},
        {
            "$set": {
                "status": new_status,
                "timestamps": timestamps,
                "updated_at": datetime.now(timezone.utc)
            }
        }
    )
    
    updated_order = await db.orders.find_one({"order_id": order_id, "restaurant_id": restaurant_id}, {"_id": 0})
    enriched = await enrich_orders([updated_order])
    
    await sio.emit('order_status_updated', to_socket_payload(enriched[0]), room=f'restaurant_{restaurant_id}')
    await sio.emit('order_status_updated', to_socket_payload(enriched[0]), room=f'order_{order_id}')
    
    return enriched[0]

# ============ Payment Endpoints ============
@api_router.post("/payments")
async def create_payment(input: PaymentCreate, request: Request):
    """Create payment (billing/admin - requires auth)"""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "billing"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    target_order_ids = input.order_ids or ([input.order_id] if input.order_id else [])
    if not target_order_ids:
        raise HTTPException(status_code=400, detail="Please select at least one order to bill.")

    orders = await db.orders.find({
        "order_id": {"$in": target_order_ids},
        "restaurant_id": restaurant_id
    }, {"_id": 0}).to_list(len(target_order_ids))
    if len(orders) != len(target_order_ids):
        raise HTTPException(status_code=404, detail="One or more orders were not found")
    if any(order["status"] != "prepared" for order in orders):
        raise HTTPException(status_code=400, detail="Only prepared orders can be billed.")

    table_ids = {order["table_id"] for order in orders}
    if len(table_ids) != 1:
        raise HTTPException(status_code=400, detail="Orders must belong to the same table to create one bill.")
    table_id = orders[0]["table_id"]
    table_number = orders[0].get("table_number")
    
    # Calculate tax (5% GST)
    subtotal = round(sum(order["total"] for order in orders), 2)
    tax = round(subtotal * 0.05, 2)
    total = subtotal + tax
    bill_id = f"BILL{secrets.token_hex(5).upper()}"
    
    payment_doc = {
        "payment_id": f"PAY{secrets.token_hex(6).upper()}",
        "bill_id": bill_id,
        "order_id": target_order_ids[0],
        "order_ids": target_order_ids,
        "restaurant_id": restaurant_id,
        "table_id": table_id,
        "table_number": table_number,
        "subtotal": subtotal,
        "tax": tax,
        "discount": input.discount or 0,
        "total": total - (input.discount or 0),
        "payment_method": input.payment_method,
        "status": "completed",
        "created_at": datetime.now(timezone.utc),
        "created_by": user["_id"]
    }
    await db.payments.insert_one(payment_doc)
    
    await db.orders.update_many(
        {"order_id": {"$in": target_order_ids}, "restaurant_id": restaurant_id},
        {"$set": {
            "status": "served",
            "payment_status": "completed",
            "updated_at": datetime.now(timezone.utc),
            "timestamps.served": datetime.now(timezone.utc).isoformat()
        }}
    )

    updated_orders = await db.orders.find({
        "order_id": {"$in": target_order_ids},
        "restaurant_id": restaurant_id
    }, {"_id": 0}).to_list(len(target_order_ids))
    enriched_orders = await enrich_orders(updated_orders)
    for enriched_order in enriched_orders:
        await sio.emit('order_status_updated', to_socket_payload(enriched_order), room=f'restaurant_{restaurant_id}')
        await sio.emit('order_status_updated', to_socket_payload(enriched_order), room=f'order_{enriched_order["order_id"]}')
    
    return {k: v for k, v in payment_doc.items() if k != "_id"}

@api_router.get("/payments/{order_id}")
async def get_payment(order_id: str, request: Request):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "billing", "super_admin"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    query = {"$or": [{"order_id": order_id}, {"order_ids": order_id}]}
    if user["role"] != "super_admin":
        restaurant_id = user.get("restaurant_id")
        if not restaurant_id:
            raise HTTPException(status_code=400, detail="User not associated with any restaurant")
        query = {"$and": [query, {"restaurant_id": restaurant_id}]}

    payment = await db.payments.find_one(query, {"_id": 0})
    if not payment:
        raise HTTPException(status_code=404, detail="Payment not found")
    return payment

# ============ Analytics Endpoints ============
@api_router.get("/analytics/dashboard")
async def get_analytics(request: Request, period: str = "daily"):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    # Get restaurant_id for data isolation
    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")
    
    # Calculate date range
    now = datetime.now(timezone.utc)
    if period == "daily":
        start_date = now - timedelta(days=1)
    elif period == "weekly":
        start_date = now - timedelta(days=7)
    elif period == "monthly":
        start_date = now - timedelta(days=30)
    else:
        start_date = now - timedelta(days=1)
    
    # CRITICAL: Filter by restaurant_id for data isolation
    # Aggregate data
    pipeline = [
        {"$match": {
            "restaurant_id": restaurant_id,
            "created_at": {"$gte": start_date},
            "status": "served"
        }},
        {
            "$group": {
                "_id": None,
                "total_orders": {"$sum": 1},
                "total_revenue": {"$sum": "$total"},
                "avg_order_value": {"$avg": "$total"}
            }
        }
    ]
    
    result = await db.orders.aggregate(pipeline).to_list(1)

    total_tables = await db.tables.count_documents({"restaurant_id": restaurant_id})
    occupied_tables = len(await db.orders.distinct("table_id", {
        "restaurant_id": restaurant_id,
        "status": {"$nin": ["served", "cancelled"]}
    }))
    empty_tables = max(total_tables - occupied_tables, 0)
    
    if not result:
        return {
            "total_orders": 0,
            "total_revenue": 0,
            "avg_order_value": 0,
            "top_items": [],
            "peak_hours": [],
            "occupied_tables": occupied_tables,
            "empty_tables": empty_tables,
            "recent_sales": [],
            "best_seller": None
        }
    
    # Top selling items for this restaurant only
    top_items_pipeline = [
        {"$match": {
            "restaurant_id": restaurant_id,
            "created_at": {"$gte": start_date},
            "status": "served"
        }},
        {"$unwind": "$items"},
        {
            "$group": {
                "_id": "$items.name",
                "quantity": {"$sum": "$items.quantity"},
                "revenue": {"$sum": {"$multiply": ["$items.price", "$items.quantity"]}}
            }
        },
        {"$sort": {"quantity": -1}},
        {"$limit": 5}
    ]
    
    top_items = await db.orders.aggregate(top_items_pipeline).to_list(5)

    recent_sales_pipeline = [
        {"$match": {
            "restaurant_id": restaurant_id,
            "created_at": {"$gte": start_date},
            "status": "served"
        }},
        {"$unwind": "$items"},
        {"$sort": {"updated_at": -1}},
        {"$limit": 20},
        {"$project": {
            "_id": 0,
            "order_id": 1,
            "table_id": 1,
            "table_number": 1,
            "customer_name": 1,
            "sold_at": "$updated_at",
            "item_name": "$items.name",
            "quantity": "$items.quantity",
            "price": "$items.price"
        }}
    ]
    recent_sales = await db.orders.aggregate(recent_sales_pipeline).to_list(20)

    best_seller = None
    if top_items:
        best_seller = {
            "name": top_items[0]["_id"],
            "quantity": top_items[0]["quantity"]
        }
    
    return {
        "total_orders": result[0]["total_orders"],
        "total_revenue": round(result[0]["total_revenue"], 2),
        "avg_order_value": round(result[0]["avg_order_value"], 2),
        "top_items": [{"name": item["_id"], "quantity": item["quantity"], "revenue": item["revenue"]} for item in top_items],
        "peak_hours": [],
        "occupied_tables": occupied_tables,
        "empty_tables": empty_tables,
        "recent_sales": recent_sales,
        "best_seller": best_seller
    }


@api_router.get("/analytics/export")
async def export_sales_data(
    request: Request,
    start_date: str = None,
    end_date: str = None,
    restaurant_id: str = None
):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "super_admin"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    if user["role"] == "super_admin":
        scoped_restaurant_id = restaurant_id
    else:
        scoped_restaurant_id = user.get("restaurant_id")
        if not scoped_restaurant_id:
            raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    created_at_filter = build_date_match(start_date, end_date)
    order_query = {"status": "served"}
    if scoped_restaurant_id:
        order_query["restaurant_id"] = scoped_restaurant_id
    if created_at_filter:
        order_query["updated_at"] = created_at_filter

    orders = await db.orders.find(order_query, {"_id": 0}).sort("updated_at", -1).to_list(5000)
    orders = await enrich_orders(orders)

    restaurant_names = {}
    if user["role"] == "super_admin":
        restaurant_ids = list({order.get("restaurant_id") for order in orders if order.get("restaurant_id")})
        if restaurant_ids:
            restaurants = await db.restaurants.find(
                {"restaurant_id": {"$in": restaurant_ids}},
                {"_id": 0, "restaurant_id": 1, "name": 1}
            ).to_list(len(restaurant_ids))
            restaurant_names = {restaurant["restaurant_id"]: restaurant["name"] for restaurant in restaurants}

    rows = []
    for order in orders:
        items_summary = ", ".join(
            f"{item['name']} x{item['quantity']}"
            for item in order.get("items", [])
        )
        rows.append([
            restaurant_names.get(order.get("restaurant_id"), order.get("restaurant_name", "")),
            order["order_id"],
            order.get("updated_at") or order.get("created_at"),
            order.get("table_number") or "",
            items_summary,
            round(order.get("payment", {}).get("total", order.get("total", 0)), 2),
            order.get("payment_status", "pending"),
        ])

    workbook = build_xlsx_bytes(
        headers=[
            "Restaurant",
            "Order ID",
            "Date & Time",
            "Table Number",
            "Items Ordered",
            "Total Amount",
            "Payment Status",
        ],
        rows=rows,
        sheet_name="Sales Export",
    )

    filename_parts = ["sales-export"]
    if scoped_restaurant_id:
        filename_parts.append(scoped_restaurant_id)
    if start_date:
        filename_parts.append(start_date)
    if end_date:
        filename_parts.append(end_date)
    filename = "-".join(filename_parts) + ".xlsx"

    return StreamingResponse(
        BytesIO(workbook),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

# Include router
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

# Startup event
@app.on_event("startup")
async def startup_event():
    db_available = True
    try:
        await seed_admin(db)
        
        # Create indexes
        await db.users.create_index("email", unique=True)
        await db.restaurants.create_index("restaurant_id", unique=True)
        await db.tables.create_index("table_id", unique=True)
        await db.tables.create_index([("restaurant_id", 1), ("table_number", 1)], unique=True)
        await db.menu_items.create_index("item_id", unique=True)
        await db.menu_categories.create_index([("restaurant_id", 1), ("order", 1)])
        await db.menu_items.create_index([("restaurant_id", 1), ("category_id", 1)])
        await db.orders.create_index("order_id", unique=True)
        await db.orders.create_index([("restaurant_id", 1), ("status", 1), ("created_at", -1)])
        await db.customer_sessions.create_index("session_token", unique=True)
        await db.payments.create_index([("restaurant_id", 1), ("order_id", 1)])
        
        # Run initial subscription check
        await check_and_expire_subscriptions(db)
        await send_expiry_reminders(db)
        
        logging.info("Database indexes created")
        logging.info("Admin user seeded")
        logging.info("Subscription system initialized")
    except Exception as e:
        db_available = False
        logging.error(f"Startup completed without database initialization: {e}")
    
    # Schedule periodic subscription checks (every hour)
    import asyncio
    async def periodic_subscription_check():
        while True:
            await asyncio.sleep(3600)  # 1 hour
            try:
                await check_and_expire_subscriptions(db)
                await send_expiry_reminders(db)
            except Exception as e:
                logging.error(f"Subscription check error: {e}")
    
    if db_available:
        asyncio.create_task(periodic_subscription_check())

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()


fastapi_app = app
app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)
socket_app = app

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)
