from fastapi import FastAPI, APIRouter, HTTPException, Request, Response, UploadFile, File
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
from urllib.parse import urlparse
import socketio
import uvicorn

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

from auth import (
    hash_password, verify_password, create_access_token, create_refresh_token,
    get_current_user, get_jwt_secret, JWT_ALGORITHM, seed_admin, attach_restaurant_context,
    check_brute_force, record_failed_login, clear_failed_logins,
    ACCESS_TOKEN_MAX_AGE_SECONDS, REFRESH_TOKEN_MAX_AGE_SECONDS
)
from subscription import (
    check_restaurant_subscription, get_restaurant_from_user,
    create_subscription_log, create_notification,
    check_and_expire_subscriptions, send_expiry_reminders,
    SUBSCRIPTION_PLANS, get_subscription_terms
)
from models import (
    LoginRequest, RegisterRequest, UserResponse, MenuItemCreate, MenuItemUpdate,
    TableCreate, CategoryCreate, CustomerSessionCreate, OrderCreate, CounterOrderCreate, OrderItemsUpdate, OrderResponse,
    PaymentCreate, CashAdjustmentCreate, AnalyticsResponse, RestaurantCreate, RestaurantUpdate, RestaurantProfileUpdate, SubscriptionRenew
)
from xlsx_export import build_xlsx_bytes, parse_xlsx_bytes
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
        "http://localhost:3000",
        "https://dineflo.in",
        "https://www.dineflo.in",
    ],
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
api_router = APIRouter(prefix="/api")

@app.get("/")
async def root_health():
    return {"status": "ok", "service": "restro-api"}


@app.get("/health")
async def health_check():
    return {"status": "healthy"}

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


async def get_restaurant_id_from_request(
    request: Request,
    restaurant_id: Optional[str] = None,
    customer_session_token: Optional[str] = None,
    table_id: Optional[str] = None,
):
    if restaurant_id:
        return restaurant_id
    if customer_session_token:
        session = await db.customer_sessions.find_one({"session_token": customer_session_token}, {"_id": 0, "restaurant_id": 1})
        if session and session.get("restaurant_id"):
            return session["restaurant_id"]

    if table_id:
        table = await db.tables.find_one({"table_id": table_id}, {"_id": 0, "restaurant_id": 1})
        if table and table.get("restaurant_id"):
            return table["restaurant_id"]
    try:
        _, resolved_restaurant_id = await resolve_restaurant_access(
            request,
            ["admin", "kitchen", "billing", "waiter"],
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


def normalize_excel_headers(row: list[str]) -> list[str]:
    return [str(value or "").strip().lower().replace(" ", "_") for value in row]


def parse_excel_objects(rows: list[list[str]]) -> list[dict]:
    if not rows:
        return []
    headers = normalize_excel_headers(rows[0])
    objects = []
    for row in rows[1:]:
        padded = row + [""] * max(0, len(headers) - len(row))
        row_obj = {
            header: str(value).strip()
            for header, value in zip(headers, padded)
            if header
        }
        if any(value for value in row_obj.values()):
            objects.append(row_obj)
    return objects


async def build_transaction_summary(restaurant_id: str, created_at_filter: dict):
    payment_query = {"restaurant_id": restaurant_id, "status": "completed"}
    if created_at_filter:
        payment_query["created_at"] = created_at_filter

    payments = await db.payments.find(payment_query, {"_id": 0}).sort("created_at", -1).to_list(5000)

    payment_summary = {
        "cash": 0.0,
        "upi": 0.0,
        "card": 0.0,
        "other": 0.0,
        "total_collected": 0.0,
        "payment_count": len(payments),
    }

    for payment in payments:
        amount = round(float(payment.get("total", 0) or 0), 2)
        method = (payment.get("payment_method") or "").strip().lower()
        if method not in {"cash", "upi", "card"}:
            method = "other"
        payment_summary[method] = round(payment_summary[method] + amount, 2)
        payment_summary["total_collected"] = round(payment_summary["total_collected"] + amount, 2)

    adjustment_query = {"restaurant_id": restaurant_id}
    if created_at_filter:
        adjustment_query["created_at"] = created_at_filter

    adjustments = await db.cash_adjustments.find(adjustment_query, {"_id": 0}).sort("created_at", -1).to_list(5000)
    total_adjustments = round(sum(float(item.get("amount", 0) or 0) for item in adjustments), 2)

    return {
        "payment_summary": payment_summary,
        "cash_adjustments": {
            "total_adjustments": total_adjustments,
            "entries": adjustments,
        },
    }


def parse_bool_env(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def get_cookie_settings(request: Optional[Request] = None) -> dict:
    forwarded_proto = request.headers.get("x-forwarded-proto") if request else None
    request_scheme = request.url.scheme if request else None
    secure_default = (forwarded_proto or request_scheme or "").lower() == "https"
    secure = parse_bool_env("COOKIE_SECURE", secure_default)
    same_site = os.environ.get("COOKIE_SAMESITE", "none" if secure else "lax").lower()
    if same_site == "none" and not secure:
        same_site = "lax"
    return {
        "httponly": True,
        "secure": secure,
        "samesite": same_site,
        "path": "/",
    }


def get_request_origin(request: Optional[Request]) -> Optional[str]:
    if not request:
        return None

    origin = request.headers.get("origin")
    if origin:
        return origin.rstrip("/")

    referer = request.headers.get("referer")
    if referer:
        parsed = urlparse(referer)
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"

    return None


def get_frontend_url(request: Optional[Request] = None) -> str:
    configured = os.environ.get("FRONTEND_URL", "").strip().rstrip("/")
    if configured:
        return configured

    request_origin = get_request_origin(request)
    if request_origin:
        return request_origin

    return "http://127.0.0.1:3000"


def build_cors_origins() -> list[str]:
    configured = [origin.strip() for origin in os.environ.get("CORS_ORIGINS", "").split(",") if origin.strip()]
    frontend_url = os.environ.get("FRONTEND_URL", "").strip().rstrip("/")

    if configured:
        return configured

    default_origins = {
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    }
    if frontend_url:
        default_origins.add(frontend_url)

    return sorted(default_origins)

# ============ Auth Endpoints ============
@api_router.post("/auth/register")
async def register(input: RegisterRequest, request: Request, response: Response):
    """Register new staff user - ONLY restaurant admins can create kitchen/billing/waiter staff"""
    email = input.email.lower()
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    # Validate role - only kitchen, billing, and waiter can be registered this way
    # Restaurant admins are created by super admin through restaurant creation
    if input.role not in ["kitchen", "billing", "waiter"]:
        raise HTTPException(status_code=400, detail="Invalid role. Only kitchen, billing, and waiter staff can be registered here.")
    
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
    
    cookie_settings = get_cookie_settings(request)
    response.set_cookie(key="access_token", value=access_token, max_age=ACCESS_TOKEN_MAX_AGE_SECONDS, **cookie_settings)
    response.set_cookie(key="refresh_token", value=refresh_token, max_age=REFRESH_TOKEN_MAX_AGE_SECONDS, **cookie_settings)
    
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
    
    cookie_settings = get_cookie_settings(request)
    response.set_cookie(key="access_token", value=access_token, max_age=ACCESS_TOKEN_MAX_AGE_SECONDS, **cookie_settings)
    response.set_cookie(key="refresh_token", value=refresh_token, max_age=REFRESH_TOKEN_MAX_AGE_SECONDS, **cookie_settings)
    
    response_user = await attach_restaurant_context(dict(user), db)
    return {
        "email": response_user["email"],
        "name": response_user["name"],
        "role": response_user["role"],
        "_id": response_user["_id"],
        "restaurant_id": response_user.get("restaurant_id"),
        "restaurant_name": response_user.get("restaurant_name"),
        "restaurant_gst_number": response_user.get("restaurant_gst_number")
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
    expires_at = datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
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
        **get_cookie_settings(request),
        max_age=REFRESH_TOKEN_MAX_AGE_SECONDS
    )
    
    user = await db.users.find_one({"_id": result.inserted_id if not user else user["_id"]})
    response_user = await attach_restaurant_context(dict(user), db)
    return {
       "access_token": access_token,   # ✅ ADD THIS
        "token_type": "bearer", 
        "email": response_user["email"],
        "name": response_user["name"],
        "role": response_user["role"],
        "_id": response_user["_id"],
        "restaurant_id": response_user.get("restaurant_id"),
        "restaurant_name": response_user.get("restaurant_name"),
        "restaurant_gst_number": response_user.get("restaurant_gst_number")
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
    subscription_amount = float(input.subscription_amount or 0)
    if subscription_amount <= 0:
        raise HTTPException(status_code=400, detail="Please enter a valid custom subscription amount.")  
    
    # Create restaurant
    restaurant_id = f"rest_{secrets.token_hex(8)}"
    subscription_terms = get_subscription_terms(input.plan, subscription_amount)
    
    restaurant_doc = {
        "restaurant_id": restaurant_id,
        "name": input.name,
        "owner_email": input.owner_email.lower(),
        "status": "ACTIVE",
        "plan": subscription_terms["name"],
        "subscription_amount": subscription_terms["price"],
        "subscriptionStart": datetime.now(timezone.utc),
        "subscriptionEnd": datetime.now(timezone.utc) + timedelta(days=subscription_terms["duration_days"]),
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
        {"plan": subscription_terms["name"], "subscription_amount": subscription_terms["price"], "created_by": "super_admin"},
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
        "subscription_amount": get_subscription_terms(input.plan).get("price", 0),
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
    if "subscription_amount" in update_data:
        update_data["subscription_amount"] = float(update_data["subscription_amount"] or 0)
        if update_data["subscription_amount"] <= 0:
            raise HTTPException(status_code=400, detail="Please enter a valid custom subscription amount.")
        update_data["plan"] = "CUSTOM"
    update_data["updated_at"] = datetime.now(timezone.utc)
    
    # If activating a pending restaurant
    if update_data.get("status") == "ACTIVE" and restaurant.get("approval_pending"):
        next_amount = update_data.get("subscription_amount", restaurant.get("subscription_amount"))
        subscription_terms = get_subscription_terms(update_data.get("plan", restaurant.get("plan")), next_amount)
        update_data["subscriptionStart"] = datetime.now(timezone.utc)
        update_data["subscriptionEnd"] = datetime.now(timezone.utc) + timedelta(days=subscription_terms["duration_days"])
        update_data["paymentStatus"] = "PAID"
        update_data["approval_pending"] = False
        update_data["plan"] = subscription_terms["name"]
        update_data["subscription_amount"] = subscription_terms["price"]
        
        # Create notification
        await create_notification(
            db, restaurant_id, "RESTAURANT_APPROVED",
            "Your restaurant has been approved! Your subscription is now active."
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
        subscription_terms = get_subscription_terms(rest.get("plan"), rest.get("subscription_amount"))
        mrr += subscription_terms["price"]
    
   
    
    return {
        "total_restaurants": total_restaurants,
        "active_restaurants": active_restaurants,
        "suspended_restaurants": suspended_restaurants,
        "expired_restaurants": expired_restaurants,
        "pending_approval": pending_approval,
        "total_revenue": total_revenue,
        "mrr": mrr
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
        "plan_details": get_subscription_terms(restaurant.get("plan"), restaurant.get("subscription_amount"))
    }

@api_router.get("/restaurant/profile")
async def get_restaurant_profile(request: Request):
    """Restaurant admin/staff views their restaurant profile details"""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "kitchen", "billing", "waiter"]:
        raise HTTPException(status_code=403, detail="Restaurant access required")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    restaurant = await db.restaurants.find_one(
        {"restaurant_id": restaurant_id},
        {"_id": 0, "restaurant_id": 1, "name": 1, "gst_number": 1, "google_review_url": 1}
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
    google_review_url = (input.google_review_url or "").strip() or None
    if gst_number and len(gst_number) > 30:
        raise HTTPException(status_code=400, detail="GST number must be 30 characters or fewer.")
    if google_review_url and not google_review_url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Google review link must start with http:// or https://")

    await db.restaurants.update_one(
        {"restaurant_id": restaurant_id},
        {"$set": {
            "gst_number": gst_number,
            "google_review_url": google_review_url,
            "updated_at": datetime.now(timezone.utc)
        }}
    )

    updated_restaurant = await db.restaurants.find_one(
        {"restaurant_id": restaurant_id},
        {"_id": 0, "restaurant_id": 1, "name": 1, "gst_number": 1, "google_review_url": 1}
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
    
    selected_plan = (input.plan or restaurant.get("plan") or "").strip().upper()
    custom_amount = restaurant.get("subscription_amount")
    if selected_plan in SUBSCRIPTION_PLANS:
        subscription_terms = get_subscription_terms(selected_plan)
    else:
        subscription_terms = get_subscription_terms("CUSTOM", custom_amount)
        if subscription_terms["price"] <= 0:
            raise HTTPException(status_code=400, detail="Subscription amount is not configured for this restaurant.")
    
    # Mock payment processing (in production, integrate actual gateway)
    payment_id = f"pay_{secrets.token_hex(8)}"
    payment_doc = {
        "payment_id": payment_id,
        "restaurant_id": restaurant_id,
        "amount": subscription_terms["price"],
        "payment_type": "SUBSCRIPTION",
        "payment_method": input.payment_method,
        "plan": subscription_terms["name"],
        "status": "SUCCESS",
        "created_at": datetime.now(timezone.utc)
    }
    await db.payments.insert_one(payment_doc)
    
    # Update subscription
    subscription_start = datetime.now(timezone.utc)
    subscription_end = subscription_start + timedelta(days=subscription_terms["duration_days"])
    
    await db.restaurants.update_one(
        {"restaurant_id": restaurant_id},
        {"$set": {
            "status": "ACTIVE",
            "plan": subscription_terms["name"],
            "subscription_amount": subscription_terms["price"],
            "subscriptionStart": subscription_start,
            "subscriptionEnd": subscription_end,
            "paymentStatus": "PAID",
            "updated_at": datetime.now(timezone.utc)
        }}
    )
    
    # Create log
    await create_subscription_log(
        db, restaurant_id, "SUBSCRIPTION_RENEWED",
        {"plan": subscription_terms["name"], "amount": subscription_terms["price"], "payment_id": payment_id},
        user["_id"]
    )
    
    # Create notification
    await create_notification(
        db, restaurant_id, "SUBSCRIPTION_RENEWED",
         f"Your subscription has been renewed successfully. Valid until {subscription_end.strftime('%Y-%m-%d')}."
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
    """Restaurant admin creates kitchen/billing/waiter staff"""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin"]:
        raise HTTPException(status_code=403, detail="Restaurant admin access required")
    
    # Get and verify restaurant
    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")
    
    await check_restaurant_subscription(db, restaurant_id)
    
    # Validate role - admin can only create kitchen, billing, and waiter
    if input.role not in ["kitchen", "billing", "waiter"]:
        raise HTTPException(status_code=400, detail="Can only create kitchen, billing, or waiter staff")
    
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
        {"restaurant_id": restaurant_id, "role": {"$in": ["kitchen", "billing", "waiter"]}},
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
    
    # Delete staff (only kitchen/billing/waiter)
    result = await db.users.delete_one({
        "email": email.lower(),
        "restaurant_id": restaurant_id,
        "role": {"$in": ["kitchen", "billing", "waiter"]}
    })
    
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Staff member not found")
    
    return {"message": "Staff member deleted successfully"}


# ============ Customer Session Endpoints ============
@api_router.post("/customer/session")
async def create_customer_session(input: CustomerSessionCreate):
    """Create customer session for table ordering"""
    customer_name = (input.customer_name or "").strip()
    phone = (input.phone or "").strip()
    if not customer_name:
        raise HTTPException(status_code=400, detail="Please enter your name.")
    if not phone:
        raise HTTPException(status_code=400, detail="Please enter your phone number.")

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
        "customer_name": customer_name,
        "phone": phone,
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
         "restaurant_id": session.get("restaurant_id"),
        "customer_name": session["customer_name"],
        "phone": session["phone"]
    }

# ============ Menu Endpoints ============
@api_router.get("/menu/categories")
async def get_categories(
    request: Request,
    restaurant_id: str = None,
    customer_session_token: str = None,
    table_id: str = None,
):
    """Get menu categories (public for customers, filtered by restaurant)"""
    resolved_restaurant_id = await get_restaurant_id_from_request(
        request,
        restaurant_id,
        customer_session_token=customer_session_token,
        table_id=table_id,
    )
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


@api_router.get("/menu/categories/export")
async def export_menu_categories(request: Request):
    _, restaurant_id = await resolve_restaurant_access(request, ["admin"])
    categories = await db.menu_categories.find(
        {"restaurant_id": restaurant_id},
        {"_id": 0, "name": 1, "order": 1, "created_at": 1}
    ).sort("order", 1).to_list(1000)

    workbook = build_xlsx_bytes(
        headers=["Category Name", "Display Order", "Created At"],
        rows=[
            [category.get("name", ""), category.get("order", 0), category.get("created_at")]
            for category in categories
        ],
        sheet_name="Categories",
    )

    return StreamingResponse(
        BytesIO(workbook),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="menu-categories.xlsx"'},
    )


@api_router.post("/menu/categories/import")
async def import_menu_categories(request: Request, file: UploadFile = File(...)):
    _, restaurant_id = await resolve_restaurant_access(request, ["admin"])
    if not file.filename.lower().endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="Please upload an .xlsx file for categories.")

    rows = parse_xlsx_bytes(await file.read())
    records = parse_excel_objects(rows)
    if not records:
        raise HTTPException(status_code=400, detail="The uploaded categories file is empty.")

    existing_categories = await db.menu_categories.find(
        {"restaurant_id": restaurant_id},
        {"_id": 0, "category_id": 1, "name": 1, "order": 1}
    ).sort("order", 1).to_list(1000)
    category_map = {category["name"].strip().lower(): category for category in existing_categories}
    next_order = (max((category.get("order", 0) for category in existing_categories), default=-1) + 1)

    created_count = 0
    updated_count = 0
    seen_names = set()

    for record in records:
        category_name = (record.get("category_name") or record.get("name") or "").strip()
        if not category_name:
            continue

        normalized_name = category_name.lower()
        if normalized_name in seen_names:
            continue
        seen_names.add(normalized_name)

        existing = category_map.get(normalized_name)
        if existing:
            await db.menu_categories.update_one(
                {"category_id": existing["category_id"], "restaurant_id": restaurant_id},
                {"$set": {"name": category_name}}
            )
            updated_count += 1
            continue

        category_doc = {
            "category_id": f"cat_{secrets.token_hex(6)}",
            "name": category_name,
            "order": next_order,
            "restaurant_id": restaurant_id,
            "created_at": datetime.now(timezone.utc)
        }
        next_order += 1
        await db.menu_categories.insert_one(category_doc)
        category_map[normalized_name] = category_doc
        created_count += 1

    return {
        "message": "Categories imported successfully.",
        "created": created_count,
        "updated": updated_count,
    }

@api_router.get("/menu/items")
async def get_menu_items(
    request: Request,
    restaurant_id: str = None,
    customer_session_token: str = None,
    table_id: str = None,
):
    """Get menu items - filtered by restaurant for customers"""
    resolved_restaurant_id = await get_restaurant_id_from_request(
        request,
        restaurant_id,
        customer_session_token=customer_session_token,
        table_id=table_id,
    )
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


@api_router.get("/menu/items/export")
async def export_menu_items(request: Request):
    _, restaurant_id = await resolve_restaurant_access(request, ["admin"])
    categories = await db.menu_categories.find(
        {"restaurant_id": restaurant_id},
        {"_id": 0, "category_id": 1, "name": 1}
    ).to_list(1000)
    category_name_map = {category["category_id"]: category["name"] for category in categories}

    items = await db.menu_items.find(
        {"restaurant_id": restaurant_id},
        {"_id": 0}
    ).to_list(5000)

    workbook = build_xlsx_bytes(
        headers=["Item Name", "Category Name", "Price", "Description", "Image URL", "Available"],
        rows=[
            [
                item.get("name", ""),
                category_name_map.get(item.get("category_id"), ""),
                item.get("price", 0),
                item.get("description", ""),
                item.get("image", ""),
                "Yes" if item.get("available", True) else "No",
            ]
            for item in items
        ],
        sheet_name="Menu Items",
    )

    return StreamingResponse(
        BytesIO(workbook),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="menu-items.xlsx"'},
    )


@api_router.post("/menu/items/import")
async def import_menu_items(request: Request, file: UploadFile = File(...)):
    _, restaurant_id = await resolve_restaurant_access(request, ["admin"])
    if not file.filename.lower().endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="Please upload an .xlsx file for menu items.")

    rows = parse_xlsx_bytes(await file.read())
    records = parse_excel_objects(rows)
    if not records:
        raise HTTPException(status_code=400, detail="The uploaded menu items file is empty.")

    categories = await db.menu_categories.find(
        {"restaurant_id": restaurant_id},
        {"_id": 0, "category_id": 1, "name": 1}
    ).to_list(1000)
    category_map = {category["name"].strip().lower(): category for category in categories}
    if not category_map:
        raise HTTPException(status_code=400, detail="Please import or create categories before importing menu items.")

    missing_categories = sorted({
        (record.get("category_name") or record.get("category") or "").strip()
        for record in records
        if (record.get("category_name") or record.get("category") or "").strip()
        and (record.get("category_name") or record.get("category") or "").strip().lower() not in category_map
    })
    if missing_categories:
        raise HTTPException(
            status_code=400,
            detail=f"These category names were not found: {', '.join(missing_categories)}"
        )

    existing_items = await db.menu_items.find(
        {"restaurant_id": restaurant_id},
        {"_id": 0, "item_id": 1, "name": 1, "category_id": 1}
    ).to_list(5000)
    item_map = {
        (item["name"].strip().lower(), item.get("category_id")): item
        for item in existing_items
    }

    created_count = 0
    updated_count = 0

    for record in records:
        item_name = (record.get("item_name") or record.get("name") or "").strip()
        category_name = (record.get("category_name") or record.get("category") or "").strip()
        price_raw = (record.get("price") or "").strip()
        if not item_name or not category_name or not price_raw:
            continue

        try:
            price = float(price_raw)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid price for item '{item_name}'.")

        if price <= 0:
            raise HTTPException(status_code=400, detail=f"Price must be greater than zero for item '{item_name}'.")

        category = category_map[category_name.lower()]
        description = (record.get("description") or "").strip()
        image = (record.get("image_url") or record.get("image") or "").strip()
        available_raw = (record.get("available") or "yes").strip().lower()
        available = available_raw not in {"no", "false", "0"}

        existing_item = item_map.get((item_name.lower(), category["category_id"]))
        if existing_item:
            await db.menu_items.update_one(
                {"item_id": existing_item["item_id"], "restaurant_id": restaurant_id},
                {"$set": {
                    "name": item_name,
                    "category_id": category["category_id"],
                    "price": price,
                    "description": description,
                    "image": image,
                    "available": available,
                }}
            )
            updated_count += 1
            continue

        item_doc = {
            "item_id": f"item_{secrets.token_hex(8)}",
            "name": item_name,
            "category_id": category["category_id"],
            "price": price,
            "description": description,
            "image": image,
            "available": available,
            "restaurant_id": restaurant_id,
            "created_at": datetime.now(timezone.utc)
        }
        await db.menu_items.insert_one(item_doc)
        created_count += 1

    return {
        "message": "Menu items imported successfully.",
        "created": created_count,
        "updated": updated_count,
    }

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
async def get_tables(
    request: Request = None,
    restaurant_id: str = None,
    customer_session_token: str = None,
    table_id: str = None,
):
    """Get tables - filtered by restaurant for staff, or by restaurant_id param for customers"""
    resolved_restaurant_id = await get_restaurant_id_from_request(
        request,
        restaurant_id,
        customer_session_token=customer_session_token,
        table_id=table_id,
    )
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
    
    # Prefer the actual admin app origin so generated QR codes stay valid in prod.
    frontend_url = get_frontend_url(request)
    
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
            cloned["table_label"] = cloned.get("table_label") or cloned.get("table_id")
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


async def upsert_customer_record(restaurant_id: str, customer_name: str, phone: Optional[str]):
    normalized_phone = (phone or "").strip()
    if not normalized_phone:
        return

    customer_data = {
        "customer_name": customer_name,
        "phone": normalized_phone,
        "restaurant_id": restaurant_id,
        "last_visit": datetime.now(timezone.utc)
    }

    existing_customer = await db.customers.find_one({
        "phone": normalized_phone,
        "restaurant_id": restaurant_id
    })

    if existing_customer:
        await db.customers.update_one(
            {"phone": normalized_phone, "restaurant_id": restaurant_id},
            {
                "$set": customer_data,
                "$inc": {"total_orders": 1}
            }
        )
    else:
        customer_data["total_orders"] = 1
        customer_data["created_at"] = datetime.now(timezone.utc)
        await db.customers.insert_one(customer_data)

async def build_order_bill_summary(order_doc):
    payment = order_doc.get("payment")
    if not payment:
        return None

    bill_order_ids = payment.get("order_ids") or ([payment.get("order_id")] if payment.get("order_id") else [])
    if not bill_order_ids:
        return None

    bill_orders = await db.orders.find(
        {
            "order_id": {"$in": bill_order_ids},
            "restaurant_id": order_doc.get("restaurant_id"),
        },
        {"_id": 0}
    ).sort("created_at", 1).to_list(len(bill_order_ids))
    if not bill_orders:
        return None

    enriched_bill_orders = await enrich_orders(bill_orders)
    restaurant = None
    if order_doc.get("restaurant_id"):
        restaurant = await db.restaurants.find_one(
            {"restaurant_id": order_doc["restaurant_id"]},
            {"_id": 0, "name": 1, "gst_number": 1, "google_review_url": 1}
        )

    return {
        "bill_id": payment.get("bill_id") or payment.get("payment_id"),
        "payment": payment,
        "orders": enriched_bill_orders,
        "restaurant_name": restaurant.get("name") if restaurant else None,
        "restaurant_gst_number": restaurant.get("gst_number") if restaurant else None,
        "google_review_url": restaurant.get("google_review_url") if restaurant else None,
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
    
    await upsert_customer_record(restaurant_id, session["customer_name"], session["phone"])
    
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


@api_router.post("/counter/orders")
async def create_counter_order(input: CounterOrderCreate, request: Request):
    """Create dine-in or takeaway orders directly from the billing counter."""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "billing", "waiter"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    await check_restaurant_subscription(db, restaurant_id)

    order_type = (input.order_type or "dine_in").strip().lower()
    if order_type not in ["dine_in", "takeaway"]:
        raise HTTPException(status_code=400, detail="order_type must be dine_in or takeaway")

    customer_name = (input.customer_name or "").strip()
    phone = (input.phone or "").strip()
    if not customer_name:
        raise HTTPException(status_code=400, detail="Please enter customer name.")
    if not input.items:
        raise HTTPException(status_code=400, detail="Please add at least one item.")

    table = None
    table_id = None
    table_number = None
    table_label = None

    if order_type == "dine_in":
        table_id = (input.table_id or "").strip()
        if not table_id:
            raise HTTPException(status_code=400, detail="Please select a table for dine-in order.")
        table = await db.tables.find_one({"table_id": table_id, "restaurant_id": restaurant_id}, {"_id": 0})
        if not table:
            raise HTTPException(status_code=404, detail="Selected table not found.")
        table_number = table.get("table_number")
        table_label = f"Table {table_number}" if table_number is not None else table_id
    else:
        table_id = f"takeaway_{secrets.token_hex(6)}"
        table_label = f"Takeaway {customer_name}"

    existing_active_orders = await db.orders.find({
        "table_id": table_id,
        "restaurant_id": restaurant_id,
        "status": {"$nin": ["served", "cancelled"]}
    }, {"_id": 0, "order_id": 1, "status": 1, "created_at": 1}).sort("created_at", -1).to_list(50)

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

    order_doc = {
        "order_id": f"ORD{secrets.token_hex(6).upper()}",
        "table_id": table_id,
        "table_number": table_number,
        "table_label": table_label,
        "restaurant_id": restaurant_id,
        "customer_name": customer_name,
        "phone": phone,
        "items": order_items,
        "total": round(total, 2),
        "status": "pending",
        "payment_status": "pending",
        "is_add_on": bool(latest_active_order),
        "add_on_to_order_id": latest_active_order["order_id"] if latest_active_order else None,
        "priority": "high" if latest_active_order and prioritized_add_on else "normal",
        "order_type": order_type,
        "order_source": "waiter" if user["role"] == "waiter" else "billing_counter",
        "created_by_role": user["role"],
        "created_by_name": user.get("name") or user.get("email"),
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
        "timestamps": {
            "pending": datetime.now(timezone.utc).isoformat()
        }
    }
    await db.orders.insert_one(order_doc)
    await upsert_customer_record(restaurant_id, customer_name, phone)

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
    if user["role"] not in ["admin", "kitchen", "billing", "waiter"]:
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
        response_order["bill_summary"] = await build_order_bill_summary(response_order)

    return response_order
    
@api_router.get("/admin/orders/search")
async def search_order(order_id: str, request: Request):
    """Restaurant admin searches an order by order ID"""
    user = await get_current_user(request, db)
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Restaurant admin access required")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    normalized_order_id = (order_id or "").strip()
    if not normalized_order_id:
        raise HTTPException(status_code=400, detail="Please enter an order ID to search.")

    order = await db.orders.find_one(
        {"order_id": normalized_order_id, "restaurant_id": restaurant_id},
        {"_id": 0}
    )
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    enriched = await enrich_orders([order])
    return enriched[0]

@api_router.put("/orders/{order_id}/items")
async def update_order_items(order_id: str, input: OrderItemsUpdate, request: Request):
    """Update order items before billing"""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "billing"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    if not input.items:
        raise HTTPException(status_code=400, detail="Please keep at least one item in the order.")

    order = await db.orders.find_one({"order_id": order_id, "restaurant_id": restaurant_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if order.get("payment_status") == "completed":
        raise HTTPException(status_code=400, detail="Completed bills cannot be edited.")

    existing_item_ids = {item.get("item_id") for item in order.get("items", [])}
    requested_item_ids = [item.item_id for item in input.items]
    if any(item_id not in existing_item_ids for item_id in requested_item_ids):
        raise HTTPException(status_code=400, detail="Only items already in the order can be edited.")

    menu_items = await db.menu_items.find(
        {"item_id": {"$in": requested_item_ids}, "restaurant_id": restaurant_id},
        {"_id": 0, "item_id": 1, "name": 1, "price": 1}
    ).to_list(len(requested_item_ids))
    menu_item_map = {item["item_id"]: item for item in menu_items}
    if len(menu_item_map) != len(set(requested_item_ids)):
        raise HTTPException(status_code=404, detail="One or more menu items were not found.")

    updated_items = []
    total = 0
    for item in input.items:
        menu_item = menu_item_map[item.item_id]
        updated_item = {
            "item_id": menu_item["item_id"],
            "name": menu_item["name"],
            "quantity": item.quantity,
            "price": menu_item["price"],
            "instructions": (item.instructions or "").strip(),
        }
        updated_items.append(updated_item)
        total += updated_item["quantity"] * updated_item["price"]

    await db.orders.update_one(
        {"order_id": order_id, "restaurant_id": restaurant_id},
        {"$set": {
            "items": updated_items,
            "total": round(total, 2),
            "updated_at": datetime.now(timezone.utc),
        }}
    )

    updated_order = await db.orders.find_one({"order_id": order_id, "restaurant_id": restaurant_id}, {"_id": 0})
    enriched = await enrich_orders([updated_order])
    await sio.emit('order_status_updated', to_socket_payload(enriched[0]), room=f'restaurant_{restaurant_id}')
    await sio.emit('order_status_updated', to_socket_payload(enriched[0]), room=f'order_{order_id}')
    return enriched[0]
    
@api_router.delete("/admin/orders/{order_id}")
async def delete_order_admin(order_id: str, request: Request):
    """Restaurant admin deletes an order and unlinks it from any bill"""
    user = await get_current_user(request, db)
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Restaurant admin access required")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    order = await db.orders.find_one({"order_id": order_id, "restaurant_id": restaurant_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    payment = await db.payments.find_one(
        {
            "restaurant_id": restaurant_id,
            "$or": [
                {"order_id": order_id},
                {"order_ids": order_id},
            ]
        },
        {"_id": 0}
    )

    if payment:
        linked_order_ids = payment.get("order_ids") or ([payment.get("order_id")] if payment.get("order_id") else [])
        remaining_order_ids = [linked_order_id for linked_order_id in linked_order_ids if linked_order_id != order_id]

        if remaining_order_ids:
            remaining_orders = await db.orders.find(
                {"order_id": {"$in": remaining_order_ids}, "restaurant_id": restaurant_id},
                {"_id": 0, "total": 1}
            ).to_list(len(remaining_order_ids))
            remaining_subtotal = round(sum(item.get("total", 0) for item in remaining_orders), 2)
            remaining_tax = round(remaining_subtotal * 0.05, 2)
            discount = payment.get("discount", 0) or 0
            await db.payments.update_one(
                {"payment_id": payment["payment_id"], "restaurant_id": restaurant_id},
                {"$set": {
                    "order_id": remaining_order_ids[0],
                    "order_ids": remaining_order_ids,
                    "subtotal": remaining_subtotal,
                    "tax": remaining_tax,
                    "total": remaining_subtotal + remaining_tax - discount,
                    "updated_at": datetime.now(timezone.utc),
                }}
            )
        else:
            await db.payments.delete_one({"payment_id": payment["payment_id"], "restaurant_id": restaurant_id})

    result = await db.orders.delete_one({"order_id": order_id, "restaurant_id": restaurant_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Order not found")

    await sio.emit('order_deleted', {
        "order_id": order_id,
        "restaurant_id": restaurant_id,
        "table_id": order.get("table_id"),
    }, room=f'restaurant_{restaurant_id}')
    await sio.emit('order_deleted', {
        "order_id": order_id,
        "restaurant_id": restaurant_id,
        "table_id": order.get("table_id"),
    }, room=f'order_{order_id}')

    return {"message": "Order deleted successfully"}

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


@api_router.post("/cash-adjustments")
async def create_cash_adjustment(input: CashAdjustmentCreate, request: Request):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "billing"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    if not input.reason.strip():
        raise HTTPException(status_code=400, detail="Please enter an adjustment reason.")
    if float(input.amount) == 0:
        raise HTTPException(status_code=400, detail="Adjustment amount cannot be zero.")

    adjustment_doc = {
        "adjustment_id": f"ADJ{secrets.token_hex(6).upper()}",
        "restaurant_id": restaurant_id,
        "amount": round(float(input.amount), 2),
        "reason": input.reason.strip(),
        "created_at": datetime.now(timezone.utc),
        "created_by": user["_id"],
        "created_by_name": user.get("name") or user.get("email") or "Staff",
        "created_by_role": user.get("role"),
    }
    await db.cash_adjustments.insert_one(adjustment_doc)
    return {k: v for k, v in adjustment_doc.items() if k != "_id"}

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
    if user["role"] not in ["admin", "billing"]:
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

    created_at_filter = {"$gte": start_date}
    
    # CRITICAL: Filter by restaurant_id for data isolation
    # Aggregate data
    pipeline = [
        {"$match": {
            "restaurant_id": restaurant_id,
            "created_at": created_at_filter,
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
    transaction_summary = await build_transaction_summary(restaurant_id, created_at_filter)
    adjustment_total = round(transaction_summary["cash_adjustments"].get("total_adjustments", 0), 2)
    billed_revenue = round(transaction_summary["payment_summary"].get("total_collected", 0), 2)
    
    if not result:
        return {
            "total_orders": 0,
            "total_revenue": round(billed_revenue + adjustment_total, 2),
            "avg_order_value": 0,
            "top_items": [],
            "peak_hours": [],
            "occupied_tables": occupied_tables,
            "empty_tables": empty_tables,
            "recent_sales": [],
            "best_seller": None,
            "payment_summary": transaction_summary["payment_summary"],
            "cash_adjustments": transaction_summary["cash_adjustments"],
        }
    
    # Top selling items for this restaurant only
    top_items_pipeline = [
        {"$match": {
            "restaurant_id": restaurant_id,
            "created_at": created_at_filter,
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
            "created_at": created_at_filter,
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

    adjusted_revenue = round(billed_revenue + adjustment_total, 2)
    adjusted_avg_order_value = round(
        adjusted_revenue / result[0]["total_orders"],
        2,
    ) if result[0]["total_orders"] else 0
    
    return {
        "total_orders": result[0]["total_orders"],
        "total_revenue": adjusted_revenue,
        "avg_order_value": adjusted_avg_order_value,
        "top_items": [{"name": item["_id"], "quantity": item["quantity"], "revenue": item["revenue"]} for item in top_items],
        "peak_hours": [],
        "occupied_tables": occupied_tables,
        "empty_tables": empty_tables,
        "recent_sales": recent_sales,
        "best_seller": best_seller,
        "payment_summary": transaction_summary["payment_summary"],
        "cash_adjustments": transaction_summary["cash_adjustments"],
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
            (order.get("payment", {}).get("payment_method") or "").upper(),
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
            "Payment Mode",
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
    allow_origins=build_cors_origins(),
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
        await db.cash_adjustments.create_index([("restaurant_id", 1), ("created_at", -1)])
        
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
