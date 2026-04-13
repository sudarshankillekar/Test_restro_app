from fastapi import FastAPI, APIRouter, HTTPException, Request, Response, Depends
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from datetime import datetime, timezone, timedelta
import socketio
import uvicorn

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

from auth import (
    hash_password, verify_password, create_access_token, create_refresh_token,
    get_current_user, get_jwt_secret, JWT_ALGORITHM, seed_admin,
    check_brute_force, record_failed_login, clear_failed_logins
)
from models import (
    LoginRequest, RegisterRequest, UserResponse, MenuItemCreate, MenuItemUpdate,
    TableCreate, CategoryCreate, CustomerSessionCreate, OrderCreate, OrderResponse,
    PaymentCreate, AnalyticsResponse
)
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
api_router = APIRouter(prefix="/api")

# Socket.IO ASGI app
socket_app = socketio.ASGIApp(sio, app)

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

# ============ Auth Endpoints ============
@api_router.post("/auth/register")
async def register(input: RegisterRequest, response: Response):
    email = input.email.lower()
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    
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
    
    await clear_failed_logins(db, client_ip, email)
    
    user_id = str(user["_id"])
    access_token = create_access_token(user_id, email)
    refresh_token = create_refresh_token(user_id)
    
    response.set_cookie(key="access_token", value=access_token, httponly=True, secure=False, samesite="lax", max_age=900, path="/")
    response.set_cookie(key="refresh_token", value=refresh_token, httponly=True, secure=False, samesite="lax", max_age=604800, path="/")
    
    return {"email": user["email"], "name": user["name"], "role": user["role"], "_id": user_id}

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
    
    user = await db.users.find_one({"_id": result.inserted_id if not user else user["_id"]})
    return {"email": user["email"], "name": user["name"], "role": user["role"], "_id": str(user["_id"])}

# ============ Customer Session Endpoints ============
@api_router.post("/customer/session")
async def create_customer_session(input: CustomerSessionCreate):
    """Create customer session for table ordering"""
    # Verify table exists
    table = await db.tables.find_one({"table_id": input.table_id})
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")
    
    session_token = secrets.token_urlsafe(32)
    session_doc = {
        "session_token": session_token,
        "table_id": input.table_id,
        "customer_name": input.customer_name,
        "phone": input.phone,
        "created_at": datetime.now(timezone.utc),
        "expires_at": datetime.now(timezone.utc) + timedelta(hours=4)
    }
    await db.customer_sessions.insert_one(session_doc)
    
    return {"session_token": session_token, "table_id": input.table_id}

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
async def get_categories():
    categories = await db.menu_categories.find({}, {"_id": 0}).sort("order", 1).to_list(100)
    return categories

@api_router.post("/menu/categories")
async def create_category(input: CategoryCreate, request: Request):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    # Get max order
    last_cat = await db.menu_categories.find_one({}, sort=[("order", -1)])
    order = (last_cat["order"] + 1) if last_cat else 0
    
    cat_doc = {
        "category_id": f"cat_{secrets.token_hex(6)}",
        "name": input.name,
        "order": order,
        "created_at": datetime.now(timezone.utc)
    }
    await db.menu_categories.insert_one(cat_doc)
    return {k: v for k, v in cat_doc.items() if k != "_id"}

@api_router.get("/menu/items")
async def get_menu_items():
    items = await db.menu_items.find({}, {"_id": 0}).to_list(1000)
    return items

@api_router.post("/menu/items")
async def create_menu_item(input: MenuItemCreate, request: Request):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    item_doc = {
        "item_id": f"item_{secrets.token_hex(8)}",
        "name": input.name,
        "category_id": input.category_id,
        "price": input.price,
        "description": input.description or "",
        "image": input.image or "",
        "available": True,
        "created_at": datetime.now(timezone.utc)
    }
    await db.menu_items.insert_one(item_doc)
    return {k: v for k, v in item_doc.items() if k != "_id"}

@api_router.put("/menu/items/{item_id}")
async def update_menu_item(item_id: str, input: MenuItemUpdate, request: Request):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    update_data = {k: v for k, v in input.model_dump().items() if v is not None}
    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")
    
    result = await db.menu_items.update_one({"item_id": item_id}, {"$set": update_data})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Item not found")
    
    item = await db.menu_items.find_one({"item_id": item_id}, {"_id": 0})
    return item

@api_router.delete("/menu/items/{item_id}")
async def delete_menu_item(item_id: str, request: Request):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    result = await db.menu_items.delete_one({"item_id": item_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Item not found")
    
    return {"message": "Item deleted successfully"}

# ============ Table Endpoints ============
@api_router.get("/tables")
async def get_tables():
    tables = await db.tables.find({}, {"_id": 0}).sort("table_number", 1).to_list(1000)
    return tables

@api_router.post("/tables")
async def create_table(input: TableCreate, request: Request):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    table_id = f"table_{secrets.token_hex(6)}"
    table_doc = {
        "table_id": table_id,
        "table_number": input.table_number,
        "status": "available",
        "qr_code": f"{os.environ.get('FRONTEND_URL', 'http://localhost:3000')}/customer/{table_id}",
        "created_at": datetime.now(timezone.utc)
    }
    await db.tables.insert_one(table_doc)
    return {k: v for k, v in table_doc.items() if k != "_id"}

# ============ Order Endpoints ============
@api_router.post("/orders")
async def create_order(input: OrderCreate):
    """Create new order (customer or merged table order)"""
    # Verify customer session
    session = await db.customer_sessions.find_one({"session_token": input.customer_session_token})
    if not session:
        raise HTTPException(status_code=401, detail="Invalid session")
    
    # Idempotency check
    existing = await db.orders.find_one({
        "table_id": session["table_id"],
        "status": {"$nin": ["served", "cancelled"]}
    })
    
    order_id = f"ORD{secrets.token_hex(6).upper()}"
    
    # Calculate total
    total = 0
    order_items = []
    for item in input.items:
        menu_item = await db.menu_items.find_one({"item_id": item.item_id}, {"_id": 0})
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
    
    if existing:
        # Merge with existing order
        await db.orders.update_one(
            {"order_id": existing["order_id"]},
            {
                "$push": {"items": {"$each": order_items}},
                "$inc": {"total": total},
                "$set": {"updated_at": datetime.now(timezone.utc)}
            }
        )
        order = await db.orders.find_one({"order_id": existing["order_id"]}, {"_id": 0})
        await sio.emit('order_updated', order, room='kitchen')
        return order
    else:
        # Create new order
        order_doc = {
            "order_id": order_id,
            "table_id": session["table_id"],
            "customer_name": session["customer_name"],
            "phone": session["phone"],
            "items": order_items,
            "total": total,
            "status": "pending",
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
            "timestamps": {
                "pending": datetime.now(timezone.utc).isoformat()
            }
        }
        await db.orders.insert_one(order_doc)
        
        # Emit to kitchen
        await sio.emit('new_order', {k: v for k, v in order_doc.items() if k != "_id"}, room='kitchen')
        
        return {k: v for k, v in order_doc.items() if k != "_id"}

@api_router.get("/orders")
async def get_orders(request: Request, status: str = None):
    """Get all orders (kitchen/billing dashboard - requires auth)"""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "kitchen", "billing"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    query = {}
    if status:
        query["status"] = status
    
    orders = await db.orders.find(query, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return orders

@api_router.get("/orders/{order_id}")
async def get_order(order_id: str):
    """Get single order (customer tracking)"""
    order = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return order

@api_router.put("/orders/{order_id}/status")
async def update_order_status(order_id: str, request: Request):
    """Update order status (kitchen/billing - requires auth)"""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "kitchen", "billing"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    data = await request.json()
    new_status = data.get("status")
    
    if new_status not in ["accepted", "preparing", "ready", "served", "cancelled"]:
        raise HTTPException(status_code=400, detail="Invalid status")
    
    order = await db.orders.find_one({"order_id": order_id})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    
    # Update timestamps
    timestamps = order.get("timestamps", {})
    timestamps[new_status] = datetime.now(timezone.utc).isoformat()
    
    await db.orders.update_one(
        {"order_id": order_id},
        {
            "$set": {
                "status": new_status,
                "timestamps": timestamps,
                "updated_at": datetime.now(timezone.utc)
            }
        }
    )
    
    updated_order = await db.orders.find_one({"order_id": order_id}, {"_id": 0})
    
    # Emit status update to all clients
    await sio.emit('order_status_updated', updated_order)
    
    return updated_order

# ============ Payment Endpoints ============
@api_router.post("/payments")
async def create_payment(input: PaymentCreate, request: Request):
    """Create payment (billing/admin - requires auth)"""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "billing"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    order = await db.orders.find_one({"order_id": input.order_id})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    
    # Calculate tax (18% GST)
    subtotal = order["total"]
    tax = round(subtotal * 0.18, 2)
    total = subtotal + tax
    
    payment_doc = {
        "payment_id": f"PAY{secrets.token_hex(6).upper()}",
        "order_id": input.order_id,
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
    
    # Update order status to served
    await db.orders.update_one(
        {"order_id": input.order_id},
        {"$set": {"status": "served", "updated_at": datetime.now(timezone.utc)}}
    )
    
    return {k: v for k, v in payment_doc.items() if k != "_id"}

@api_router.get("/payments/{order_id}")
async def get_payment(order_id: str):
    payment = await db.payments.find_one({"order_id": order_id}, {"_id": 0})
    if not payment:
        raise HTTPException(status_code=404, detail="Payment not found")
    return payment

# ============ Analytics Endpoints ============
@api_router.get("/analytics/dashboard")
async def get_analytics(request: Request, period: str = "daily"):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
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
    
    # Aggregate data
    pipeline = [
        {"$match": {"created_at": {"$gte": start_date}, "status": "served"}},
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
    
    if not result:
        return {
            "total_orders": 0,
            "total_revenue": 0,
            "avg_order_value": 0,
            "top_items": [],
            "peak_hours": []
        }
    
    # Top selling items
    top_items_pipeline = [
        {"$match": {"created_at": {"$gte": start_date}, "status": "served"}},
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
    
    return {
        "total_orders": result[0]["total_orders"],
        "total_revenue": round(result[0]["total_revenue"], 2),
        "avg_order_value": round(result[0]["avg_order_value"], 2),
        "top_items": [{"name": item["_id"], "quantity": item["quantity"], "revenue": item["revenue"]} for item in top_items],
        "peak_hours": []
    }

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
    await seed_admin(db)
    
    # Create indexes
    await db.users.create_index("email", unique=True)
    await db.tables.create_index("table_id", unique=True)
    await db.menu_items.create_index("item_id", unique=True)
    await db.orders.create_index("order_id", unique=True)
    await db.customer_sessions.create_index("session_token", unique=True)
    
    logging.info("Database indexes created")
    logging.info("Admin user seeded")

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)
