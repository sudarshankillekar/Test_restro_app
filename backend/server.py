from fastapi import FastAPI, APIRouter, HTTPException, Request, Response, UploadFile, File
from fastapi.encoders import jsonable_encoder
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import StreamingResponse
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import DuplicateKeyError
import os
import logging
import base64
import hashlib
import json
from pathlib import Path
from datetime import datetime, timezone, timedelta
from io import BytesIO
from typing import Optional
from urllib.parse import urlparse
import asyncio
import socket
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
    TableCreate, CategoryCreate, CustomerSessionCreate, OrderCreate, CounterOrderCreate, OrderItemsUpdate, OrderItemCancelRequest, OrderResponse,
    PaymentCreate, PosCheckoutCreate, PosBillUpdate, PosBillDeleteRequest, CashAdjustmentCreate, CashDrawerOpeningCreate,
    AttendanceSettingsUpdate, AttendanceShiftCreate, AttendanceShiftUpdate, AttendanceProfileShiftAssign, AttendanceEnrollRequest, AttendancePunchRequest,
    AnalyticsResponse, RestaurantCreate, RestaurantUpdate, RestaurantProfileUpdate, SubscriptionRenew
)
from xlsx_export import build_xlsx_bytes, parse_xlsx_bytes
from whatsapp_billing import send_bill_pdf_via_evolution
import jwt
import secrets

try:
    from cryptography.fernet import Fernet
except ImportError:
    Fernet = None

BUSINESS_TIMEZONE = timezone(timedelta(hours=5, minutes=30))
DEFAULT_RESTAURANT_ACCESS_CONFIG = {
    "pos_enabled": True,
    "kitchen_enabled": True,
    "kitchen_tv_enabled": True,
    "billing_enabled": True,
    "waiter_enabled": True,
    "kitchen_billing_enabled": True,
    "staff_management_enabled": True,
    "table_management_enabled": True,
    "max_tables": None,
    "max_staff": None,
}
STAFF_ROLE_ACCESS_KEYS = {
    "pos": "pos_enabled",
    "kitchen": "kitchen_enabled",
    "kitchen_tv": "kitchen_tv_enabled",
    "billing": "billing_enabled",
    "waiter": "waiter_enabled",
    "kitchen_billing": "kitchen_billing_enabled",
}
STAFF_ROLES = list(STAFF_ROLE_ACCESS_KEYS.keys())
MENU_DIET_TYPES = {"veg", "non_veg", "egg", "vegan"}
ATTENDANCE_MANAGER_ROLES = ["admin", "billing", "kitchen_billing"]
ATTENDANCE_KIOSK_ROLES = ["admin", "billing", "kitchen_billing", "kitchen", "waiter", "pos"]
ASSISTANCE_STAFF_ROLES = ["admin", "billing", "kitchen_billing", "waiter", "pos"]
ATTENDANCE_PUNCH_TYPES = ["clock_in", "clock_out", "break_in", "break_out"]
DEFAULT_ATTENDANCE_SETTINGS = {
    "shift_start": "10:00",
    "shift_end": "22:00",
    "grace_minutes": 10,
    "overtime_after_hours": 9,
    "confidence_threshold": 0.68,
    "snapshot_audit_enabled": False,
    "pin_fallback_enabled": True,
}
LOCAL_NETWORK_CORS_REGEX = (
    r"^https://.*\.vercel\.app$"
    r"|^https?://("
    r"localhost"
    r"|127\.0\.0\.1"
    r"|192\.168\.\d{1,3}\.\d{1,3}"
    r"|10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
    r"|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}"
    r")(:\d+)?$"
)

def normalize_access_config(access_config: Optional[dict] = None) -> dict:
    normalized = dict(DEFAULT_RESTAURANT_ACCESS_CONFIG)
    if isinstance(access_config, dict):
        for key in normalized:
            if key in access_config:
                normalized[key] = access_config[key]

    for key in [
        "pos_enabled",
        "kitchen_enabled",
        "kitchen_tv_enabled",
        "billing_enabled",
        "waiter_enabled",
        "kitchen_billing_enabled",
        "staff_management_enabled",
        "table_management_enabled",
    ]:
        normalized[key] = bool(normalized.get(key, True))

    for key in ["max_tables", "max_staff"]:
        value = normalized.get(key)
        if value in [None, ""]:
            normalized[key] = None
        else:
            try:
                normalized[key] = int(value)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail=f"{key} must be a number or empty.")
            if normalized[key] < 0:
                raise HTTPException(status_code=400, detail=f"{key} cannot be negative.")

    return normalized

def ensure_access_flag(access_config: dict, key: str, label: str):
    if not normalize_access_config(access_config).get(key, True):
        raise HTTPException(status_code=403, detail=f"{label} is disabled for this restaurant. Contact super admin.")

async def get_restaurant_access_config(restaurant_id: str) -> dict:
    restaurant = await db.restaurants.find_one(
        {"restaurant_id": restaurant_id},
        {"_id": 0, "access_config": 1},
    )
    if not restaurant:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    return normalize_access_config(restaurant.get("access_config"))

async def get_staff_management_restaurant(restaurant_id: str) -> dict:
    try:
        return await check_restaurant_subscription(db, restaurant_id)
    except HTTPException as error:
        if error.status_code == 404 and error.detail == "Restaurant not found":
            logging.warning(
                "Restaurant %s missing while managing staff; using legacy default access config.",
                restaurant_id,
            )
            return {
                "restaurant_id": restaurant_id,
                "access_config": normalize_access_config(),
            }
        raise

async def ensure_staff_creation_allowed(restaurant_id: str, role: str, access_config: Optional[dict] = None):
    access_config = normalize_access_config(access_config) if access_config is not None else await get_restaurant_access_config(restaurant_id)
    ensure_access_flag(access_config, "staff_management_enabled", "Staff management")
    role_access_key = STAFF_ROLE_ACCESS_KEYS.get(role)
    if role_access_key:
        ensure_access_flag(access_config, role_access_key, role.replace("_", " ").title())

    max_staff = access_config.get("max_staff")
    if max_staff is not None:
        staff_count = await db.users.count_documents({
            "restaurant_id": restaurant_id,
            "role": {"$in": STAFF_ROLES},
        })
        if staff_count >= max_staff:
            raise HTTPException(status_code=403, detail=f"Staff limit reached. Max staff allowed: {max_staff}.")

async def ensure_table_creation_allowed(restaurant_id: str):
    access_config = await get_restaurant_access_config(restaurant_id)
    ensure_access_flag(access_config, "table_management_enabled", "Table management")

    max_tables = access_config.get("max_tables")
    if max_tables is not None:
        table_count = await db.tables.count_documents({"restaurant_id": restaurant_id})
        if table_count >= max_tables:
            raise HTTPException(status_code=403, detail=f"Table limit reached. Max tables allowed: {max_tables}.")

def schedule_background_task(coro):
    task = asyncio.create_task(coro)

    def log_background_error(done_task):
        try:
            done_task.result()
        except Exception as exc:
            logging.warning("Background task failed: %s", exc)

    task.add_done_callback(log_background_error)
    return task

async def emit_order_event(event_name: str, payload: dict, restaurant_id: str, order_id: Optional[str] = None):
    emits = [sio.emit(event_name, payload, room=f'restaurant_{restaurant_id}')]
    if order_id:
        emits.append(sio.emit(event_name, payload, room=f'order_{order_id}'))
    await asyncio.gather(*emits)

async def build_order_items_from_input(items, restaurant_id: str):
    requested_item_ids = list(dict.fromkeys(item.item_id for item in items))
    menu_items = await db.menu_items.find({
        "item_id": {"$in": requested_item_ids},
        "restaurant_id": restaurant_id
    }, {"_id": 0}).to_list(len(requested_item_ids))
    menu_item_map = {menu_item["item_id"]: menu_item for menu_item in menu_items}

    total = 0
    order_items = []
    for item in items:
        menu_item = menu_item_map.get(item.item_id)
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
            "diet_type": menu_item.get("diet_type", "veg"),
            "instructions": item.instructions or ""
        })

    return round(total, 2), order_items


def get_item_cancelled_quantity(item: dict) -> int:
    try:
        return max(int(item.get("cancelled_quantity") or 0), 0)
    except (TypeError, ValueError):
        return 0


def get_item_billable_quantity(item: dict) -> int:
    try:
        quantity = max(int(item.get("quantity") or 0), 0)
    except (TypeError, ValueError):
        quantity = 0
    return max(quantity - get_item_cancelled_quantity(item), 0)


def calculate_order_items_total(items: list[dict]) -> float:
    return round(sum(
        get_item_billable_quantity(item) * float(item.get("price") or 0)
        for item in items or []
    ), 2)


def order_has_billable_items(items: list[dict]) -> bool:
    return any(get_item_billable_quantity(item) > 0 for item in items or [])


def build_item_cancellation_message(item_name: str, quantity: int, target_order: Optional[dict] = None) -> str:
    if target_order:
        target_label = target_order.get("table_label") or (
            f"Table {target_order.get('table_number')}" if target_order.get("table_number") is not None else target_order.get("table_id")
        )
        return f"{quantity}x {item_name} cancelled and reallocated to {target_label}."
    return f"{quantity}x {item_name} cancelled and marked as loss."


def normalize_attendance_settings(settings: Optional[dict] = None) -> dict:
    normalized = dict(DEFAULT_ATTENDANCE_SETTINGS)
    if isinstance(settings, dict):
        for key in normalized:
            if key in settings and settings[key] is not None:
                normalized[key] = settings[key]

    for time_key in ["shift_start", "shift_end"]:
        value = str(normalized.get(time_key) or "").strip()
        if not value:
            normalized[time_key] = DEFAULT_ATTENDANCE_SETTINGS[time_key]
            continue
        if len(value.split(":")) != 2:
            raise HTTPException(status_code=400, detail=f"{time_key} must use HH:MM format")
        parse_hhmm_minutes(value, time_key)
        normalized[time_key] = value

    try:
        normalized["grace_minutes"] = int(normalized.get("grace_minutes", 10))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="grace_minutes must be a number")
    if normalized["grace_minutes"] < 0:
        raise HTTPException(status_code=400, detail="grace_minutes cannot be negative")

    try:
        normalized["overtime_after_hours"] = float(normalized.get("overtime_after_hours", 9))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="overtime_after_hours must be a number")
    if normalized["overtime_after_hours"] <= 0:
        raise HTTPException(status_code=400, detail="overtime_after_hours must be greater than zero")

    try:
        normalized["confidence_threshold"] = float(normalized.get("confidence_threshold", 0.68))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="confidence_threshold must be a number")
    normalized["confidence_threshold"] = min(max(normalized["confidence_threshold"], 0.55), 0.99)

    normalized["snapshot_audit_enabled"] = bool(normalized.get("snapshot_audit_enabled", False))
    normalized["pin_fallback_enabled"] = bool(normalized.get("pin_fallback_enabled", True))
    return normalized


def normalize_attendance_shift(data: dict, fallback_settings: Optional[dict] = None) -> dict:
    fallback = normalize_attendance_settings(fallback_settings or {})
    normalized = {
        "name": str(data.get("name") or "General Shift").strip(),
        "shift_start": data.get("shift_start") or fallback["shift_start"],
        "shift_end": data.get("shift_end") or fallback["shift_end"],
        "grace_minutes": data.get("grace_minutes", fallback["grace_minutes"]),
        "overtime_after_hours": data.get("overtime_after_hours", fallback["overtime_after_hours"]),
        "active": bool(data.get("active", True)),
    }
    if not normalized["name"]:
        raise HTTPException(status_code=400, detail="Shift name is required")

    for time_key in ["shift_start", "shift_end"]:
        value = str(normalized.get(time_key) or "").strip()
        if len(value.split(":")) != 2:
            raise HTTPException(status_code=400, detail=f"{time_key} must use HH:MM format")
        parse_hhmm_minutes(value, time_key)
        normalized[time_key] = value

    try:
        normalized["grace_minutes"] = int(normalized.get("grace_minutes", 0))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="grace_minutes must be a number")
    if normalized["grace_minutes"] < 0:
        raise HTTPException(status_code=400, detail="grace_minutes cannot be negative")

    try:
        normalized["overtime_after_hours"] = float(normalized.get("overtime_after_hours", 0))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="overtime_after_hours must be a number")
    if normalized["overtime_after_hours"] <= 0:
        raise HTTPException(status_code=400, detail="overtime_after_hours must be greater than zero")

    return normalized


def parse_hhmm_minutes(value: str, label: str = "time") -> int:
    try:
        hour, minute = [int(part) for part in value.split(":")]
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{label} must use HH:MM format")
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        raise HTTPException(status_code=400, detail=f"{label} must use HH:MM format")
    return hour * 60 + minute


def business_date_string(value: datetime) -> str:
    return value.astimezone(BUSINESS_TIMEZONE).date().isoformat()


def to_aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def format_export_datetime(value) -> str:
    if not value:
        return ""
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return value
    if isinstance(value, datetime):
        return to_aware_utc(value).astimezone(BUSINESS_TIMEZONE).strftime("%d/%m/%Y, %I:%M:%S %p IST")
    return str(value)


def attendance_time_status(now: datetime, settings: dict) -> dict:
    local_now = now.astimezone(BUSINESS_TIMEZONE)
    shift_minutes = parse_hhmm_minutes(settings["shift_start"], "shift_start")
    late_after = shift_minutes + int(settings.get("grace_minutes", 0))
    current_minutes = local_now.hour * 60 + local_now.minute
    is_late = current_minutes > late_after
    return {
        "is_late": is_late,
        "late_by_minutes": max(current_minutes - late_after, 0) if is_late else 0,
    }


def normalize_descriptor(descriptor) -> list[float]:
    if not isinstance(descriptor, list):
        raise HTTPException(status_code=400, detail="Face descriptor is required")
    normalized = []
    for value in descriptor[:768]:
        try:
            normalized.append(float(value))
        except (TypeError, ValueError):
            continue
    if len(normalized) < 16:
        raise HTTPException(status_code=400, detail="Face descriptor is too small. Please capture again.")
    return normalized


def average_descriptors(descriptors: list[list[float]]) -> list[float]:
    valid_descriptors = [normalize_descriptor(descriptor) for descriptor in descriptors]
    if not valid_descriptors:
        raise HTTPException(status_code=400, detail="At least one face sample is required")
    descriptor_length = min(len(descriptor) for descriptor in valid_descriptors)
    return [
        sum(descriptor[index] for descriptor in valid_descriptors) / len(valid_descriptors)
        for index in range(descriptor_length)
    ]


def cosine_similarity(left: list[float], right: list[float]) -> float:
    length = min(len(left), len(right))
    if length == 0:
        return 0.0
    dot = sum(left[index] * right[index] for index in range(length))
    left_norm = sum(left[index] * left[index] for index in range(length)) ** 0.5
    right_norm = sum(right[index] * right[index] for index in range(length)) ** 0.5
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot / (left_norm * right_norm)


async def get_attendance_settings_for_restaurant(restaurant_id: str) -> dict:
    settings_doc = await db.attendance_settings.find_one(
        {"restaurant_id": restaurant_id},
        {"_id": 0},
    )
    return normalize_attendance_settings(settings_doc)


async def ensure_default_attendance_shift(restaurant_id: str, actor_id: Optional[str] = None) -> dict:
    existing = await db.attendance_shifts.find_one(
        {"restaurant_id": restaurant_id},
        {"_id": 0},
        sort=[("created_at", 1)],
    )
    if existing:
        return existing

    settings = await get_attendance_settings_for_restaurant(restaurant_id)
    now = datetime.now(timezone.utc)
    shift_doc = {
        "shift_id": f"SHIFT{secrets.token_hex(5).upper()}",
        "restaurant_id": restaurant_id,
        **normalize_attendance_shift({"name": "General Shift", **settings}, settings),
        "created_at": now,
        "updated_at": now,
        "created_by": actor_id,
        "updated_by": actor_id,
        "is_default": True,
    }
    await db.attendance_shifts.insert_one(shift_doc)
    return {k: v for k, v in shift_doc.items() if k != "_id"}


async def get_attendance_shifts_for_restaurant(restaurant_id: str, include_inactive: bool = True) -> list[dict]:
    await ensure_default_attendance_shift(restaurant_id)
    query = {"restaurant_id": restaurant_id}
    if not include_inactive:
        query["active"] = True
    return await db.attendance_shifts.find(query, {"_id": 0}).sort("shift_start", 1).to_list(1000)


async def get_attendance_shift_for_profile(restaurant_id: str, profile: Optional[dict], settings: Optional[dict] = None) -> dict:
    if profile and profile.get("shift_id"):
        shift = await db.attendance_shifts.find_one(
            {"restaurant_id": restaurant_id, "shift_id": profile["shift_id"], "active": True},
            {"_id": 0},
        )
        if shift:
            return shift
    return await ensure_default_attendance_shift(restaurant_id)


async def get_attendance_staff_user(restaurant_id: str, staff_email: str) -> dict:
    email = (staff_email or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Staff email is required")
    staff_user = await db.users.find_one(
        {
            "restaurant_id": restaurant_id,
            "email": email,
            "role": {"$in": STAFF_ROLES},
        },
        {"_id": 0, "password_hash": 0},
    )
    if not staff_user:
        raise HTTPException(status_code=404, detail="Staff member not found")
    return staff_user


async def resolve_attendance_profile_by_face(
    restaurant_id: str,
    descriptor: list[float],
    threshold: float,
    allowed_staff_emails: Optional[list[str]] = None,
) -> tuple[dict, float]:
    query = {"restaurant_id": restaurant_id, "active": True}
    if allowed_staff_emails is not None:
        if not allowed_staff_emails:
            raise HTTPException(status_code=400, detail="No clocked-in staff found for this action")
        query["staff_email"] = {"$in": allowed_staff_emails}

    profiles = await db.face_profiles.find(
        query,
        {"_id": 0},
    ).to_list(1000)
    best_profile = None
    best_score = 0.0
    second_best_score = 0.0
    for profile in profiles:
        candidate_descriptors = get_profile_descriptors(profile)
        profile_score = max(
            [cosine_similarity(descriptor, stored_descriptor) for stored_descriptor in candidate_descriptors],
            default=0.0,
        )
        if profile_score > best_score:
            second_best_score = best_score
            best_score = profile_score
            best_profile = profile
        elif profile_score > second_best_score:
            second_best_score = profile_score
    if not best_profile or best_score < threshold:
        raise HTTPException(
            status_code=404,
            detail=f"Face not recognized. Best confidence: {round(best_score * 100)}%",
        )
    if second_best_score >= threshold and best_score - second_best_score < 0.04:
        raise HTTPException(
            status_code=409,
            detail="Face match is too close between staff profiles. Use PIN or capture clearer samples.",
        )
    return best_profile, best_score


def calculate_break_minutes(breaks: list[dict], now: Optional[datetime] = None) -> int:
    total = 0
    current_time = to_aware_utc(now) if isinstance(now, datetime) else None
    for break_item in breaks or []:
        start = break_item.get("start")
        end = break_item.get("end") or current_time
        if isinstance(start, datetime) and isinstance(end, datetime):
            start_utc = to_aware_utc(start)
            end_utc = to_aware_utc(end)
            if end_utc > start_utc:
                total += int((end_utc - start_utc).total_seconds() // 60)
    return total


def get_face_embedding_cipher():
    if Fernet is None:
        return None
    secret = get_jwt_secret()
    key_material = hashlib.sha256(f"{secret}:attendance-face-embeddings".encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(key_material))


def encrypt_face_payload(payload):
    cipher = get_face_embedding_cipher()
    if cipher is None:
        return None
    serialized = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return cipher.encrypt(serialized).decode("utf-8")


def decrypt_face_payload(encrypted_payload):
    cipher = get_face_embedding_cipher()
    if cipher is None or not encrypted_payload:
        return None
    try:
        return json.loads(cipher.decrypt(encrypted_payload.encode("utf-8")).decode("utf-8"))
    except Exception:
        return None


def get_profile_descriptors(profile: dict) -> list[list[float]]:
    encrypted_descriptors = decrypt_face_payload(profile.get("descriptors_encrypted"))
    encrypted_average = decrypt_face_payload(profile.get("descriptor_average_encrypted"))
    candidate_descriptors = []
    if encrypted_average:
        candidate_descriptors.append(encrypted_average)
    if encrypted_descriptors:
        candidate_descriptors.extend(encrypted_descriptors)
    if candidate_descriptors:
        return candidate_descriptors
    descriptors = []
    if profile.get("descriptor_average"):
        descriptors.append(profile["descriptor_average"])
    descriptors.extend(profile.get("descriptors") or [])
    return descriptors


def hash_attendance_kiosk_token(token: str) -> str:
    return hashlib.sha256(f"{get_jwt_secret()}:attendance-kiosk:{token}".encode("utf-8")).hexdigest()


def build_public_attendance_kiosk_url(request: Optional[Request], token: str) -> str:
    frontend_url = get_frontend_url(request).rstrip("/")
    if frontend_url.startswith("http://") or frontend_url.startswith("https://"):
        return f"{frontend_url}/attendance-kiosk/{token}"
    return f"http://{frontend_url}/attendance-kiosk/{token}"


async def generate_attendance_kiosk_link(restaurant_id: str, request: Optional[Request] = None, updated_by: Optional[str] = None) -> dict:
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    restaurant = await db.restaurants.find_one({"restaurant_id": restaurant_id}, {"_id": 0, "name": 1})
    fallback_user = await db.users.find_one({"restaurant_id": restaurant_id, "role": "admin"}, {"_id": 0, "restaurant_name": 1, "name": 1})
    restaurant_name = (
        (restaurant or {}).get("name")
        or (fallback_user or {}).get("restaurant_name")
        or (fallback_user or {}).get("name")
        or "Restaurant"
    )
    kiosk_config = {
        "restaurant_id": restaurant_id,
        "restaurant_name": restaurant_name,
        "enabled": True,
        "token": token,
        "token_hash": hash_attendance_kiosk_token(token),
        "updated_at": now,
        "updated_by": updated_by,
    }
    await db.attendance_kiosks.update_one(
        {"restaurant_id": restaurant_id},
        {"$set": kiosk_config, "$setOnInsert": {"created_at": now}},
        upsert=True,
    )
    return {
        "enabled": True,
        "token": token,
        "url": build_public_attendance_kiosk_url(request, token),
    }


async def get_or_create_attendance_kiosk_link(restaurant_id: str, request: Optional[Request] = None, updated_by: Optional[str] = None) -> dict:
    kiosk_config = await db.attendance_kiosks.find_one({"restaurant_id": restaurant_id}, {"_id": 0}) or {}
    token = kiosk_config.get("token")
    if not token or not kiosk_config.get("enabled", True):
        return await generate_attendance_kiosk_link(restaurant_id, request, updated_by)
    return {
        "enabled": True,
        "token": token,
        "url": build_public_attendance_kiosk_url(request, token),
    }


async def resolve_public_attendance_kiosk(token: str) -> dict:
    token = (token or "").strip()
    if len(token) < 24:
        raise HTTPException(status_code=404, detail="Attendance kiosk link not found")
    kiosk_config = await db.attendance_kiosks.find_one(
        {
            "token_hash": hash_attendance_kiosk_token(token),
            "enabled": True,
        },
        {"_id": 0},
    )
    if not kiosk_config:
        raise HTTPException(status_code=404, detail="Attendance kiosk link not found")
    restaurant_id = kiosk_config["restaurant_id"]
    restaurant = await db.restaurants.find_one(
        {"restaurant_id": restaurant_id},
        {
            "_id": 0,
            "restaurant_id": 1,
            "name": 1,
            "status": 1,
            "access_config": 1,
        },
    )
    if not restaurant:
        restaurant = {
            "restaurant_id": restaurant_id,
            "name": kiosk_config.get("restaurant_name") or "Restaurant",
            "status": "ACTIVE",
            "access_config": normalize_access_config(),
        }
    if restaurant.get("status") == "SUSPENDED":
        raise HTTPException(status_code=403, detail="Restaurant account is suspended")
    if restaurant.get("status") == "EXPIRED":
        raise HTTPException(status_code=403, detail="Restaurant subscription has expired")
    ensure_access_flag(normalize_access_config(restaurant.get("access_config")), "staff_management_enabled", "Attendance kiosk")
    return restaurant

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
        parsed = parsed.replace(tzinfo=BUSINESS_TIMEZONE)
    if end_of_day:
        parsed = parsed + timedelta(days=1)
    return parsed.astimezone(timezone.utc)


def build_period_date_match(period: str = "daily"):
    now = datetime.now(BUSINESS_TIMEZONE)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    if period == "weekly":
        start_date = today_start - timedelta(days=6)
    elif period == "monthly":
        start_date = today_start.replace(day=1)
    else:
        start_date = today_start

    end_date = today_start + timedelta(days=1)
    return {
        "$gte": start_date.astimezone(timezone.utc),
        "$lt": end_date.astimezone(timezone.utc),
    }


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
            ["admin", "kitchen", "kitchen_tv", "billing", "kitchen_billing", "waiter", "pos"],
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


def build_report_period_match(
    period: str = "daily",
    report_date: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
):
    safe_period = period if period in {"daily", "weekly", "monthly"} else "daily"
    if start_date or end_date:
        if not start_date or not end_date:
            raise HTTPException(status_code=400, detail="Both start date and end date are required.")
        try:
            start_day = datetime.fromisoformat(start_date).date()
            end_day = datetime.fromisoformat(end_date).date()
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD.")
        if end_day < start_day:
            raise HTTPException(status_code=400, detail="End date must be on or after start date.")

        start_dt = datetime.combine(start_day, datetime.min.time(), tzinfo=BUSINESS_TIMEZONE)
        end_dt = datetime.combine(end_day + timedelta(days=1), datetime.min.time(), tzinfo=BUSINESS_TIMEZONE)
        return {
            "$gte": start_dt.astimezone(timezone.utc),
            "$lt": end_dt.astimezone(timezone.utc),
        }, start_day.isoformat(), end_day.isoformat(), safe_period, end_day.isoformat()

    if report_date:
        try:
            anchor_date = datetime.fromisoformat(report_date).date()
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid report date format. Use YYYY-MM-DD.")
    else:
        anchor_date = datetime.now(BUSINESS_TIMEZONE).date()

    if safe_period == "weekly":
        start_date = anchor_date - timedelta(days=6)
        end_date = anchor_date + timedelta(days=1)
    elif safe_period == "monthly":
        start_date = anchor_date.replace(day=1)
        if start_date.month == 12:
            end_date = start_date.replace(year=start_date.year + 1, month=1)
        else:
            end_date = start_date.replace(month=start_date.month + 1)
    else:
        start_date = anchor_date
        end_date = anchor_date + timedelta(days=1)

    start_dt = datetime.combine(start_date, datetime.min.time(), tzinfo=BUSINESS_TIMEZONE)
    end_dt = datetime.combine(end_date, datetime.min.time(), tzinfo=BUSINESS_TIMEZONE)
    return {
        "$gte": start_dt.astimezone(timezone.utc),
        "$lt": end_dt.astimezone(timezone.utc),
    }, start_date.isoformat(), (end_date - timedelta(days=1)).isoformat(), safe_period, anchor_date.isoformat()


def to_socket_payload(data):
    return jsonable_encoder(data)


def is_billable_order(order: dict) -> bool:
    if order.get("status") in ["prepared", "served"]:
        return True
    return order.get("order_source") == "billing_counter" and order.get("status") in ["pending", "accepted"]


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
    cash_drawer = await build_cash_drawer_summary(restaurant_id, build_period_date_match("daily"))

    return {
        "payment_summary": payment_summary,
        "cash_adjustments": {
            "total_adjustments": total_adjustments,
            "entries": adjustments,
        },
        "cash_drawer": cash_drawer,
    }


async def get_cash_activity_total(restaurant_id: str, created_at_filter: dict):
    cash_payments = await db.payments.find({
        "restaurant_id": restaurant_id,
        "status": "completed",
        "payment_method": "cash",
        "created_at": created_at_filter,
    }, {"_id": 0, "total": 1, "payment_type": 1}).to_list(5000)

    cash_received = 0.0
    cash_refunds = 0.0
    for payment in cash_payments:
        amount = round(float(payment.get("total", 0) or 0), 2)
        payment_type = (payment.get("payment_type") or "").strip().lower()
        if payment_type == "refund" or amount < 0:
            cash_refunds = round(cash_refunds + abs(amount), 2)
        else:
            cash_received = round(cash_received + amount, 2)

    cash_adjustments = await db.cash_adjustments.find({
        "restaurant_id": restaurant_id,
        "created_at": created_at_filter,
    }, {"_id": 0, "amount": 1}).to_list(5000)
    adjustment_total = round(sum(float(item.get("amount", 0) or 0) for item in cash_adjustments), 2)

    return {
        "cash_payments": cash_received,
        "cash_refunds": cash_refunds,
        "cash_adjustments": adjustment_total,
        "net_cash_activity": round(cash_received + adjustment_total - cash_refunds, 2),
    }


async def build_cash_drawer_summary(
    restaurant_id: str,
    created_at_filter: dict,
    period_cash_total: float = 0,
    period_adjustment_total: float = 0,
):
    period_start = created_at_filter.get("$gte") if created_at_filter else None
    period_end = created_at_filter.get("$lt") if created_at_filter else None

    previous_opening = None
    previous_activity = {
        "cash_payments": 0.0,
        "cash_refunds": 0.0,
        "cash_adjustments": 0.0,
        "net_cash_activity": 0.0,
    }
    if period_start:
        previous_start = period_start - timedelta(days=1)
        previous_end = period_start
        previous_opening = await db.cash_drawer_openings.find_one(
            {
                "restaurant_id": restaurant_id,
                "business_day_start": previous_start,
                "business_day_end": previous_end,
            },
            {"_id": 0},
            sort=[("updated_at", -1)],
        )
        previous_activity = await get_cash_activity_total(
            restaurant_id,
            {"$gte": previous_start, "$lt": previous_end},
        )
    manual_opening = None
    if period_start and period_end:
        manual_opening = await db.cash_drawer_openings.find_one(
            {
                "restaurant_id": restaurant_id,
                "business_day_start": period_start,
                "business_day_end": period_end,
            },
            {"_id": 0},
            sort=[("updated_at", -1)],
        )

    today_activity = {
        "cash_payments": round(float(period_cash_total or 0), 2),
        "cash_refunds": 0.0,
        "cash_adjustments": round(float(period_adjustment_total or 0), 2),
        "net_cash_activity": round(float(period_cash_total or 0) + float(period_adjustment_total or 0), 2),
    }
    if period_start or period_end:
        activity_filter = {}
        if period_start:
            activity_filter["$gte"] = period_start
        if period_end:
            activity_filter["$lt"] = period_end
        today_activity = await get_cash_activity_total(restaurant_id, activity_filter)

    previous_opening_balance = round(max(float((previous_opening or {}).get("opening_balance", 0) or 0), 0), 2)
    opening_balance = round(max(previous_opening_balance + previous_activity["net_cash_activity"], 0), 2)
    opening_source = "previous_day"
    if manual_opening:
        opening_balance = round(max(float(manual_opening.get("opening_balance", 0) or 0), 0), 2)
        opening_source = "manual"
    closing_balance = round(max(opening_balance + today_activity["net_cash_activity"], 0), 2)

    return {
        "opening_balance": opening_balance,
        "closing_balance": closing_balance,
        "cash_payments": today_activity["cash_payments"],
        "cash_adjustments": today_activity["cash_adjustments"],
        "cash_refunds": today_activity["cash_refunds"],
        "net_cash_activity": today_activity["net_cash_activity"],
        "opening_source": opening_source,
        "manual_opening_id": (manual_opening or {}).get("opening_id"),
        "period_start": period_start,
        "period_end": period_end,
    }


def coerce_bool(value, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def coerce_nonnegative_float(value, default: float = 0) -> float:
    if value is None or value == "":
        return default
    try:
        return max(float(value), 0)
    except (TypeError, ValueError):
        return default


def normalize_billing_settings(restaurant: Optional[dict]) -> dict:
    restaurant = restaurant or {}
    tax_enabled = coerce_bool(restaurant.get("tax_enabled"), True)
    service_charge_enabled = coerce_bool(restaurant.get("service_charge_enabled"), False)
    parcel_charge_enabled = coerce_bool(restaurant.get("parcel_charge_enabled"), False)
    return {
        "tax_enabled": tax_enabled,
        "tax_percentage": coerce_nonnegative_float(restaurant.get("tax_percentage"), 5 if tax_enabled else 0),
        "service_charge_enabled": service_charge_enabled,
        "service_charge_percentage": coerce_nonnegative_float(restaurant.get("service_charge_percentage"), 0),
        "parcel_charge_enabled": parcel_charge_enabled,
        "parcel_charge": coerce_nonnegative_float(restaurant.get("parcel_charge"), 0),
    }


def calculate_bill_amounts(subtotal: float, settings: dict, is_takeaway: bool, discount: float = 0) -> dict:
    subtotal = round(float(subtotal or 0), 2)
    discount = round(float(discount or 0), 2)
    tax_percentage = float(settings.get("tax_percentage", 0) or 0) if settings.get("tax_enabled") else 0
    service_charge_percentage = (
        float(settings.get("service_charge_percentage", 0) or 0)
        if settings.get("service_charge_enabled") and not is_takeaway
        else 0
    )
    service_charge = round(subtotal * service_charge_percentage / 100, 2)
    parcel_charge = round(float(settings.get("parcel_charge", 0) or 0), 2) if is_takeaway and settings.get("parcel_charge_enabled") else 0
    taxable_amount = subtotal + service_charge + parcel_charge
    tax = round(taxable_amount * tax_percentage / 100, 2)
    total = round(max(taxable_amount + tax - discount, 0), 2)

    return {
        "subtotal": subtotal,
        "tax": tax,
        "tax_percentage": tax_percentage,
        "service_charge": service_charge,
        "service_charge_percentage": service_charge_percentage,
        "parcel_charge": parcel_charge,
        "discount": discount,
        "total": total,
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


def get_lan_host() -> Optional[str]:
    configured = os.environ.get("LOCAL_FRONTEND_HOST", "").strip()
    if configured:
        return configured

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("8.8.8.8", 80))
            host = probe.getsockname()[0]
            if host and not host.startswith("127."):
                return host
    except OSError:
        pass

    return None


def make_phone_reachable_frontend_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.hostname not in {"localhost", "127.0.0.1"}:
        return url.rstrip("/")

    lan_host = get_lan_host()
    if not lan_host:
        return url.rstrip("/")

    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme or 'http'}://{lan_host}{port}".rstrip("/")


def get_frontend_url(request: Optional[Request] = None) -> str:
    configured = os.environ.get("FRONTEND_URL", "").strip().rstrip("/")
    if configured:
        return configured

    request_origin = get_request_origin(request)
    if request_origin:
        return make_phone_reachable_frontend_url(request_origin)

    return make_phone_reachable_frontend_url("http://127.0.0.1:3000")


def build_table_qr_code(table_id: str, request: Optional[Request] = None) -> str:
    return f"{get_frontend_url(request)}/customer/{table_id}"


def build_cors_origins() -> list[str]:
    configured = [origin.strip() for origin in os.environ.get("CORS_ORIGINS", "").split(",") if origin.strip()]
    frontend_url = os.environ.get("FRONTEND_URL", "").strip().rstrip("/")

    if configured:
        return configured

    default_origins = {
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://dineflo.online",
        "https://www.dineflo.online",
        "https://sqaenv.vercel.app",
    }
    if frontend_url:
        default_origins.add(frontend_url)

    return sorted(default_origins)

# ============ Auth Endpoints ============
@api_router.get("/health")
async def health_check():
    return {
        "status": "ok",
        "staff_management_patch": "legacy-restaurant-fallback",
        "kitchen_tv_role": True,
    }


@api_router.post("/auth/register")
async def register(input: RegisterRequest, request: Request, response: Response):
    """Register new staff user - ONLY restaurant admins can create kitchen/billing/waiter staff"""
    email = input.email.lower()
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    # Validate role - only restaurant staff roles can be registered this way
    # Restaurant admins are created by super admin through restaurant creation
    if input.role not in ["kitchen", "billing", "kitchen_billing", "waiter"]:
        raise HTTPException(status_code=400, detail="Invalid role. Only kitchen, billing, kitchen+billing, and waiter staff can be registered here.")
    
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
    
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "email": email,
        "name": input.name,
        "role": input.role,
        "_id": user_id,
    }

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
        restaurant = await db.restaurants.find_one({"restaurant_id": restaurant_id}, {"_id": 0, "status": 1, "access_config": 1})
        if restaurant and restaurant.get("status") == "SUSPENDED":
            raise HTTPException(status_code=403, detail="Restaurant account is suspended. Please contact support.")
        if restaurant and restaurant.get("status") == "EXPIRED":
            raise HTTPException(status_code=403, detail="Restaurant subscription has expired. Please contact support.")
        role_access_key = STAFF_ROLE_ACCESS_KEYS.get(user.get("role"))
        if role_access_key and restaurant:
            ensure_access_flag(normalize_access_config(restaurant.get("access_config")), role_access_key, user.get("role", "Staff").replace("_", " ").title())
    
    await clear_failed_logins(db, client_ip, email)
    
    user_id = str(user["_id"])
    access_token = create_access_token(user_id, email)
    refresh_token = create_refresh_token(user_id)
    
    cookie_settings = get_cookie_settings(request)
    response.set_cookie(key="access_token", value=access_token, max_age=ACCESS_TOKEN_MAX_AGE_SECONDS, **cookie_settings)
    response.set_cookie(key="refresh_token", value=refresh_token, max_age=REFRESH_TOKEN_MAX_AGE_SECONDS, **cookie_settings)
    
    response_user = await attach_restaurant_context(dict(user), db)
    return {
        "access_token": access_token,
        "token_type": "bearer",
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
    access_token = create_access_token(response_user["_id"], response_user["email"])
    return {
        "access_token": access_token,
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
        "access_config": normalize_access_config(input.access_config),
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
        "access_config": normalize_access_config(),
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
        rest["access_config"] = normalize_access_config(rest.get("access_config"))
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
    if "access_config" in update_data:
        existing_access_config = normalize_access_config(restaurant.get("access_config"))
        incoming_access_config = update_data.get("access_config") or {}
        if not isinstance(incoming_access_config, dict):
            raise HTTPException(status_code=400, detail="access_config must be an object.")
        update_data["access_config"] = normalize_access_config({**existing_access_config, **incoming_access_config})
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
    updated["access_config"] = normalize_access_config(updated.get("access_config"))
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
    if user["role"] not in ["admin", "kitchen", "kitchen_tv", "billing", "kitchen_billing", "waiter", "pos"]:
        raise HTTPException(status_code=403, detail="Restaurant access required")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    restaurant = await db.restaurants.find_one(
        {"restaurant_id": restaurant_id},
        {
            "_id": 0,
            "restaurant_id": 1,
            "name": 1,
            "gst_number": 1,
            "google_review_url": 1,
            "customer_logo_url": 1,
            "tax_enabled": 1,
            "tax_percentage": 1,
            "service_charge_enabled": 1,
            "service_charge_percentage": 1,
            "parcel_charge_enabled": 1,
            "parcel_charge": 1,
            "access_config": 1,
        }
    )
    if not restaurant:
        logging.warning(
            "Restaurant %s missing while loading profile; returning legacy default profile.",
            restaurant_id,
        )
        restaurant = {
            "restaurant_id": restaurant_id,
            "name": user.get("restaurant_name") or "",
            "access_config": normalize_access_config(),
        }

    return {**restaurant, **normalize_billing_settings(restaurant), "access_config": normalize_access_config(restaurant.get("access_config"))}

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
    customer_logo_url = (input.customer_logo_url or "").strip() or None
    tax_enabled = coerce_bool(input.tax_enabled, True)
    service_charge_enabled = coerce_bool(input.service_charge_enabled, False)
    parcel_charge_enabled = coerce_bool(input.parcel_charge_enabled, False)
    tax_percentage = coerce_nonnegative_float(input.tax_percentage, 5 if tax_enabled else 0)
    service_charge_percentage = coerce_nonnegative_float(input.service_charge_percentage, 0)
    parcel_charge = coerce_nonnegative_float(input.parcel_charge, 0)
    if gst_number and len(gst_number) > 30:
        raise HTTPException(status_code=400, detail="GST number must be 30 characters or fewer.")
    if google_review_url and not google_review_url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Google review link must start with http:// or https://")
    if customer_logo_url and not customer_logo_url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Customer logo URL must start with http:// or https://")    
    if tax_percentage > 100:
        raise HTTPException(status_code=400, detail="Tax percentage must be 100 or less.")
    if service_charge_percentage > 100:
        raise HTTPException(status_code=400, detail="Service charge percentage must be 100 or less.")

    await db.restaurants.update_one(
        {"restaurant_id": restaurant_id},
        {"$set": {
            "gst_number": gst_number,
            "google_review_url": google_review_url,
            "customer_logo_url": customer_logo_url,
            "tax_enabled": tax_enabled,
            "tax_percentage": tax_percentage,
            "service_charge_enabled": service_charge_enabled,
            "service_charge_percentage": service_charge_percentage,
            "parcel_charge_enabled": parcel_charge_enabled,
            "parcel_charge": parcel_charge,
            "updated_at": datetime.now(timezone.utc)
        }}
    )

    updated_restaurant = await db.restaurants.find_one(
        {"restaurant_id": restaurant_id},
        {
            "_id": 0,
            "restaurant_id": 1,
            "name": 1,
            "gst_number": 1,
            "google_review_url": 1,
            "customer_logo_url": 1,
            "tax_enabled": 1,
            "tax_percentage": 1,
            "service_charge_enabled": 1,
            "service_charge_percentage": 1,
            "parcel_charge_enabled": 1,
            "parcel_charge": 1,
        }
    )
    if not updated_restaurant:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    return {**updated_restaurant, **normalize_billing_settings(updated_restaurant)}

@api_router.get("/customer/table/{table_id}/branding")
async def get_customer_table_branding(table_id: str):
    table = await db.tables.find_one({"table_id": table_id}, {"_id": 0, "restaurant_id": 1})
    if not table or not table.get("restaurant_id"):
        raise HTTPException(status_code=404, detail="Table not found")

    restaurant = await db.restaurants.find_one(
        {"restaurant_id": table["restaurant_id"]},
        {"_id": 0, "name": 1, "customer_logo_url": 1}
    )
    if not restaurant:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    return {
        "restaurant_name": restaurant.get("name") or "",
        "customer_logo_url": restaurant.get("customer_logo_url") or "",
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
    """Restaurant admin creates kitchen/billing/waiter/POS staff"""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin"]:
        raise HTTPException(status_code=403, detail="Restaurant admin access required")
    
    # Get and verify restaurant
    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")
    
    restaurant = await get_staff_management_restaurant(restaurant_id)
    
    # Validate role - admin can only create restaurant staff accounts
    if input.role not in ["kitchen", "kitchen_tv", "billing", "kitchen_billing", "waiter", "pos"]:
        raise HTTPException(status_code=400, detail="Can only create kitchen, kitchen TV, billing, kitchen+billing, waiter, or POS staff")
    await ensure_staff_creation_allowed(restaurant_id, input.role, restaurant.get("access_config"))
    
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
    
    await get_staff_management_restaurant(restaurant_id)
    
    # Get all staff for this restaurant
    staff = await db.users.find(
        {"restaurant_id": restaurant_id, "role": {"$in": ["kitchen", "kitchen_tv", "billing", "kitchen_billing", "waiter", "pos"]}},
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
    
    restaurant = await get_staff_management_restaurant(restaurant_id)
    access_config = normalize_access_config(restaurant.get("access_config"))
    ensure_access_flag(access_config, "staff_management_enabled", "Staff management")
    
    # Delete staff (only kitchen/kitchen TV/billing/waiter/POS)
    result = await db.users.delete_one({
        "email": email.lower(),
        "restaurant_id": restaurant_id,
        "role": {"$in": ["kitchen", "kitchen_tv", "billing", "kitchen_billing", "waiter", "pos"]}
    })
    
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Staff member not found")
    
    return {"message": "Staff member deleted successfully"}


# ============ Attendance Management ============

@api_router.get("/attendance/settings")
async def get_attendance_settings(request: Request):
    user, restaurant_id = await resolve_restaurant_access(request, ATTENDANCE_KIOSK_ROLES)
    settings = await get_attendance_settings_for_restaurant(restaurant_id)
    return {
        "restaurant_id": restaurant_id,
        "settings": settings,
        "can_manage": user["role"] in ATTENDANCE_MANAGER_ROLES,
    }


@api_router.put("/attendance/settings")
async def update_attendance_settings(input: AttendanceSettingsUpdate, request: Request):
    user, restaurant_id = await resolve_restaurant_access(request, ATTENDANCE_MANAGER_ROLES)
    current_settings = await get_attendance_settings_for_restaurant(restaurant_id)
    updates = input.dict(exclude_unset=True)
    settings = normalize_attendance_settings({**current_settings, **updates})
    await db.attendance_settings.update_one(
        {"restaurant_id": restaurant_id},
        {
            "$set": {
                **settings,
                "restaurant_id": restaurant_id,
                "updated_at": datetime.now(timezone.utc),
                "updated_by": user["_id"],
            }
        },
        upsert=True,
    )
    return {"message": "Attendance settings updated", "settings": settings}


@api_router.get("/attendance/staff")
async def get_attendance_staff(request: Request):
    _, restaurant_id = await resolve_restaurant_access(request, ATTENDANCE_KIOSK_ROLES)
    staff = await db.users.find(
        {"restaurant_id": restaurant_id, "role": {"$in": STAFF_ROLES}},
        {"_id": 0, "password_hash": 0},
    ).sort("name", 1).to_list(1000)
    profiles = await db.face_profiles.find(
        {"restaurant_id": restaurant_id},
        {
            "_id": 0,
            "staff_email": 1,
            "active": 1,
            "pin_hash": 1,
            "updated_at": 1,
            "enrolled_at": 1,
            "shift_id": 1,
            "shift_name": 1,
            "descriptors": 1,
            "descriptors_encrypted": 1,
            "descriptor_average": 1,
            "descriptor_average_encrypted": 1,
        },
    ).to_list(1000)
    profile_map = {profile["staff_email"]: profile for profile in profiles}

    enriched_staff = []
    for staff_member in staff:
        profile = profile_map.get(staff_member["email"], {})
        has_face = bool(
            profile.get("descriptor_average")
            or profile.get("descriptor_average_encrypted")
            or profile.get("descriptors")
            or profile.get("descriptors_encrypted")
        )
        enriched_staff.append({
            **staff_member,
            "face_enrolled": has_face,
            "attendance_active": bool(profile.get("active", False) and has_face) if profile else False,
            "pin_enabled": bool(profile.get("pin_hash")),
            "profile_updated_at": profile.get("updated_at") or profile.get("enrolled_at"),
            "shift_id": profile.get("shift_id"),
            "shift_name": profile.get("shift_name"),
        })
    return enriched_staff


@api_router.get("/attendance/shifts")
async def get_attendance_shifts(request: Request, include_inactive: bool = True):
    user, restaurant_id = await resolve_restaurant_access(request, ATTENDANCE_KIOSK_ROLES)
    shifts = await get_attendance_shifts_for_restaurant(
        restaurant_id,
        include_inactive=include_inactive or user["role"] in ATTENDANCE_MANAGER_ROLES,
    )
    return shifts


@api_router.post("/attendance/shifts")
async def create_attendance_shift(input: AttendanceShiftCreate, request: Request):
    user, restaurant_id = await resolve_restaurant_access(request, ATTENDANCE_MANAGER_ROLES)
    settings = await get_attendance_settings_for_restaurant(restaurant_id)
    now = datetime.now(timezone.utc)
    shift_doc = {
        "shift_id": f"SHIFT{secrets.token_hex(5).upper()}",
        "restaurant_id": restaurant_id,
        **normalize_attendance_shift(input.dict(exclude_unset=True), settings),
        "created_at": now,
        "updated_at": now,
        "created_by": user["_id"],
        "updated_by": user["_id"],
        "is_default": False,
    }
    await db.attendance_shifts.insert_one(shift_doc)
    return {k: v for k, v in shift_doc.items() if k != "_id"}


@api_router.put("/attendance/shifts/{shift_id}")
async def update_attendance_shift(shift_id: str, input: AttendanceShiftUpdate, request: Request):
    user, restaurant_id = await resolve_restaurant_access(request, ATTENDANCE_MANAGER_ROLES)
    existing = await db.attendance_shifts.find_one(
        {"restaurant_id": restaurant_id, "shift_id": shift_id},
        {"_id": 0},
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Shift not found")

    updates = input.dict(exclude_unset=True)
    shift = normalize_attendance_shift({**existing, **updates}, await get_attendance_settings_for_restaurant(restaurant_id))
    shift.update({
        "updated_at": datetime.now(timezone.utc),
        "updated_by": user["_id"],
    })
    await db.attendance_shifts.update_one(
        {"restaurant_id": restaurant_id, "shift_id": shift_id},
        {"$set": shift},
    )
    if "name" in updates:
        await db.face_profiles.update_many(
            {"restaurant_id": restaurant_id, "shift_id": shift_id},
            {"$set": {"shift_name": shift["name"], "updated_at": datetime.now(timezone.utc)}},
        )
    updated = await db.attendance_shifts.find_one({"restaurant_id": restaurant_id, "shift_id": shift_id}, {"_id": 0})
    return updated


@api_router.post("/attendance/profile-shift")
async def assign_attendance_profile_shift(input: AttendanceProfileShiftAssign, request: Request):
    user, restaurant_id = await resolve_restaurant_access(request, ATTENDANCE_MANAGER_ROLES)
    staff_user = await get_attendance_staff_user(restaurant_id, input.staff_email)
    shift = None
    if input.shift_id:
        shift = await db.attendance_shifts.find_one(
            {"restaurant_id": restaurant_id, "shift_id": input.shift_id, "active": True},
            {"_id": 0},
        )
        if not shift:
            raise HTTPException(status_code=404, detail="Active shift not found")

    await db.face_profiles.update_one(
        {"restaurant_id": restaurant_id, "staff_email": staff_user["email"]},
        {
            "$set": {
                "restaurant_id": restaurant_id,
                "staff_email": staff_user["email"],
                "staff_name": staff_user.get("name", staff_user["email"]),
                "staff_role": staff_user["role"],
                "shift_id": shift.get("shift_id") if shift else None,
                "shift_name": shift.get("name") if shift else None,
                "updated_at": datetime.now(timezone.utc),
                "updated_by": user["_id"],
            },
            "$setOnInsert": {
                "active": False,
                "enrolled_at": datetime.now(timezone.utc),
                "enrolled_by": user["_id"],
            },
        },
        upsert=True,
    )
    return {
        "message": "Shift assigned",
        "staff_email": staff_user["email"],
        "shift_id": shift.get("shift_id") if shift else None,
        "shift_name": shift.get("name") if shift else None,
    }


@api_router.post("/attendance/enroll")
async def enroll_attendance_face(input: AttendanceEnrollRequest, request: Request):
    user, restaurant_id = await resolve_restaurant_access(request, ATTENDANCE_MANAGER_ROLES)
    staff_user = await get_attendance_staff_user(restaurant_id, input.staff_email)
    shift = None
    if input.shift_id:
        shift = await db.attendance_shifts.find_one(
            {"restaurant_id": restaurant_id, "shift_id": input.shift_id, "active": True},
            {"_id": 0},
        )
        if not shift:
            raise HTTPException(status_code=404, detail="Active shift not found")
    descriptor_average = average_descriptors(input.descriptors)
    descriptors = [normalize_descriptor(descriptor) for descriptor in input.descriptors[:6]]
    encrypted_descriptors = encrypt_face_payload(descriptors)
    encrypted_average = encrypt_face_payload(descriptor_average)
    profile_doc = {
        "restaurant_id": restaurant_id,
        "staff_email": staff_user["email"],
        "staff_name": staff_user.get("name", staff_user["email"]),
        "staff_role": staff_user["role"],
        "shift_id": shift.get("shift_id") if shift else None,
        "shift_name": shift.get("name") if shift else None,
        "registration_audit": input.registration_audit or {},
        "embedding_version": "mediapipe_landmark_texture_v2",
        "embedding_storage": "encrypted" if encrypted_descriptors and encrypted_average else "plain",
        "active": bool(input.active),
        "updated_at": datetime.now(timezone.utc),
        "updated_by": user["_id"],
    }
    unset_doc = {}
    if encrypted_descriptors and encrypted_average:
        profile_doc["descriptors_encrypted"] = encrypted_descriptors
        profile_doc["descriptor_average_encrypted"] = encrypted_average
        unset_doc = {"descriptors": "", "descriptor_average": ""}
    else:
        profile_doc["descriptors"] = descriptors
        profile_doc["descriptor_average"] = descriptor_average

    set_on_insert = {"enrolled_at": datetime.now(timezone.utc), "enrolled_by": user["_id"]}
    if input.pin:
        if len(input.pin.strip()) < 4:
            raise HTTPException(status_code=400, detail="PIN must be at least 4 digits")
        profile_doc["pin_hash"] = hash_password(input.pin.strip())

    update_doc = {"$set": profile_doc, "$setOnInsert": set_on_insert}
    if unset_doc:
        update_doc["$unset"] = unset_doc

    await db.face_profiles.update_one(
        {"restaurant_id": restaurant_id, "staff_email": staff_user["email"]},
        update_doc,
        upsert=True,
    )
    return {
        "message": "Attendance profile saved",
        "staff": {
            "email": staff_user["email"],
            "name": staff_user.get("name"),
            "role": staff_user.get("role"),
        },
        "samples": len(descriptors),
    }


async def process_attendance_punch(
    input: AttendancePunchRequest,
    restaurant_id: str,
    actor_id: str,
    allow_pin: bool = True,
    allow_manual: bool = False,
):
    punch_type = (input.punch_type or "").strip().lower()
    if punch_type not in ATTENDANCE_PUNCH_TYPES:
        raise HTTPException(status_code=400, detail="Invalid attendance action")

    method = (input.method or "face").strip().lower()
    settings = await get_attendance_settings_for_restaurant(restaurant_id)
    now = datetime.now(timezone.utc)
    confidence = None
    profile = None

    if method == "face":
        descriptor = normalize_descriptor(input.descriptor)
        allowed_staff_emails = None
        if punch_type in ["clock_out", "break_in", "break_out"]:
            open_logs = await db.attendance_logs.find(
                {"restaurant_id": restaurant_id, "clock_out": None},
                {"_id": 0, "staff_email": 1},
            ).to_list(1000)
            allowed_staff_emails = list({log["staff_email"] for log in open_logs if log.get("staff_email")})
        profile, confidence = await resolve_attendance_profile_by_face(
            restaurant_id,
            descriptor,
            settings["confidence_threshold"],
            allowed_staff_emails,
        )
        staff_user = await get_attendance_staff_user(restaurant_id, profile["staff_email"])
    elif method == "pin":
        if not allow_pin:
            raise HTTPException(status_code=403, detail="PIN is not available on this kiosk link")
        if not settings.get("pin_fallback_enabled", True):
            raise HTTPException(status_code=403, detail="PIN fallback is disabled")
        staff_user = await get_attendance_staff_user(restaurant_id, input.staff_email)
        profile = await db.face_profiles.find_one(
            {"restaurant_id": restaurant_id, "staff_email": staff_user["email"], "active": True},
            {"_id": 0},
        )
        if not profile or not profile.get("pin_hash") or not input.pin:
            raise HTTPException(status_code=400, detail="PIN profile is not configured for this staff member")
        if not verify_password(input.pin.strip(), profile["pin_hash"]):
            raise HTTPException(status_code=401, detail="Invalid attendance PIN")
        confidence = 1.0
    elif method == "manual":
        if not allow_manual:
            raise HTTPException(status_code=403, detail="Only managers can create manual attendance punches")
        staff_user = await get_attendance_staff_user(restaurant_id, input.staff_email)
        profile = await db.face_profiles.find_one(
            {"restaurant_id": restaurant_id, "staff_email": staff_user["email"]},
            {"_id": 0},
        )
        confidence = None
    else:
        raise HTTPException(status_code=400, detail="Invalid attendance method")

    staff_email = staff_user["email"]
    assigned_shift = await get_attendance_shift_for_profile(restaurant_id, profile, settings)
    shift_settings = {
        **settings,
        "shift_start": assigned_shift.get("shift_start", settings["shift_start"]),
        "shift_end": assigned_shift.get("shift_end", settings["shift_end"]),
        "grace_minutes": assigned_shift.get("grace_minutes", settings["grace_minutes"]),
        "overtime_after_hours": assigned_shift.get("overtime_after_hours", settings["overtime_after_hours"]),
    }
    open_log = await db.attendance_logs.find_one(
        {"restaurant_id": restaurant_id, "staff_email": staff_email, "clock_out": None},
        sort=[("clock_in", -1)],
    )
    event_name = None

    if punch_type == "clock_in":
        if open_log:
            raise HTTPException(status_code=400, detail=f"{staff_user.get('name', staff_email)} is already clocked in")
        time_status = attendance_time_status(now, shift_settings)
        attendance_id = f"ATT{secrets.token_hex(6).upper()}"
        log_doc = {
            "attendance_id": attendance_id,
            "restaurant_id": restaurant_id,
            "staff_email": staff_email,
            "staff_name": staff_user.get("name", staff_email),
            "staff_role": staff_user.get("role"),
            "shift_id": assigned_shift.get("shift_id"),
            "shift_name": assigned_shift.get("name"),
            "shift_start": assigned_shift.get("shift_start"),
            "shift_end": assigned_shift.get("shift_end"),
            "shift_overtime_after_hours": assigned_shift.get("overtime_after_hours"),
            "business_date": business_date_string(now),
            "clock_in": now,
            "clock_out": None,
            "breaks": [],
            "active_break": False,
            "total_break_minutes": 0,
            "total_work_minutes": 0,
            "overtime_minutes": 0,
            "status": "active",
            "is_late": time_status["is_late"],
            "late_by_minutes": time_status["late_by_minutes"],
            "clock_in_method": method,
            "clock_in_confidence": confidence,
            "created_at": now,
            "updated_at": now,
            "created_by": actor_id,
        }
        await db.attendance_logs.insert_one(log_doc)
        event_name = "attendance_clock_in"
    elif punch_type == "clock_out":
        if not open_log:
            raise HTTPException(status_code=400, detail=f"{staff_user.get('name', staff_email)} is not clocked in")
        breaks = open_log.get("breaks") or []
        if open_log.get("active_break") and breaks:
            breaks[-1]["end"] = now
        clock_in = to_aware_utc(open_log["clock_in"])
        total_break_minutes = calculate_break_minutes(breaks, now)
        gross_minutes = max(int((now - clock_in).total_seconds() // 60), 0)
        total_work_minutes = max(gross_minutes - total_break_minutes, 0)
        overtime_after_hours = open_log.get("overtime_after_hours") or open_log.get("shift_overtime_after_hours") or shift_settings["overtime_after_hours"]
        overtime_minutes = max(total_work_minutes - int(float(overtime_after_hours) * 60), 0)
        await db.attendance_logs.update_one(
            {"attendance_id": open_log["attendance_id"]},
            {
                "$set": {
                    "clock_out": now,
                    "breaks": breaks,
                    "active_break": False,
                    "total_break_minutes": total_break_minutes,
                    "total_work_minutes": total_work_minutes,
                    "overtime_minutes": overtime_minutes,
                    "status": "completed",
                    "clock_out_method": method,
                    "clock_out_confidence": confidence,
                    "updated_at": now,
                    "updated_by": actor_id,
                }
            },
        )
        event_name = "attendance_clock_out"
    elif punch_type == "break_in":
        if not open_log:
            raise HTTPException(status_code=400, detail=f"{staff_user.get('name', staff_email)} is not clocked in")
        if open_log.get("active_break"):
            raise HTTPException(status_code=400, detail="Break is already active")
        breaks = open_log.get("breaks") or []
        breaks.append({"start": now, "end": None, "method": method})
        await db.attendance_logs.update_one(
            {"attendance_id": open_log["attendance_id"]},
            {"$set": {"breaks": breaks, "active_break": True, "updated_at": now, "updated_by": actor_id}},
        )
        event_name = "attendance_break_in"
    elif punch_type == "break_out":
        if not open_log:
            raise HTTPException(status_code=400, detail=f"{staff_user.get('name', staff_email)} is not clocked in")
        breaks = open_log.get("breaks") or []
        if not open_log.get("active_break") or not breaks:
            raise HTTPException(status_code=400, detail="No active break found")
        breaks[-1]["end"] = now
        total_break_minutes = calculate_break_minutes(breaks, now)
        await db.attendance_logs.update_one(
            {"attendance_id": open_log["attendance_id"]},
            {
                "$set": {
                    "breaks": breaks,
                    "active_break": False,
                    "total_break_minutes": total_break_minutes,
                    "updated_at": now,
                    "updated_by": actor_id,
                }
            },
        )
        event_name = "attendance_break_out"

    latest_log = await db.attendance_logs.find_one(
        {"restaurant_id": restaurant_id, "staff_email": staff_email},
        {"_id": 0},
        sort=[("updated_at", -1)],
    )
    payload = {
        "message": "Attendance updated",
        "event": event_name,
        "staff": {
            "email": staff_email,
            "name": staff_user.get("name", staff_email),
            "role": staff_user.get("role"),
        },
        "confidence": round(confidence, 4) if isinstance(confidence, float) else None,
        "log": latest_log,
    }
    await sio.emit("attendance_updated", to_socket_payload(payload), room=f"restaurant_{restaurant_id}")
    return payload


@api_router.get("/attendance/kiosk-link")
async def get_attendance_kiosk_link(request: Request):
    user, restaurant_id = await resolve_restaurant_access(request, ATTENDANCE_MANAGER_ROLES)
    return await get_or_create_attendance_kiosk_link(restaurant_id, request, user["_id"])


@api_router.post("/attendance/kiosk-link/regenerate")
async def regenerate_attendance_kiosk_link(request: Request):
    user, restaurant_id = await resolve_restaurant_access(request, ATTENDANCE_MANAGER_ROLES)
    return await generate_attendance_kiosk_link(restaurant_id, request, user["_id"])


@api_router.get("/public/attendance-kiosk/{token}")
async def get_public_attendance_kiosk(token: str):
    restaurant = await resolve_public_attendance_kiosk(token)
    settings = await get_attendance_settings_for_restaurant(restaurant["restaurant_id"])
    return {
        "restaurant_id": restaurant["restaurant_id"],
        "restaurant_name": restaurant.get("name") or "Restaurant",
        "settings": settings,
    }


@api_router.post("/public/attendance-kiosk/{token}/punch")
async def public_attendance_kiosk_punch(token: str, input: AttendancePunchRequest):
    restaurant = await resolve_public_attendance_kiosk(token)
    if (input.method or "face").strip().lower() != "face":
        raise HTTPException(status_code=403, detail="Public kiosk supports face scan only")
    return await process_attendance_punch(
        AttendancePunchRequest(punch_type=input.punch_type, method="face", descriptor=input.descriptor),
        restaurant["restaurant_id"],
        "public_attendance_kiosk",
        allow_pin=False,
        allow_manual=False,
    )


@api_router.post("/attendance/punch")
async def create_attendance_punch(input: AttendancePunchRequest, request: Request):
    user, restaurant_id = await resolve_restaurant_access(request, ATTENDANCE_KIOSK_ROLES)
    return await process_attendance_punch(
        input,
        restaurant_id,
        user["_id"],
        allow_pin=True,
        allow_manual=user["role"] in ATTENDANCE_MANAGER_ROLES,
    )


@api_router.get("/attendance/logs")
async def get_attendance_logs(
    request: Request,
    date: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    staff_email: Optional[str] = None,
):
    _, restaurant_id = await resolve_restaurant_access(request, ATTENDANCE_MANAGER_ROLES)
    query = {"restaurant_id": restaurant_id}
    if staff_email:
        query["staff_email"] = staff_email.strip().lower()
    if date:
        query["business_date"] = date
    elif start_date or end_date:
        date_query = {}
        if start_date:
            date_query["$gte"] = start_date
        if end_date:
            date_query["$lte"] = end_date
        query["business_date"] = date_query
    else:
        query["business_date"] = business_date_string(datetime.now(timezone.utc))

    logs = await db.attendance_logs.find(query, {"_id": 0}).sort("clock_in", -1).to_list(1000)
    return logs


@api_router.get("/attendance/export")
async def export_attendance_logs(
    request: Request,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    staff_email: Optional[str] = None,
):
    _, restaurant_id = await resolve_restaurant_access(request, ATTENDANCE_MANAGER_ROLES)
    today = business_date_string(datetime.now(timezone.utc))
    start = start_date or today
    end = end_date or start
    query = {
        "restaurant_id": restaurant_id,
        "business_date": {"$gte": start, "$lte": end},
    }
    if staff_email and staff_email != "all":
        query["staff_email"] = staff_email.strip().lower()

    logs = await db.attendance_logs.find(query, {"_id": 0}).sort(
        [("business_date", 1), ("staff_name", 1), ("clock_in", 1)]
    ).to_list(10000)
    headers = [
        "Business Date",
        "Staff Name",
        "Email",
        "Role",
        "Shift",
        "Shift Start",
        "Shift End",
        "Clock In (IST)",
        "Clock Out (IST)",
        "Break Minutes",
        "Work Minutes",
        "Work Hours",
        "Overtime Minutes",
        "Late",
        "Late Minutes",
        "Status",
        "Clock In Method",
        "Clock Out Method",
    ]
    rows = []
    for log in logs:
        work_minutes = int(log.get("total_work_minutes") or 0)
        rows.append([
            log.get("business_date", ""),
            log.get("staff_name", ""),
            log.get("staff_email", ""),
            log.get("staff_role", ""),
            log.get("shift_name") or "General Shift",
            log.get("shift_start", ""),
            log.get("shift_end", ""),
            format_export_datetime(log.get("clock_in")),
            format_export_datetime(log.get("clock_out")),
            int(log.get("total_break_minutes") or 0),
            work_minutes,
            round(work_minutes / 60, 2),
            int(log.get("overtime_minutes") or 0),
            "Yes" if log.get("is_late") else "No",
            int(log.get("late_by_minutes") or 0),
            log.get("status", ""),
            log.get("clock_in_method", ""),
            log.get("clock_out_method", ""),
        ])

    workbook = build_xlsx_bytes(headers, rows, "Attendance")
    filename = f"attendance-{start}-to-{end}.xlsx"
    return StreamingResponse(
        BytesIO(workbook),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@api_router.get("/attendance/summary")
async def get_attendance_summary(request: Request, date: Optional[str] = None):
    _, restaurant_id = await resolve_restaurant_access(request, ATTENDANCE_MANAGER_ROLES)
    business_date = date or business_date_string(datetime.now(timezone.utc))
    staff_count = await db.users.count_documents({"restaurant_id": restaurant_id, "role": {"$in": STAFF_ROLES}})
    logs = await db.attendance_logs.find(
        {"restaurant_id": restaurant_id, "business_date": business_date},
        {"_id": 0},
    ).sort("clock_in", 1).to_list(1000)
    present_count = len(logs)
    active_count = sum(1 for log in logs if log.get("status") == "active")
    completed_count = sum(1 for log in logs if log.get("status") == "completed")
    late_count = sum(1 for log in logs if log.get("is_late"))
    total_work_minutes = sum(int(log.get("total_work_minutes") or 0) for log in logs)
    total_overtime_minutes = sum(int(log.get("overtime_minutes") or 0) for log in logs)
    return {
        "business_date": business_date,
        "staff_count": staff_count,
        "present_count": present_count,
        "absent_count": max(staff_count - present_count, 0),
        "active_count": active_count,
        "completed_count": completed_count,
        "late_count": late_count,
        "total_work_hours": round(total_work_minutes / 60, 2),
        "total_overtime_hours": round(total_overtime_minutes / 60, 2),
        "logs": logs,
    }


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
    diet_type = (input.diet_type or "veg").strip().lower()

    if not item_name:
        raise HTTPException(status_code=400, detail="Please enter an item name.")
    if not category_id:
        raise HTTPException(status_code=400, detail="Please select a category.")
    if input.price is None or input.price <= 0:
        raise HTTPException(status_code=400, detail="Please enter a valid item price.")
    if diet_type not in MENU_DIET_TYPES:
        raise HTTPException(status_code=400, detail="Please select Veg, Non-Veg, Egg or Vegan.")
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
        "diet_type": diet_type,
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
        headers=["Item Name", "Category Name", "Price", "Description", "Image URL", "Diet Type", "Available"],
        rows=[
            [
                item.get("name", ""),
                category_name_map.get(item.get("category_id"), ""),
                item.get("price", 0),
                item.get("description", ""),
                item.get("image", ""),
                {
                    "non_veg": "Non-Veg",
                    "egg": "Egg",
                    "vegan": "Vegan",
                }.get(item.get("diet_type"), "Veg"),
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
        diet_raw = (
            record.get("diet_type")
            or record.get("food_type")
            or record.get("type")
            or "veg"
        ).strip().lower().replace("-", "_").replace(" ", "_")
        if diet_raw in {"non_veg", "nonveg", "non_vegetarian", "nonvegetarian", "nv"}:
            diet_type = "non_veg"
        elif diet_raw in {"egg", "eggetarian", "eggitarian"}:
            diet_type = "egg"
        elif diet_raw in {"vegan"}:
            diet_type = "vegan"
        else:
            diet_type = "veg"
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
                    "diet_type": diet_type,
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
            "diet_type": diet_type,
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
    if "diet_type" in update_data:
        update_data["diet_type"] = (update_data["diet_type"] or "veg").strip().lower()
        if update_data["diet_type"] not in MENU_DIET_TYPES:
            raise HTTPException(status_code=400, detail="Please select Veg, Non-Veg, Egg or Vegan.")
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
    for table in tables:
        if table.get("table_id"):
            table["qr_code"] = build_table_qr_code(table["table_id"], request)
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
    await ensure_table_creation_allowed(restaurant_id)

    table_id = f"table_{secrets.token_hex(6)}"
    
    table_doc = {
        "table_id": table_id,
        "table_number": input.table_number,
        "restaurant_id": restaurant_id,
        "status": "available",
        "qr_code": build_table_qr_code(table_id, request),
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
    access_config = await get_restaurant_access_config(restaurant_id)
    ensure_access_flag(access_config, "table_management_enabled", "Table management")
    
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
    
    # Calculate total with one menu lookup instead of one DB call per cart item.
    total, order_items = await build_order_items_from_input(input.items, restaurant_id)
    
    latest_active_order = existing_active_orders[0] if existing_active_orders else None
    prioritized_add_on = any(order["status"] in ["pending", "accepted"] for order in existing_active_orders)

    order_id = f"ORD{secrets.token_hex(6).upper()}"
    
    schedule_background_task(upsert_customer_record(restaurant_id, session["customer_name"], session["phone"]))
    
    order_doc = {
        "order_id": order_id,
        "table_id": session["table_id"],
        "table_number": table.get("table_number"),
        "table_label": f"Table {table.get('table_number')}" if table.get("table_number") is not None else session["table_id"],
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
        "order_type": "dine_in",
        "order_source": "customer_qr",
        "created_by_role": "customer",
        "created_by_name": session["customer_name"],
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
        "timestamps": {
            "pending": datetime.now(timezone.utc).isoformat()
        }
    }
    await db.orders.insert_one(order_doc)

    created_order = (await enrich_orders([{k: v for k, v in order_doc.items() if k != "_id"}]))[0]

    schedule_background_task(emit_order_event('new_order', to_socket_payload(created_order), restaurant_id))
    if created_order.get("is_add_on"):
        schedule_background_task(sio.emit('kitchen_notification', {
            "type": "add_on",
            "order_id": created_order["order_id"],
            "table_id": created_order["table_id"],
            "table_label": created_order.get("table_label"),
            "message": f"Add-on order received for {created_order.get('table_label') or created_order['table_id']}"
        }, room=f'restaurant_{restaurant_id}'))
    
    return created_order


@api_router.post("/counter/orders")
async def create_counter_order(input: CounterOrderCreate, request: Request):
    """Create dine-in or takeaway orders directly from the billing counter."""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "billing", "kitchen_billing", "waiter"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    order_type = (input.order_type or "dine_in").strip().lower()
    if order_type not in ["dine_in", "takeaway"]:
        raise HTTPException(status_code=400, detail="order_type must be dine_in or takeaway")

    customer_name = (input.customer_name or "").strip()
    phone = (input.phone or "").strip()
    display_customer_name = customer_name or ("Takeaway Customer" if order_type == "takeaway" else "Walk-in Customer")
    if not input.items:
        raise HTTPException(status_code=400, detail="Please add at least one item.")

    table = None
    table_id = None
    table_number = None
    table_label = None

    order_items_task = build_order_items_from_input(input.items, restaurant_id)

    if order_type == "dine_in":
        table_id = (input.table_id or "").strip()
        if not table_id:
            raise HTTPException(status_code=400, detail="Please select a table for dine-in order.")
        table_task = db.tables.find_one({"table_id": table_id, "restaurant_id": restaurant_id}, {"_id": 0})
        existing_orders_task = db.orders.find({
            "table_id": table_id,
            "restaurant_id": restaurant_id,
            "status": {"$nin": ["served", "cancelled"]}
        }, {"_id": 0, "order_id": 1, "status": 1, "created_at": 1}).sort("created_at", -1).to_list(50)
        table, existing_active_orders, item_result = await asyncio.gather(
            table_task,
            existing_orders_task,
            order_items_task,
        )
        if not table:
            raise HTTPException(status_code=404, detail="Selected table not found.")
        total, order_items = item_result
        table_number = table.get("table_number")
        table_label = f"Table {table_number}" if table_number is not None else table_id
    else:
        table_id = f"takeaway_{secrets.token_hex(6)}"
        table_label = f"Takeaway {display_customer_name}"
        existing_active_orders = []
        total, order_items = await order_items_task

    latest_active_order = existing_active_orders[0] if existing_active_orders else None
    prioritized_add_on = any(order["status"] in ["pending", "accepted"] for order in existing_active_orders)

    order_doc = {
        "order_id": f"ORD{secrets.token_hex(6).upper()}",
        "table_id": table_id,
        "table_number": table_number,
        "table_label": table_label,
        "restaurant_id": restaurant_id,
        "customer_name": display_customer_name,
        "phone": phone,
        "items": order_items,
        "total": total,
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
    schedule_background_task(upsert_customer_record(restaurant_id, display_customer_name, phone))

    created_order = {k: v for k, v in order_doc.items() if k != "_id"}

    schedule_background_task(emit_order_event('new_order', to_socket_payload(created_order), restaurant_id))
    if created_order.get("is_add_on"):
        schedule_background_task(sio.emit('kitchen_notification', {
            "type": "add_on",
            "order_id": created_order["order_id"],
            "table_id": created_order["table_id"],
            "table_label": created_order.get("table_label"),
            "message": f"Add-on order received for {created_order.get('table_label') or created_order['table_id']}"
        }, room=f'restaurant_{restaurant_id}'))

    return created_order

@api_router.get("/orders")
async def get_orders(request: Request, status: str = None):
    """Get all orders (kitchen/billing dashboard - requires auth)"""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "kitchen", "kitchen_tv", "billing", "kitchen_billing", "waiter"]:
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


@api_router.get("/customer/orders")
async def get_customer_table_orders(customer_session_token: str):
    """Get active unpaid orders for the current customer table."""
    session = await db.customer_sessions.find_one({"session_token": customer_session_token})
    if not session:
        raise HTTPException(status_code=401, detail="Invalid session")

    table_id = session.get("table_id")
    restaurant_id = session.get("restaurant_id")
    if not restaurant_id and table_id:
        table = await db.tables.find_one({"table_id": table_id}, {"_id": 0, "restaurant_id": 1})
        restaurant_id = table.get("restaurant_id") if table else None
    if not table_id or not restaurant_id:
        raise HTTPException(status_code=400, detail="Customer session is not linked to a table.")

    orders = await db.orders.find({
        "table_id": table_id,
        "restaurant_id": restaurant_id,
        "status": {"$ne": "cancelled"},
        "payment_status": {"$ne": "completed"},
    }, {"_id": 0}).sort("created_at", 1).to_list(100)

    enriched_orders = await enrich_orders(orders)
    assistance_request = await db.assistance_requests.find_one({
        "table_id": table_id,
        "restaurant_id": restaurant_id,
        "status": "active",
    }, {"_id": 0})
    return {
        "table_id": table_id,
        "orders": enriched_orders,
        "assistance_request": assistance_request,
        "item_count": sum(
            sum(int(item.get("quantity") or 0) for item in order.get("items", []))
            for order in enriched_orders
        ),
        "combined_total": round(sum(float(order.get("total") or 0) for order in enriched_orders), 2),
    }


@api_router.post("/customer/assistance")
async def request_customer_assistance(request: Request):
    """Customer requests staff assistance for their current table."""
    try:
        data = await request.json()
    except Exception:
        data = {}

    customer_session_token = data.get("customer_session_token") or request.query_params.get("customer_session_token")
    if not customer_session_token:
        raise HTTPException(status_code=401, detail="customer_session_token is required")

    session = await db.customer_sessions.find_one({"session_token": customer_session_token})
    if not session:
        raise HTTPException(status_code=401, detail="Invalid session")

    table_id = session.get("table_id")
    restaurant_id = session.get("restaurant_id")
    table = None
    if table_id:
        table = await db.tables.find_one({"table_id": table_id}, {"_id": 0, "restaurant_id": 1, "table_number": 1})
        if not restaurant_id:
            restaurant_id = table.get("restaurant_id") if table else None
    if not table_id or not restaurant_id:
        raise HTTPException(status_code=400, detail="Customer session is not linked to a table.")

    now = datetime.now(timezone.utc)
    active_request = await db.assistance_requests.find_one({
        "table_id": table_id,
        "restaurant_id": restaurant_id,
        "status": "active",
    }, {"_id": 0})

    if active_request:
        request_id = active_request["request_id"]
        await db.assistance_requests.update_one(
            {"request_id": request_id, "restaurant_id": restaurant_id},
            {"$set": {"requested_at": now, "updated_at": now}}
        )
    else:
        request_id = f"HELP{secrets.token_hex(5).upper()}"
        active_request = {
            "request_id": request_id,
            "restaurant_id": restaurant_id,
            "table_id": table_id,
            "table_number": table.get("table_number") if table else None,
            "table_label": f"Table {table.get('table_number')}" if table and table.get("table_number") is not None else table_id,
            "customer_name": session.get("customer_name"),
            "phone": session.get("phone"),
            "status": "active",
            "requested_at": now,
            "created_at": now,
            "updated_at": now,
        }
        await db.assistance_requests.insert_one(active_request)

    assistance_request = await db.assistance_requests.find_one(
        {"request_id": request_id, "restaurant_id": restaurant_id},
        {"_id": 0}
    )
    assistance_payload = to_socket_payload(assistance_request)

    schedule_background_task(
        sio.emit(
            "assistance_requested",
            assistance_payload,
            room=f"restaurant_{restaurant_id}",
        )
    )

    return assistance_payload


@api_router.get("/assistance-requests")
async def get_assistance_requests(request: Request):
    """Get active customer assistance requests for billing/admin staff."""
    user = await get_current_user(request, db)
    if user["role"] not in ASSISTANCE_STAFF_ROLES:
        raise HTTPException(status_code=403, detail="Not authorized")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    requests = await db.assistance_requests.find({
        "restaurant_id": restaurant_id,
        "status": "active",
    }, {"_id": 0}).sort("requested_at", -1).to_list(100)
    return requests


@api_router.patch("/assistance-requests/{request_id}/resolve")
async def resolve_assistance_request(request_id: str, request: Request):
    """Mark a customer assistance request as resolved."""
    user = await get_current_user(request, db)
    if user["role"] not in ASSISTANCE_STAFF_ROLES:
        raise HTTPException(status_code=403, detail="Not authorized")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    resolved_at = datetime.now(timezone.utc)
    result = await db.assistance_requests.update_one(
        {
            "request_id": request_id,
            "restaurant_id": restaurant_id,
            "status": "active",
        },
        {"$set": {
            "status": "resolved",
            "resolved_at": resolved_at,
            "resolved_by": user.get("_id"),
            "updated_at": resolved_at,
        }}
    )
    if result.modified_count == 0:
        raise HTTPException(status_code=404, detail="Assistance request not found")

    schedule_background_task(
        sio.emit(
            "assistance_resolved",
            {"request_id": request_id, "resolved_at": resolved_at.isoformat()},
            room=f"restaurant_{restaurant_id}",
        )
    )

    return {"message": "Assistance request resolved"}


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


@api_router.post("/orders/{order_id}/request-bill")
async def request_order_bill(order_id: str, request: Request):
    """Allow a customer to request the bill after all active table orders are served."""
    try:
        data = await request.json()
    except Exception:
        data = {}

    customer_session_token = data.get("customer_session_token") or request.query_params.get("customer_session_token")
    if not customer_session_token:
        raise HTTPException(status_code=401, detail="customer_session_token is required")

    session = await db.customer_sessions.find_one({"session_token": customer_session_token})
    if not session:
        raise HTTPException(status_code=401, detail="Invalid session")

    table_id = session.get("table_id")
    restaurant_id = session.get("restaurant_id")
    if not restaurant_id and table_id:
        table = await db.tables.find_one({"table_id": table_id}, {"_id": 0, "restaurant_id": 1})
        restaurant_id = table.get("restaurant_id") if table else None
    if not restaurant_id or not table_id:
        raise HTTPException(status_code=400, detail="Customer session is not linked to a table.")

    order = await db.orders.find_one({
        "order_id": order_id,
        "table_id": table_id,
        "restaurant_id": restaurant_id,
    }, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if order.get("status") == "cancelled":
        raise HTTPException(status_code=400, detail="Cancelled orders cannot request a bill.")
    if order.get("payment_status") == "completed":
        raise HTTPException(status_code=409, detail="Bill is already completed.")

    active_orders = await db.orders.find({
        "table_id": table_id,
        "restaurant_id": restaurant_id,
        "status": {"$nin": ["cancelled"]},
        "payment_status": {"$ne": "completed"},
    }, {"_id": 0}).sort("created_at", 1).to_list(100)
    if not active_orders:
        raise HTTPException(status_code=404, detail="No active orders found for this table.")
    if any(active_order.get("status") not in ["prepared", "served"] for active_order in active_orders):
        raise HTTPException(status_code=400, detail="Bill can be requested only after all active orders are served.")

    requested_at = datetime.now(timezone.utc)
    target_order_ids = [active_order["order_id"] for active_order in active_orders]
    await db.orders.update_many(
        {
            "order_id": {"$in": target_order_ids},
            "restaurant_id": restaurant_id,
        },
        {"$set": {
            "bill_requested": True,
            "bill_requested_at": requested_at,
            "updated_at": requested_at,
        }}
    )

    updated_orders = await db.orders.find({
        "order_id": {"$in": target_order_ids},
        "restaurant_id": restaurant_id,
    }, {"_id": 0}).sort("created_at", 1).to_list(len(target_order_ids))
    enriched_orders = await enrich_orders(updated_orders)

    for updated_order in enriched_orders:
        schedule_background_task(
            emit_order_event(
                "order_status_updated",
                to_socket_payload(updated_order),
                restaurant_id,
                updated_order["order_id"],
            )
        )

    schedule_background_task(
        sio.emit(
            "bill_requested",
            {
                "order_id": order_id,
                "order_ids": target_order_ids,
                "table_id": table_id,
                "table_label": enriched_orders[0].get("table_label") if enriched_orders else table_id,
                "requested_at": requested_at.isoformat(),
            },
            room=f"restaurant_{restaurant_id}",
        )
    )

    return {
        "message": "Bill requested successfully.",
        "requested_at": requested_at,
        "orders": enriched_orders,
    }
    
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
    if user["role"] not in ["admin", "billing", "kitchen_billing"]:
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

    existing_items = list(order.get("items", []))
    existing_item_ids = {item.get("item_id") for item in existing_items}
    existing_item_metadata = {}
    for item in existing_items:
        existing_item_metadata.setdefault(item.get("item_id"), item)
    requested_item_ids = [item.item_id for item in input.items]
    if any(item_id not in existing_item_ids for item_id in requested_item_ids):
        raise HTTPException(status_code=400, detail="Only items already in the order can be edited.")

    menu_items = await db.menu_items.find(
        {"item_id": {"$in": requested_item_ids}, "restaurant_id": restaurant_id},
        {"_id": 0, "item_id": 1, "name": 1, "price": 1, "diet_type": 1}
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
            "diet_type": menu_item.get("diet_type", "veg"),
            "instructions": (item.instructions or "").strip(),
        }
        existing_item = existing_item_metadata.get(item.item_id, {})
        for metadata_key in [
            "cancelled_quantity",
            "cancelled_at",
            "cancelled_by",
            "cancelled_by_name",
            "cancellation_reason",
            "item_status",
            "reallocated_quantity",
            "reallocated_to_order_id",
            "reallocated_to_table_label",
            "reallocated_from_order_id",
            "reallocated_from_table_label",
            "reallocated_from_cancelled_quantity",
            "reallocation_status",
            "reallocated_at",
            "loss_quantity",
            "loss_amount",
            "ready",
            "ready_updated_at",
        ]:
            if metadata_key in existing_item:
                updated_item[metadata_key] = existing_item[metadata_key]
        if get_item_cancelled_quantity(updated_item) >= updated_item["quantity"]:
            updated_item["cancelled_quantity"] = updated_item["quantity"]
            updated_item["item_status"] = "cancelled"
        updated_items.append(updated_item)
        total += get_item_billable_quantity(updated_item) * updated_item["price"]

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
    schedule_background_task(
        emit_order_event('order_status_updated', to_socket_payload(enriched[0]), restaurant_id, order_id)
    )
    return enriched[0]


@api_router.patch("/orders/{order_id}/items/{item_index}/cancel")
async def cancel_order_item(order_id: str, item_index: int, input: OrderItemCancelRequest, request: Request):
    """Cancel an order item quantity and optionally reallocate it to another active matching order."""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "billing", "kitchen_billing", "kitchen"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    order = await db.orders.find_one({"order_id": order_id, "restaurant_id": restaurant_id})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if order.get("payment_status") == "completed" or order.get("status") in ["served", "cancelled"]:
        raise HTTPException(status_code=400, detail="Paid, served, or cancelled orders cannot be changed.")

    items = list(order.get("items", []))
    if item_index < 0 or item_index >= len(items):
        raise HTTPException(status_code=400, detail="Invalid item index")

    source_item = dict(items[item_index])
    available_quantity = get_item_billable_quantity(source_item)
    cancel_quantity = min(int(input.quantity), available_quantity)
    if cancel_quantity <= 0:
        raise HTTPException(status_code=400, detail="This item is already fully cancelled.")

    now = datetime.now(timezone.utc)
    reason = (input.reason or "Customer cancelled verbally").strip()
    actor = user.get("name") or user.get("email") or user.get("role")
    item_id = source_item.get("item_id")
    source_ready = bool(source_item.get("ready")) or order.get("status") in ["accepted", "prepared"]

    target_order = None
    target_order_updated = None
    reallocation_record = None

    if input.allow_reallocation and item_id:
        candidate_orders = await db.orders.find(
            {
                "restaurant_id": restaurant_id,
                "order_id": {"$ne": order_id},
                "status": {"$in": ["pending", "accepted"]},
                "payment_status": {"$ne": "completed"},
                "items.item_id": item_id,
            },
            {"_id": 0}
        ).sort("created_at", 1).to_list(200)

        for candidate in candidate_orders:
            candidate_items = list(candidate.get("items", []))
            candidate_item_index = None
            for index, candidate_item in enumerate(candidate_items):
                if candidate_item.get("item_id") != item_id:
                    continue
                if candidate_item.get("ready"):
                    continue
                if get_item_billable_quantity(candidate_item) <= 0:
                    continue
                candidate_item_index = index
                break

            if candidate_item_index is None:
                continue

            target_order = candidate
            target_item = dict(candidate_items[candidate_item_index])
            existing_received = int(target_item.get("reallocated_from_cancelled_quantity") or 0)
            source_table_label = order.get("table_label") or (
                f"Table {order.get('table_number')}" if order.get("table_number") is not None else order.get("table_id")
            )
            target_table_label = candidate.get("table_label") or (
                f"Table {candidate.get('table_number')}" if candidate.get("table_number") is not None else candidate.get("table_id")
            )
            target_item.update({
                "reallocated_from_order_id": order_id,
                "reallocated_from_table_label": source_table_label,
                "reallocated_from_cancelled_quantity": existing_received + cancel_quantity,
                "reallocation_status": "received_from_cancelled_order",
                "reallocated_at": now.isoformat(),
            })
            if source_ready:
                target_item["ready"] = True
                target_item["ready_updated_at"] = now.isoformat()
                target_item["item_status"] = "reallocated"
            else:
                target_item["item_status"] = target_item.get("item_status") or "pending"
            candidate_items[candidate_item_index] = target_item

            await db.orders.update_one(
                {"order_id": candidate["order_id"], "restaurant_id": restaurant_id},
                {"$set": {"items": candidate_items, "updated_at": now}}
            )
            target_order_updated = await db.orders.find_one(
                {"order_id": candidate["order_id"], "restaurant_id": restaurant_id},
                {"_id": 0}
            )
            reallocation_record = {
                "reallocation_id": f"REALLOC{secrets.token_hex(6).upper()}",
                "restaurant_id": restaurant_id,
                "source_order_id": order_id,
                "target_order_id": candidate["order_id"],
                "item_id": item_id,
                "item_name": source_item.get("name"),
                "quantity_reallocated": cancel_quantity,
                "reallocated_at": now,
                "reallocated_by": user.get("_id") or actor,
                "reason": reason,
            }
            await db.order_item_reallocations.insert_one(reallocation_record)
            break

    existing_cancelled = get_item_cancelled_quantity(source_item)
    existing_loss_quantity = int(source_item.get("loss_quantity") or 0)
    existing_loss_amount = float(source_item.get("loss_amount") or 0)
    source_item.update({
        "cancelled_quantity": existing_cancelled + cancel_quantity,
        "cancelled_at": now.isoformat(),
        "cancelled_by": user.get("_id") or actor,
        "cancelled_by_name": actor,
        "cancellation_reason": reason,
        "item_status": "cancelled" if available_quantity == cancel_quantity else "partially_cancelled",
            "reallocated_quantity": cancel_quantity if target_order else int(source_item.get("reallocated_quantity") or 0),
            "reallocated_to_order_id": target_order.get("order_id") if target_order else source_item.get("reallocated_to_order_id"),
            "reallocated_to_table_label": target_table_label if target_order else source_item.get("reallocated_to_table_label"),
            "reallocation_status": "reallocated" if target_order else "loss",
            "loss_quantity": existing_loss_quantity if target_order else existing_loss_quantity + cancel_quantity,
            "loss_amount": existing_loss_amount if target_order else round(existing_loss_amount + (cancel_quantity * float(source_item.get("price") or 0)), 2),
    })
    items[item_index] = source_item

    updated_total = calculate_order_items_total(items)
    next_status = "cancelled" if not order_has_billable_items(items) else order.get("status", "pending")
    update_fields = {
        "items": items,
        "total": updated_total,
        "status": next_status,
        "updated_at": now,
    }
    if next_status == "cancelled":
        timestamps = order.get("timestamps", {})
        timestamps["cancelled"] = now.isoformat()
        update_fields["timestamps"] = timestamps

    cancellation_record = {
        "cancellation_id": f"CANCEL{secrets.token_hex(6).upper()}",
        "restaurant_id": restaurant_id,
        "order_id": order_id,
        "table_id": order.get("table_id"),
        "table_label": order.get("table_label"),
        "item_index": item_index,
        "item_id": item_id,
        "item_name": source_item.get("name"),
        "quantity_cancelled": cancel_quantity,
        "reason": reason,
        "cancelled_by": user.get("_id") or actor,
        "cancelled_by_name": actor,
        "cancelled_at": now,
        "reallocated_to_order_id": target_order.get("order_id") if target_order else None,
        "reallocated_to_table_label": target_table_label if target_order else None,
        "reallocation_status": "reallocated" if target_order else "loss",
        "loss_quantity": 0 if target_order else cancel_quantity,
        "loss_amount": 0 if target_order else round(cancel_quantity * float(source_item.get("price") or 0), 2),
    }

    await db.orders.update_one(
        {"order_id": order_id, "restaurant_id": restaurant_id},
        {"$set": update_fields}
    )
    await db.order_item_cancellations.insert_one(cancellation_record)

    updated_source_order = await db.orders.find_one({"order_id": order_id, "restaurant_id": restaurant_id}, {"_id": 0})
    enriched_source = (await enrich_orders([updated_source_order]))[0]
    enriched_target = (await enrich_orders([target_order_updated]))[0] if target_order_updated else None
    payload = {
        "source_order": enriched_source,
        "target_order": enriched_target,
        "cancellation": {k: v for k, v in cancellation_record.items() if k != "_id"},
        "reallocation": {k: v for k, v in reallocation_record.items() if k != "_id"} if reallocation_record else None,
        "message": build_item_cancellation_message(source_item.get("name") or "Item", cancel_quantity, enriched_target),
    }

    schedule_background_task(
        emit_order_event('order_item_cancelled', to_socket_payload(payload), restaurant_id, order_id)
    )
    schedule_background_task(
        emit_order_event('order_status_updated', to_socket_payload(enriched_source), restaurant_id, order_id)
    )
    if enriched_target:
        schedule_background_task(
            emit_order_event('order_item_reallocated', to_socket_payload(payload), restaurant_id, enriched_target["order_id"])
        )
        schedule_background_task(
            emit_order_event('order_status_updated', to_socket_payload(enriched_target), restaurant_id, enriched_target["order_id"])
        )

    return payload


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
                {"_id": 0, "total": 1, "order_type": 1}
            ).to_list(len(remaining_order_ids))
            remaining_subtotal = round(sum(item.get("total", 0) for item in remaining_orders), 2)
            discount = payment.get("discount", 0) or 0
            settings = {
                "tax_enabled": bool(payment.get("tax_percentage", 0)),
                "tax_percentage": payment.get("tax_percentage", 0),
                "service_charge_enabled": bool(payment.get("service_charge_percentage", 0)),
                "service_charge_percentage": payment.get("service_charge_percentage", 0),
                "parcel_charge_enabled": bool(payment.get("parcel_charge", 0)),
                "parcel_charge": payment.get("parcel_charge", 0),
            }
            remaining_bill = calculate_bill_amounts(
                remaining_subtotal,
                settings,
                any(order.get("order_type") == "takeaway" for order in remaining_orders),
                discount,
            )
            await db.payments.update_one(
                {"payment_id": payment["payment_id"], "restaurant_id": restaurant_id},
                {"$set": {
                    "order_id": remaining_order_ids[0],
                    "order_ids": remaining_order_ids,
                    "subtotal": remaining_bill["subtotal"],
                    "tax": remaining_bill["tax"],
                    "service_charge": remaining_bill["service_charge"],
                    "parcel_charge": remaining_bill["parcel_charge"],
                    "total": remaining_bill["total"],
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
    if user["role"] not in ["admin", "kitchen", "kitchen_tv", "billing", "kitchen_billing"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    data = await request.json()
    new_status = data.get("status")
    mark_items_ready = bool(data.get("mark_items_ready"))
    
    if new_status not in ["accepted", "prepared", "served", "cancelled"]:
        raise HTTPException(status_code=400, detail="Invalid status")
    
    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    order = await db.orders.find_one({"order_id": order_id, "restaurant_id": restaurant_id})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if order.get("payment_status") == "completed":
        if order.get("status") != "served":
            repaired_at = datetime.now(timezone.utc)
            timestamps = order.get("timestamps", {})
            timestamps["served"] = timestamps.get("served") or repaired_at.isoformat()
            await db.orders.update_one(
                {"order_id": order_id, "restaurant_id": restaurant_id},
                {"$set": {
                    "status": "served",
                    "timestamps": timestamps,
                    "updated_at": repaired_at,
                }}
            )
            repaired_order = await db.orders.find_one({"order_id": order_id, "restaurant_id": restaurant_id}, {"_id": 0})
            schedule_background_task(
                emit_order_event('order_status_updated', to_socket_payload(repaired_order), restaurant_id, order_id)
            )
        raise HTTPException(status_code=400, detail="Payment is already completed. Paid orders cannot be changed in kitchen.")
    
    # Update timestamps
    changed_at = datetime.now(timezone.utc)
    timestamps = order.get("timestamps", {})
    timestamps[new_status] = changed_at.isoformat()
    update_fields = {
        "status": new_status,
        "timestamps": timestamps,
        "updated_at": changed_at
    }
    if new_status == "prepared" and mark_items_ready:
        update_fields["items"] = [
            {**item, "ready": True, "ready_updated_at": changed_at.isoformat()}
            for item in order.get("items", [])
        ]
    
    await db.orders.update_one(
        {"order_id": order_id, "restaurant_id": restaurant_id},
        {"$set": update_fields}
    )
    
    updated_order = {k: v for k, v in order.items() if k != "_id"}
    updated_order["status"] = new_status
    if "items" in update_fields:
        updated_order["items"] = update_fields["items"]
    updated_order["timestamps"] = timestamps
    updated_order["updated_at"] = changed_at
    if not updated_order.get("table_label"):
        if updated_order.get("table_number") is not None:
            updated_order["table_label"] = f"Table {updated_order['table_number']}"
        else:
            updated_order["table_label"] = updated_order.get("table_id")
    
    schedule_background_task(
        emit_order_event('order_status_updated', to_socket_payload(updated_order), restaurant_id, order_id)
    )
    
    return updated_order


@api_router.put("/orders/{order_id}/items/{item_index}/ready")
async def update_order_item_ready(order_id: str, item_index: int, request: Request):
    """Update a kitchen item's ready state for TV display screens."""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "kitchen", "kitchen_tv", "kitchen_billing"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    data = await request.json()
    ready = bool(data.get("ready"))

    order = await db.orders.find_one({"order_id": order_id, "restaurant_id": restaurant_id})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if order.get("payment_status") == "completed":
        raise HTTPException(status_code=400, detail="Payment is already completed. Paid orders cannot be changed in kitchen.")
    if order.get("status") in ["served", "cancelled"]:
        raise HTTPException(status_code=400, detail="Completed or cancelled orders cannot be changed.")

    items = list(order.get("items", []))
    if item_index < 0 or item_index >= len(items):
        raise HTTPException(status_code=400, detail="Invalid item index")

    changed_at = datetime.now(timezone.utc)
    items[item_index] = {
        **items[item_index],
        "ready": ready,
        "ready_updated_at": changed_at.isoformat(),
    }

    await db.orders.update_one(
        {"order_id": order_id, "restaurant_id": restaurant_id},
        {"$set": {"items": items, "updated_at": changed_at}}
    )

    updated_order = await db.orders.find_one({"order_id": order_id, "restaurant_id": restaurant_id}, {"_id": 0})
    enriched = await enrich_orders([updated_order])
    schedule_background_task(
        emit_order_event('order_status_updated', to_socket_payload(enriched[0]), restaurant_id, order_id)
    )
    return enriched[0]



# ============ Payment Endpoints ============
@api_router.post("/payments")
async def create_payment(input: PaymentCreate, request: Request):
    """Create payment (billing/admin - requires auth)"""
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "billing", "kitchen_billing"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    target_order_ids = input.order_ids or ([input.order_id] if input.order_id else [])
    target_order_ids = list(dict.fromkeys(target_order_ids))
    if not target_order_ids:
        raise HTTPException(status_code=400, detail="Please select at least one order to bill.")

    orders_task = db.orders.find({
        "order_id": {"$in": target_order_ids},
        "restaurant_id": restaurant_id
    }, {"_id": 0}).to_list(len(target_order_ids))
    existing_payment_task = db.payments.find_one({
        "restaurant_id": restaurant_id,
        "status": "completed",
        "$or": [
            {"order_id": {"$in": target_order_ids}},
            {"order_ids": {"$in": target_order_ids}},
        ],
    }, {"_id": 0})
    restaurant_task = db.restaurants.find_one({"restaurant_id": restaurant_id}, {"_id": 0})
    orders, existing_payment, restaurant = await asyncio.gather(
        orders_task,
        existing_payment_task,
        restaurant_task,
    )
    if len(orders) != len(target_order_ids):
        raise HTTPException(status_code=404, detail="One or more orders were not found")
    if existing_payment:
        raise HTTPException(status_code=409, detail="Bill generated already.")
    if any(not is_billable_order(order) for order in orders):
        raise HTTPException(status_code=400, detail="Only prepared orders or billing-counter orders can be billed.")
    if any(order.get("payment_status") in ["completed", "processing"] for order in orders):
        raise HTTPException(status_code=409, detail="Bill generated already.")

    table_ids = {order["table_id"] for order in orders}
    if len(table_ids) != 1:
        raise HTTPException(status_code=400, detail="Orders must belong to the same table to create one bill.")
    table_id = orders[0]["table_id"]
    table_number = orders[0].get("table_number")
    billing_lock_id = f"LOCK{secrets.token_hex(6).upper()}"

    lock_result = await db.orders.update_many(
        {
            "order_id": {"$in": target_order_ids},
            "restaurant_id": restaurant_id,
            "$and": [
                {
                    "$or": [
                        {"status": {"$in": ["prepared", "served"]}},
                        {"order_source": "billing_counter", "status": {"$in": ["pending", "accepted"]}},
                    ],
                },
                {
                    "$or": [
                        {"payment_status": {"$exists": False}},
                        {"payment_status": {"$nin": ["completed", "processing"]}},
                    ],
                },
            ],
        },
        {"$set": {
            "payment_status": "processing",
            "billing_lock_id": billing_lock_id,
            "updated_at": datetime.now(timezone.utc),
        }}
    )
    if lock_result.modified_count != len(target_order_ids):
        raise HTTPException(status_code=409, detail="Bill generated already.")
    
    subtotal = round(sum(order["total"] for order in orders), 2)
    billing_settings = normalize_billing_settings(restaurant)
    bill_amounts = calculate_bill_amounts(
        subtotal,
        billing_settings,
        any(order.get("order_type") == "takeaway" for order in orders),
        input.discount or 0,
    )
    bill_id = f"BILL{secrets.token_hex(5).upper()}"
    
    payment_doc = {
        "payment_id": f"PAY{secrets.token_hex(6).upper()}",
        "bill_id": bill_id,
        "order_id": target_order_ids[0],
        "order_ids": target_order_ids,
        "restaurant_id": restaurant_id,
        "table_id": table_id,
        "table_number": table_number,
        "subtotal": bill_amounts["subtotal"],
        "tax": bill_amounts["tax"],
        "tax_percentage": bill_amounts["tax_percentage"],
        "service_charge": bill_amounts["service_charge"],
        "service_charge_percentage": bill_amounts["service_charge_percentage"],
        "parcel_charge": bill_amounts["parcel_charge"],
        "discount": bill_amounts["discount"],
        "total": bill_amounts["total"],
        "payment_method": input.payment_method,
        "status": "completed",
        "created_at": datetime.now(timezone.utc),
        "created_by": user["_id"],
        "whatsapp_status": "queued",
    }
    try:
        await db.payments.insert_one(payment_doc)
        
        served_at = datetime.now(timezone.utc)
        await db.orders.update_many(
            {"order_id": {"$in": target_order_ids}, "restaurant_id": restaurant_id, "billing_lock_id": billing_lock_id},
            {"$set": {
                "status": "served",
                "payment_status": "completed",
                "updated_at": served_at,
                "timestamps.served": served_at.isoformat()
            }, "$unset": {
                "billing_lock_id": ""
            }}
        )
    except Exception:
        await db.orders.update_many(
            {"order_id": {"$in": target_order_ids}, "restaurant_id": restaurant_id, "billing_lock_id": billing_lock_id},
            {"$set": {
                "payment_status": "pending",
                "updated_at": datetime.now(timezone.utc),
            }, "$unset": {
                "billing_lock_id": ""
            }}
        )
        raise

    if (input.payment_method or "").strip().lower() == "cash":
        schedule_background_task(
            sio.emit(
                "cash_drawer_updated",
                {"reason": "cash_payment", "payment_id": payment_doc["payment_id"]},
                room=f"restaurant_{restaurant_id}",
            )
        )

    for order in orders:
        updated_order = dict(order)
        updated_order["status"] = "served"
        updated_order["payment_status"] = "completed"
        updated_order["updated_at"] = served_at
        updated_order["payment"] = {k: v for k, v in payment_doc.items() if k != "_id"}
        timestamps = dict(updated_order.get("timestamps") or {})
        timestamps["served"] = served_at.isoformat()
        updated_order["timestamps"] = timestamps
        if not updated_order.get("table_label"):
            if updated_order.get("table_number") is not None:
                updated_order["table_label"] = f"Table {updated_order['table_number']}"
            else:
                updated_order["table_label"] = updated_order.get("table_id")
        schedule_background_task(
            emit_order_event(
                'order_status_updated',
                to_socket_payload(updated_order),
                restaurant_id,
                updated_order["order_id"]
            )
        )

    schedule_background_task(send_bill_pdf_via_evolution(payment_doc, orders, restaurant, db))
    
    return {k: v for k, v in payment_doc.items() if k != "_id"}


@api_router.post("/pos/checkout")
async def create_pos_checkout(input: PosCheckoutCreate, request: Request):
    """Create a POS-only bill without sending the order through kitchen approval."""
    user = await get_current_user(request, db)
    if user["role"] != "pos":
        raise HTTPException(status_code=403, detail="POS access required")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    await check_restaurant_subscription(db, restaurant_id)

    order_type = (input.order_type or "dine_in").strip().lower()
    if order_type not in ["dine_in", "takeaway"]:
        raise HTTPException(status_code=400, detail="order_type must be dine_in or takeaway")

    payment_method = (input.payment_method or "").strip().lower()
    if payment_method not in ["cash", "upi", "card"]:
        raise HTTPException(status_code=400, detail="payment_method must be cash, upi, or card")

    if not input.items:
        raise HTTPException(status_code=400, detail="Please add at least one item.")

    customer_name = (input.customer_name or "").strip()
    phone = (input.phone or "").strip()
    display_customer_name = customer_name or ("Takeaway Customer" if order_type == "takeaway" else "Walk-in Customer")
    table_id = None
    table_number = None
    table_label = None

    restaurant_task = check_restaurant_subscription(db, restaurant_id)
    order_items_task = build_order_items_from_input(input.items, restaurant_id)

    if order_type == "dine_in":
        table_id = (input.table_id or "").strip()
        if not table_id:
            raise HTTPException(status_code=400, detail="Please select a table for dine-in order.")
        restaurant, item_result, table = await asyncio.gather(
            restaurant_task,
            order_items_task,
            db.tables.find_one({"table_id": table_id, "restaurant_id": restaurant_id}, {"_id": 0}),
        )
        if not table:
            raise HTTPException(status_code=404, detail="Selected table not found.")
        subtotal, order_items = item_result
        table_number = table.get("table_number")
        table_label = f"Table {table_number}" if table_number is not None else table_id
    else:
        table_id = f"pos_takeaway_{secrets.token_hex(6)}"
        table_label = f"Takeaway {display_customer_name}"
        restaurant, item_result = await asyncio.gather(restaurant_task, order_items_task)
        subtotal, order_items = item_result

    billing_settings = normalize_billing_settings(restaurant)
    bill_amounts = calculate_bill_amounts(
        subtotal,
        billing_settings,
        order_type == "takeaway",
        input.discount or 0,
    )
    now = datetime.now(timezone.utc)
    order_id = f"ORD{secrets.token_hex(6).upper()}"
    bill_id = f"BILL{secrets.token_hex(5).upper()}"

    order_doc = {
        "order_id": order_id,
        "table_id": table_id,
        "table_number": table_number,
        "table_label": table_label,
        "restaurant_id": restaurant_id,
        "customer_name": display_customer_name,
        "phone": phone,
        "items": order_items,
        "total": subtotal,
        "status": "served",
        "payment_status": "completed",
        "is_add_on": False,
        "add_on_to_order_id": None,
        "priority": "normal",
        "order_type": order_type,
        "order_source": "pos",
        "created_by_role": user["role"],
        "created_by_name": user.get("name") or user.get("email"),
        "created_at": now,
        "updated_at": now,
        "timestamps": {
            "pending": now.isoformat(),
            "accepted": now.isoformat(),
            "prepared": now.isoformat(),
            "served": now.isoformat(),
        },
    }
    payment_doc = {
        "payment_id": f"PAY{secrets.token_hex(6).upper()}",
        "bill_id": bill_id,
        "order_id": order_id,
        "order_ids": [order_id],
        "restaurant_id": restaurant_id,
        "table_id": table_id,
        "table_number": table_number,
        "subtotal": bill_amounts["subtotal"],
        "tax": bill_amounts["tax"],
        "tax_percentage": bill_amounts["tax_percentage"],
        "service_charge": bill_amounts["service_charge"],
        "service_charge_percentage": bill_amounts["service_charge_percentage"],
        "parcel_charge": bill_amounts["parcel_charge"],
        "discount": bill_amounts["discount"],
        "total": bill_amounts["total"],
        "payment_method": payment_method,
        "status": "completed",
        "created_at": now,
        "created_by": user["_id"],
        "created_by_role": user["role"],
        "whatsapp_status": "queued",
    }

    await db.orders.insert_one(order_doc)
    try:
        await db.payments.insert_one(payment_doc)
    except Exception:
        await db.orders.delete_one({"order_id": order_id, "restaurant_id": restaurant_id})
        raise

    schedule_background_task(upsert_customer_record(restaurant_id, display_customer_name, phone))
    schedule_background_task(send_bill_pdf_via_evolution(payment_doc, [order_doc], restaurant, db))
    if payment_method == "cash":
        schedule_background_task(
            sio.emit(
                "cash_drawer_updated",
                {"reason": "pos_cash_payment", "payment_id": payment_doc["payment_id"]},
                room=f"restaurant_{restaurant_id}",
            )
        )

    if not input.print_bill:
        return {
            "bill_id": bill_id,
            "table_label": table_label,
            "customer_name": display_customer_name,
            "payment": {k: v for k, v in payment_doc.items() if k != "_id"},
            "orders": [],
        }

    completed_order = (await enrich_orders([{k: v for k, v in order_doc.items() if k != "_id"}]))[0]
    return {
        "bill_id": bill_id,
        "table_label": table_label,
        "customer_name": display_customer_name,
        "payment": {k: v for k, v in payment_doc.items() if k != "_id"},
        "orders": [completed_order],
    }


@api_router.get("/pos/summary")
async def get_pos_summary(request: Request):
    user = await get_current_user(request, db)
    if user["role"] != "pos":
        raise HTTPException(status_code=403, detail="POS access required")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    return await build_transaction_summary(restaurant_id, build_period_date_match("daily"))


@api_router.get("/pos/completed-bills")
async def get_pos_completed_bills(request: Request, period: str = "daily"):
    user = await get_current_user(request, db)
    if user["role"] != "pos":
        raise HTTPException(status_code=403, detail="POS access required")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    payment_query = {
        "restaurant_id": restaurant_id,
        "status": "completed",
        "created_at": build_period_date_match(period),
    }
    payments = await db.payments.find(payment_query, {"_id": 0}).sort("created_at", -1).to_list(5000)
    linked_order_ids = sorted({
        order_id
        for payment in payments
        for order_id in (payment.get("order_ids") or ([payment.get("order_id")] if payment.get("order_id") else []))
        if order_id
    })

    order_map = {}
    if linked_order_ids:
        orders = await db.orders.find(
            {"restaurant_id": restaurant_id, "order_id": {"$in": linked_order_ids}},
            {"_id": 0}
        ).to_list(len(linked_order_ids))
        enriched_orders = await enrich_orders(orders)
        order_map = {order["order_id"]: order for order in enriched_orders}

    completed_bills = []
    for payment in payments:
        payment_order_ids = payment.get("order_ids") or ([payment.get("order_id")] if payment.get("order_id") else [])
        payment_orders = [order_map[order_id] for order_id in payment_order_ids if order_id in order_map]
        first_order = payment_orders[0] if payment_orders else {}
        completed_bills.append({
            "bill_id": payment.get("bill_id") or payment.get("payment_id"),
            "table_label": first_order.get("table_label") or payment.get("table_id") or "",
            "customer_name": first_order.get("customer_name") or "",
            "payment": payment,
            "orders": payment_orders,
        })

    return completed_bills


@api_router.patch("/pos/completed-bills/{bill_id}")
async def update_pos_completed_bill(bill_id: str, input: PosBillUpdate, request: Request):
    user = await get_current_user(request, db)
    if user["role"] != "pos":
        raise HTTPException(status_code=403, detail="POS access required")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    payment = await db.payments.find_one(
        {
            "restaurant_id": restaurant_id,
            "status": "completed",
            "$or": [{"bill_id": bill_id}, {"payment_id": bill_id}],
        },
        {"_id": 0}
    )
    if not payment:
        raise HTTPException(status_code=404, detail="Bill not found")

    payment_order_ids = payment.get("order_ids") or ([payment.get("order_id")] if payment.get("order_id") else [])
    orders = []
    if payment_order_ids:
        orders = await db.orders.find(
            {"restaurant_id": restaurant_id, "order_id": {"$in": payment_order_ids}},
            {"_id": 0}
        ).to_list(len(payment_order_ids))

    update_payment = {}
    update_order = {}
    subtotal = round(sum(order.get("total", 0) for order in orders), 2) if orders else payment.get("subtotal", 0)
    is_takeaway = any(order.get("order_type") == "takeaway" for order in orders)
    payment_method = (input.payment_method or payment.get("payment_method") or "").strip().lower()
    if input.payment_method is not None:
        if payment_method not in ["cash", "upi", "card"]:
            raise HTTPException(status_code=400, detail="payment_method must be cash, upi, or card")
        update_payment["payment_method"] = payment_method

    if input.items is not None:
        if not input.items:
            raise HTTPException(status_code=400, detail="Bill must have at least one item.")
        if not payment_order_ids:
            raise HTTPException(status_code=400, detail="Bill has no linked POS order.")
        subtotal, order_items = await build_order_items_from_input(input.items, restaurant_id)
        update_order["items"] = order_items
        update_order["total"] = subtotal

    if input.discount is not None or input.items is not None:
        settings = {
            "tax_enabled": bool(payment.get("tax_percentage", 0)),
            "tax_percentage": payment.get("tax_percentage", 0),
            "service_charge_enabled": bool(payment.get("service_charge_percentage", 0)),
            "service_charge_percentage": payment.get("service_charge_percentage", 0),
            "parcel_charge_enabled": bool(payment.get("parcel_charge", 0)),
            "parcel_charge": payment.get("parcel_charge", 0),
        }
        bill_amounts = calculate_bill_amounts(
            subtotal,
            settings,
            is_takeaway,
            input.discount if input.discount is not None else payment.get("discount", 0),
        )
        update_payment.update({
            "subtotal": bill_amounts["subtotal"],
            "tax": bill_amounts["tax"],
            "service_charge": bill_amounts["service_charge"],
            "parcel_charge": bill_amounts["parcel_charge"],
            "discount": bill_amounts["discount"],
            "total": bill_amounts["total"],
        })

    if input.customer_name is not None:
        update_order["customer_name"] = (input.customer_name or "").strip() or "Walk-in Customer"
    if input.phone is not None:
        update_order["phone"] = (input.phone or "").strip()

    now = datetime.now(timezone.utc)
    if update_payment:
        update_payment["updated_at"] = now
        await db.payments.update_one(
            {"payment_id": payment["payment_id"], "restaurant_id": restaurant_id},
            {"$set": update_payment}
        )
    if update_order and payment_order_ids:
        update_order["updated_at"] = now
        await db.orders.update_many(
            {"restaurant_id": restaurant_id, "order_id": {"$in": payment_order_ids}},
            {"$set": update_order}
        )

    if update_payment.get("payment_method") == "cash" or payment.get("payment_method") == "cash":
        schedule_background_task(
            sio.emit(
                "cash_drawer_updated",
                {"reason": "pos_bill_updated", "payment_id": payment["payment_id"]},
                room=f"restaurant_{restaurant_id}",
            )
        )

    return {"message": "Bill updated successfully"}


@api_router.delete("/pos/completed-bills/{bill_id}")
async def delete_pos_completed_bill(bill_id: str, input: PosBillDeleteRequest, request: Request):
    user = await get_current_user(request, db)
    if user["role"] != "pos":
        raise HTTPException(status_code=403, detail="POS access required")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    payment = await db.payments.find_one(
        {
            "restaurant_id": restaurant_id,
            "status": "completed",
            "$or": [{"bill_id": bill_id}, {"payment_id": bill_id}],
        },
        {"_id": 0}
    )
    if not payment:
        raise HTTPException(status_code=404, detail="Bill not found")

    delete_reason = (input.reason or "").strip()
    if not delete_reason:
        raise HTTPException(status_code=400, detail="Delete reason is required.")

    payment_order_ids = payment.get("order_ids") or ([payment.get("order_id")] if payment.get("order_id") else [])
    deleted_orders = []
    if payment_order_ids:
        deleted_orders = await db.orders.find(
            {"restaurant_id": restaurant_id, "order_id": {"$in": payment_order_ids}},
            {"_id": 0}
        ).to_list(len(payment_order_ids))

    deleted_at = datetime.now(timezone.utc)
    await db.deleted_bills.insert_one({
        "deleted_bill_id": f"DELBILL{secrets.token_hex(6).upper()}",
        "restaurant_id": restaurant_id,
        "bill_id": payment.get("bill_id") or payment.get("payment_id"),
        "payment_id": payment.get("payment_id"),
        "order_ids": payment_order_ids,
        "payment": payment,
        "orders": deleted_orders,
        "reason": delete_reason,
        "deleted_by_user_id": user.get("user_id"),
        "deleted_by_name": user.get("name") or user.get("email"),
        "deleted_by_email": user.get("email"),
        "deleted_by_role": user.get("role"),
        "deleted_at": deleted_at,
    })

    await db.payments.delete_one({"payment_id": payment["payment_id"], "restaurant_id": restaurant_id})
    if payment_order_ids:
        await db.orders.delete_many({"restaurant_id": restaurant_id, "order_id": {"$in": payment_order_ids}})

    if (payment.get("payment_method") or "").strip().lower() == "cash":
        schedule_background_task(
            sio.emit(
                "cash_drawer_updated",
                {"reason": "pos_bill_deleted", "payment_id": payment["payment_id"]},
                room=f"restaurant_{restaurant_id}",
            )
        )

    return {"message": "Bill deleted successfully"}


@api_router.delete("/payments/completed/{bill_id}")
async def delete_completed_payment_bill(bill_id: str, input: PosBillDeleteRequest, request: Request):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "billing", "kitchen_billing"]:
        raise HTTPException(status_code=403, detail="Billing access required")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    delete_reason = (input.reason or "").strip()
    if not delete_reason:
        raise HTTPException(status_code=400, detail="Delete reason is required.")

    payment = await db.payments.find_one(
        {
            "restaurant_id": restaurant_id,
            "status": "completed",
            "$or": [{"bill_id": bill_id}, {"payment_id": bill_id}],
        },
        {"_id": 0}
    )
    if not payment:
        raise HTTPException(status_code=404, detail="Bill not found")

    payment_order_ids = payment.get("order_ids") or ([payment.get("order_id")] if payment.get("order_id") else [])
    deleted_orders = []
    if payment_order_ids:
        deleted_orders = await db.orders.find(
            {"restaurant_id": restaurant_id, "order_id": {"$in": payment_order_ids}},
            {"_id": 0}
        ).to_list(len(payment_order_ids))

    deleted_at = datetime.now(timezone.utc)
    await db.deleted_bills.insert_one({
        "deleted_bill_id": f"DELBILL{secrets.token_hex(6).upper()}",
        "restaurant_id": restaurant_id,
        "bill_id": payment.get("bill_id") or payment.get("payment_id"),
        "payment_id": payment.get("payment_id"),
        "order_ids": payment_order_ids,
        "payment": payment,
        "orders": deleted_orders,
        "reason": delete_reason,
        "deleted_by_user_id": user.get("user_id"),
        "deleted_by_name": user.get("name") or user.get("email"),
        "deleted_by_email": user.get("email"),
        "deleted_by_role": user.get("role"),
        "deleted_at": deleted_at,
    })

    await db.payments.delete_one({"payment_id": payment["payment_id"], "restaurant_id": restaurant_id})
    if payment_order_ids:
        await db.orders.delete_many({"restaurant_id": restaurant_id, "order_id": {"$in": payment_order_ids}})

    if (payment.get("payment_method") or "").strip().lower() == "cash":
        schedule_background_task(
            sio.emit(
                "cash_drawer_updated",
                {"reason": "completed_bill_deleted", "payment_id": payment["payment_id"]},
                room=f"restaurant_{restaurant_id}",
            )
        )

    schedule_background_task(
        sio.emit(
            "order_deleted",
            {"order_ids": payment_order_ids, "restaurant_id": restaurant_id},
            room=f"restaurant_{restaurant_id}",
        )
    )

    return {"message": "Bill deleted successfully"}


@api_router.post("/cash-adjustments")
async def create_cash_adjustment(input: CashAdjustmentCreate, request: Request):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "billing", "kitchen_billing", "pos"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    if not input.reason.strip():
        raise HTTPException(status_code=400, detail="Please enter an adjustment reason.")
    if float(input.amount) == 0:
        raise HTTPException(status_code=400, detail="Adjustment amount cannot be zero.")

    adjustment_amount = round(float(input.amount), 2)
    if adjustment_amount < 0:
        cash_drawer = await build_cash_drawer_summary(restaurant_id, build_period_date_match("daily"))
        available_cash = round(float(cash_drawer.get("closing_balance", 0) or 0), 2)
        if abs(adjustment_amount) > available_cash:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot withdraw {abs(adjustment_amount):.2f}; only {available_cash:.2f} cash is available in the drawer.",
            )

    adjustment_doc = {
        "adjustment_id": f"ADJ{secrets.token_hex(6).upper()}",
        "restaurant_id": restaurant_id,
        "amount": adjustment_amount,
        "reason": input.reason.strip(),
        "created_at": datetime.now(timezone.utc),
        "created_by": user["_id"],
        "created_by_name": user.get("name") or user.get("email") or "Staff",
        "created_by_role": user.get("role"),
    }
    await db.cash_adjustments.insert_one(adjustment_doc)
    schedule_background_task(
        sio.emit(
            "cash_drawer_updated",
            {"reason": "cash_adjustment", "adjustment_id": adjustment_doc["adjustment_id"]},
            room=f"restaurant_{restaurant_id}",
        )
    )
    return {k: v for k, v in adjustment_doc.items() if k != "_id"}


@api_router.post("/cash-drawer/opening")
async def set_cash_drawer_opening(input: CashDrawerOpeningCreate, request: Request):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "billing", "kitchen_billing", "pos"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    opening_balance = round(float(input.opening_balance or 0), 2)
    if opening_balance < 0:
        raise HTTPException(status_code=400, detail="Opening balance cannot be negative.")

    daily_filter = build_period_date_match("daily")
    now = datetime.now(timezone.utc)
    existing = await db.cash_drawer_openings.find_one({
        "restaurant_id": restaurant_id,
        "business_day_start": daily_filter["$gte"],
        "business_day_end": daily_filter["$lt"],
    }, {"_id": 0})
    opening_id = (existing or {}).get("opening_id") or f"OPEN{secrets.token_hex(6).upper()}"
    opening_doc = {
        "opening_id": opening_id,
        "restaurant_id": restaurant_id,
        "business_day_start": daily_filter["$gte"],
        "business_day_end": daily_filter["$lt"],
        "opening_balance": opening_balance,
        "updated_at": now,
        "updated_by": user["_id"],
        "updated_by_name": user.get("name") or user.get("email") or "Staff",
        "updated_by_role": user.get("role"),
    }

    await db.cash_drawer_openings.update_one(
        {
            "restaurant_id": restaurant_id,
            "business_day_start": daily_filter["$gte"],
            "business_day_end": daily_filter["$lt"],
        },
        {
            "$set": opening_doc,
            "$setOnInsert": {"created_at": now},
        },
        upsert=True,
    )
    schedule_background_task(
        sio.emit(
            "cash_drawer_updated",
            {"reason": "opening_balance", "opening_id": opening_id},
            room=f"restaurant_{restaurant_id}",
        )
    )
    return opening_doc

@api_router.get("/payments/completed")
async def get_completed_payments(request: Request, period: str = "daily"):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "billing", "kitchen_billing"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    payment_query = {
        "restaurant_id": restaurant_id,
        "status": "completed",
        "created_at": build_period_date_match(period),
    }
    payments = await db.payments.find(payment_query, {"_id": 0}).sort("created_at", -1).to_list(5000)
    linked_order_ids = sorted({
        order_id
        for payment in payments
        for order_id in (payment.get("order_ids") or ([payment.get("order_id")] if payment.get("order_id") else []))
        if order_id
    })

    order_map = {}
    if linked_order_ids:
        orders = await db.orders.find(
            {"restaurant_id": restaurant_id, "order_id": {"$in": linked_order_ids}},
            {"_id": 0}
        ).to_list(len(linked_order_ids))
        enriched_orders = await enrich_orders(orders)
        order_map = {order["order_id"]: order for order in enriched_orders}

    completed_bills = []
    for payment in payments:
        payment_order_ids = payment.get("order_ids") or ([payment.get("order_id")] if payment.get("order_id") else [])
        payment_orders = [order_map[order_id] for order_id in payment_order_ids if order_id in order_map]
        first_order = payment_orders[0] if payment_orders else {}
        completed_bills.append({
            "bill_id": payment.get("bill_id") or payment.get("payment_id"),
            "table_label": first_order.get("table_label") or payment.get("table_id") or "",
            "customer_name": first_order.get("customer_name") or "",
            "payment": payment,
            "orders": payment_orders,
        })

    return completed_bills


async def get_completed_payment_bill(bill_id: str, restaurant_id: str):
    payment = await db.payments.find_one(
        {
            "restaurant_id": restaurant_id,
            "status": "completed",
            "$or": [{"bill_id": bill_id}, {"payment_id": bill_id}],
        },
        {"_id": 0},
    )
    if not payment:
        raise HTTPException(status_code=404, detail="Completed bill not found")

    payment_order_ids = payment.get("order_ids") or ([payment.get("order_id")] if payment.get("order_id") else [])
    orders = []
    if payment_order_ids:
        orders = await db.orders.find(
            {"restaurant_id": restaurant_id, "order_id": {"$in": payment_order_ids}},
            {"_id": 0},
        ).to_list(len(payment_order_ids))

    restaurant = await db.restaurants.find_one({"restaurant_id": restaurant_id}, {"_id": 0})
    return payment, orders, restaurant


@api_router.get("/payments/completed/{bill_id}/whatsapp")
async def get_completed_payment_whatsapp_status(bill_id: str, request: Request):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "billing", "kitchen_billing", "pos"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    payment, orders, _ = await get_completed_payment_bill(bill_id, restaurant_id)
    first_order = orders[0] if orders else {}
    return {
        "bill_id": payment.get("bill_id") or payment.get("payment_id"),
        "payment_id": payment.get("payment_id"),
        "customer_name": first_order.get("customer_name") or "",
        "phone": first_order.get("phone") or payment.get("phone") or "",
        "whatsapp_status": payment.get("whatsapp_status") or "not_started",
        "whatsapp_error": payment.get("whatsapp_error") or "",
        "whatsapp_message_id": payment.get("whatsapp_message_id") or "",
        "whatsapp_updated_at": payment.get("whatsapp_updated_at"),
        "whatsapp_sent_at": payment.get("whatsapp_sent_at"),
    }


@api_router.post("/payments/completed/{bill_id}/whatsapp/resend")
async def resend_completed_payment_whatsapp_bill(bill_id: str, request: Request):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "billing", "kitchen_billing", "pos"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")

    payment, orders, restaurant = await get_completed_payment_bill(bill_id, restaurant_id)
    await send_bill_pdf_via_evolution(payment, orders, restaurant, db)
    updated_payment = await db.payments.find_one(
        {"payment_id": payment["payment_id"], "restaurant_id": restaurant_id},
        {"_id": 0},
    )
    return {
        "bill_id": updated_payment.get("bill_id") or updated_payment.get("payment_id"),
        "payment_id": updated_payment.get("payment_id"),
        "whatsapp_status": updated_payment.get("whatsapp_status") or "not_started",
        "whatsapp_error": updated_payment.get("whatsapp_error") or "",
        "whatsapp_message_id": updated_payment.get("whatsapp_message_id") or "",
        "whatsapp_updated_at": updated_payment.get("whatsapp_updated_at"),
        "whatsapp_sent_at": updated_payment.get("whatsapp_sent_at"),
    }


@api_router.get("/payments/{order_id}")
async def get_payment(order_id: str, request: Request):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "billing", "kitchen_billing", "super_admin"]:
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


def make_report_card(report_id: str, category: str, title: str, value, value_type: str = "number", note: str = ""):
    return {
        "id": report_id,
        "category": category,
        "title": title,
        "value": value,
        "value_type": value_type,
        "note": note,
    }


def safe_report_float(value) -> float:
    try:
        return round(float(value or 0), 2)
    except (TypeError, ValueError):
        return 0.0


def format_report_export_value(report) -> str:
    value = report["value"]
    if report["value_type"] == "currency":
        return f"Rs. {safe_report_float(value):.2f}"
    if report["value_type"] == "percent":
        return f"{safe_report_float(value):.2f}%"
    return str(value)


def make_report_export_filename(report, payload) -> str:
    label = report.get("id") if report else "all"
    safe_label = "".join(char.lower() if char.isalnum() else "-" for char in label).strip("-")
    safe_label = safe_label or "report"
    return f"reports-{safe_label}-{payload['period']}-{payload['start_date']}-to-{payload['end_date']}.xlsx"


async def build_admin_reports_payload(
    restaurant_id: str,
    period: str = "daily",
    report_date: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
):
    date_filter, start_date, end_date, safe_period, anchor_date = build_report_period_match(
        period,
        report_date,
        start_date,
        end_date,
    )
    payment_query = {
        "restaurant_id": restaurant_id,
        "status": "completed",
        "created_at": date_filter,
    }
    order_query = {
        "restaurant_id": restaurant_id,
        "created_at": date_filter,
    }

    payments_task = db.payments.find(payment_query, {"_id": 0}).sort("created_at", -1).to_list(10000)
    orders_task = db.orders.find(order_query, {"_id": 0}).sort("created_at", -1).to_list(10000)
    tables_task = db.tables.find({"restaurant_id": restaurant_id}, {"_id": 0}).to_list(1000)
    menu_items_task = db.menu_items.find({"restaurant_id": restaurant_id}, {"_id": 0}).to_list(5000)
    categories_task = db.menu_categories.find({"restaurant_id": restaurant_id}, {"_id": 0}).to_list(1000)
    cancellations_task = db.order_item_cancellations.find({
        "restaurant_id": restaurant_id,
        "cancelled_at": date_filter,
    }, {"_id": 0}).to_list(10000)
    deleted_bills_task = db.deleted_bills.find({
        "restaurant_id": restaurant_id,
        "deleted_at": date_filter,
    }, {"_id": 0}).to_list(5000)
    adjustments_task = db.cash_adjustments.find({
        "restaurant_id": restaurant_id,
        "created_at": date_filter,
    }, {"_id": 0}).to_list(5000)
    customer_sessions_task = db.customer_sessions.find({
        "restaurant_id": restaurant_id,
        "created_at": date_filter,
    }, {"_id": 0}).sort("created_at", -1).to_list(10000)

    payments, orders, tables, menu_items, categories, cancellations, deleted_bills, adjustments, customer_sessions = await asyncio.gather(
        payments_task,
        orders_task,
        tables_task,
        menu_items_task,
        categories_task,
        cancellations_task,
        deleted_bills_task,
        adjustments_task,
        customer_sessions_task,
    )

    table_lookup = {
        table.get("table_id"): f"Table {table.get('table_number')}" if table.get("table_number") is not None else table.get("table_id")
        for table in tables
    }
    linked_order_ids = sorted({
        order_id
        for payment in payments
        for order_id in (payment.get("order_ids") or ([payment.get("order_id")] if payment.get("order_id") else []))
        if order_id
    })
    paid_orders = []
    if linked_order_ids:
        paid_orders = await db.orders.find(
            {"restaurant_id": restaurant_id, "order_id": {"$in": linked_order_ids}},
            {"_id": 0}
        ).to_list(len(linked_order_ids))

    category_names = {category.get("category_id"): category.get("name", "Uncategorized") for category in categories}
    menu_lookup = {
        item.get("item_id"): {
            "category": category_names.get(item.get("category_id"), "Uncategorized"),
            "diet_type": item.get("diet_type", "veg"),
        }
        for item in menu_items
    }

    gross_sales = round(sum(safe_report_float(payment.get("subtotal")) for payment in payments), 2)
    total_revenue = round(sum(safe_report_float(payment.get("total")) for payment in payments), 2)
    total_discounts = round(sum(safe_report_float(payment.get("discount")) for payment in payments), 2)
    tax_collected = round(sum(safe_report_float(payment.get("tax")) for payment in payments), 2)
    service_charges = round(sum(safe_report_float(payment.get("service_charge")) for payment in payments), 2)
    parcel_charges = round(sum(safe_report_float(payment.get("parcel_charge")) for payment in payments), 2)
    completed_bills = len(payments)
    avg_bill_value = round(total_revenue / completed_bills, 2) if completed_bills else 0

    payment_totals = {"cash": 0.0, "upi": 0.0, "card": 0.0, "other": 0.0}
    for payment in payments:
        method = (payment.get("payment_method") or "other").lower()
        method_key = method if method in payment_totals else "other"
        payment_totals[method_key] = round(payment_totals[method_key] + safe_report_float(payment.get("total")), 2)

    all_orders_count = len(orders)
    dine_in_orders = sum(1 for order in orders if order.get("order_type") != "takeaway")
    takeaway_orders = sum(1 for order in orders if order.get("order_type") == "takeaway")
    qr_orders = sum(1 for order in orders if order.get("order_source") == "customer_qr")
    counter_orders = sum(1 for order in orders if order.get("order_source") == "billing_counter")

    item_sales = {}
    category_sales = {}
    table_sales = {}
    diet_sales = {"veg": {"quantity": 0, "revenue": 0.0}, "non_veg": {"quantity": 0, "revenue": 0.0}, "egg": {"quantity": 0, "revenue": 0.0}, "vegan": {"quantity": 0, "revenue": 0.0}}
    total_items_sold = 0
    total_item_lines = 0

    for order in paid_orders:
        table_label = order.get("table_label") or (f"Table {order.get('table_number')}" if order.get("table_number") else order.get("table_id") or "Takeaway")
        order_total = calculate_order_items_total(order.get("items", []))
        table_sales.setdefault(table_label, {"table": table_label, "orders": 0, "revenue": 0.0})
        table_sales[table_label]["orders"] += 1
        table_sales[table_label]["revenue"] = round(table_sales[table_label]["revenue"] + order_total, 2)

        for item in order.get("items", []):
            quantity = get_item_billable_quantity(item)
            if quantity <= 0:
                continue
            price = safe_report_float(item.get("price"))
            revenue = round(quantity * price, 2)
            total_items_sold += quantity
            total_item_lines += 1
            item_name = item.get("name") or "Unnamed Item"
            item_sales.setdefault(item_name, {"name": item_name, "quantity": 0, "revenue": 0.0})
            item_sales[item_name]["quantity"] += quantity
            item_sales[item_name]["revenue"] = round(item_sales[item_name]["revenue"] + revenue, 2)

            menu_meta = menu_lookup.get(item.get("item_id"), {})
            category_name = menu_meta.get("category") or "Uncategorized"
            category_sales.setdefault(category_name, {"category": category_name, "quantity": 0, "revenue": 0.0})
            category_sales[category_name]["quantity"] += quantity
            category_sales[category_name]["revenue"] = round(category_sales[category_name]["revenue"] + revenue, 2)

            diet_type = item.get("diet_type") or menu_meta.get("diet_type") or "veg"
            if diet_type not in diet_sales:
                diet_type = "veg"
            diet_sales[diet_type]["quantity"] += quantity
            diet_sales[diet_type]["revenue"] = round(diet_sales[diet_type]["revenue"] + revenue, 2)

    top_items = sorted(item_sales.values(), key=lambda item: (-item["quantity"], -item["revenue"], item["name"]))[:10]
    top_categories = sorted(category_sales.values(), key=lambda item: (-item["revenue"], -item["quantity"], item["category"]))[:10]
    top_tables = sorted(table_sales.values(), key=lambda item: (-item["revenue"], -item["orders"], item["table"]))[:10]
    top_item = top_items[0] if top_items else None
    top_category = top_categories[0] if top_categories else None

    cancellation_loss_amount = round(sum(safe_report_float(entry.get("loss_amount")) for entry in cancellations), 2)
    cancelled_quantity = sum(int(entry.get("quantity_cancelled") or entry.get("loss_quantity") or 0) for entry in cancellations)
    deleted_bill_amount = round(sum(safe_report_float((entry.get("payment") or {}).get("total")) for entry in deleted_bills), 2)
    cash_adjustment_total = round(sum(safe_report_float(entry.get("amount")) for entry in adjustments), 2)

    active_table_ids = await db.orders.distinct("table_id", {
        "restaurant_id": restaurant_id,
        "order_type": {"$ne": "takeaway"},
        "payment_status": {"$ne": "completed"},
        "status": {"$nin": ["served", "cancelled"]},
    })
    total_tables = len(tables)
    occupied_tables = len([table for table in tables if table.get("table_id") in active_table_ids])
    table_utilization = round((occupied_tables / total_tables) * 100, 2) if total_tables else 0
    customers = {
        (order.get("phone") or order.get("customer_name") or "").strip().lower()
        for order in orders
        if (order.get("phone") or order.get("customer_name") or "").strip()
    }
    unique_customers = len(customers)
    default_customer_names = {"walk-in customer", "takeaway customer", "customer"}
    customer_contacts = []
    contact_source_counts = {"QR Scan": 0, "Counter Order": 0, "Waiter Dashboard": 0}

    def should_include_customer_contact(name: str, phone: str) -> bool:
        clean_name = (name or "").strip()
        clean_phone = (phone or "").strip()
        return bool(clean_phone) or bool(clean_name and clean_name.lower() not in default_customer_names)

    def add_customer_contact(source: str, name: str, phone: str, table_id: str = "", table_label: str = "", order_id: str = "", captured_at=None):
        if not should_include_customer_contact(name, phone):
            return
        customer_contacts.append({
            "source": source,
            "customer_name": (name or "").strip(),
            "phone": (phone or "").strip(),
            "table": table_label or table_lookup.get(table_id) or table_id or "Takeaway",
            "order_id": order_id or "",
            "captured_at": format_export_datetime(captured_at),
            "_captured_at": captured_at,
        })
        contact_source_counts[source] = contact_source_counts.get(source, 0) + 1

    for session in customer_sessions:
        add_customer_contact(
            "QR Scan",
            session.get("customer_name", ""),
            session.get("phone", ""),
            table_id=session.get("table_id", ""),
            captured_at=session.get("created_at"),
        )

    for order in orders:
        order_source = order.get("order_source")
        if order_source not in {"billing_counter", "waiter"}:
            continue
        add_customer_contact(
            "Waiter Dashboard" if order_source == "waiter" else "Counter Order",
            order.get("customer_name", ""),
            order.get("phone", ""),
            table_id=order.get("table_id", ""),
            table_label=order.get("table_label", ""),
            order_id=order.get("order_id", ""),
            captured_at=order.get("created_at"),
        )

    customer_contacts.sort(
        key=lambda contact: to_aware_utc(contact["_captured_at"]) if isinstance(contact.get("_captured_at"), datetime) else datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )
    for contact in customer_contacts:
        contact.pop("_captured_at", None)

    avg_items_per_bill = round(total_items_sold / completed_bills, 2) if completed_bills else 0

    reports = [
        make_report_card("gross_sales", "Sales", "Gross Sales", gross_sales, "currency", "Subtotal before taxes, charges, and discounts."),
        make_report_card("net_sales", "Sales", "Net Sales / Revenue", total_revenue, "currency", "Completed payment total."),
        make_report_card("discounts", "Sales", "Discounts Given", total_discounts, "currency", "Total discount applied on completed bills."),
        make_report_card("tax_collected", "Sales", "Tax Collected", tax_collected, "currency", "Tax collected from completed bills."),
        make_report_card("service_charges", "Sales", "Service Charges", service_charges, "currency", "Service charges collected."),
        make_report_card("parcel_charges", "Sales", "Parcel Charges", parcel_charges, "currency", "Takeaway parcel charges collected."),
        make_report_card("completed_bills", "Billing", "Completed Bills", completed_bills, "number", "Paid bills generated in the selected period."),
        make_report_card("avg_bill_value", "Billing", "Average Bill Value", avg_bill_value, "currency", "Net sales divided by completed bills."),
        make_report_card("cash_sales", "Payments", "Cash Sales", payment_totals["cash"], "currency", "Completed cash payments."),
        make_report_card("upi_sales", "Payments", "UPI Sales", payment_totals["upi"], "currency", "Completed UPI payments."),
        make_report_card("card_sales", "Payments", "Card Sales", payment_totals["card"], "currency", "Completed card payments."),
        make_report_card("total_orders", "Orders", "Total Orders", all_orders_count, "number", "Orders created in the selected period."),
        make_report_card("dine_in_orders", "Orders", "Dine-In Orders", dine_in_orders, "number", "Dine-in orders created."),
        make_report_card("takeaway_orders", "Orders", "Takeaway Orders", takeaway_orders, "number", "Takeaway orders created."),
        make_report_card("qr_orders", "Orders", "QR Customer Orders", qr_orders, "number", "Orders placed from customer QR menu."),
        make_report_card("counter_orders", "Orders", "Counter Orders", counter_orders, "number", "Orders created from billing counter."),
        make_report_card("avg_items_per_bill", "Menu", "Average Items Per Bill", avg_items_per_bill, "decimal", "Billable item quantity divided by completed bills."),
        make_report_card("items_sold", "Menu", "Items Sold", total_items_sold, "number", "Billable menu item quantity sold."),
        make_report_card("top_item", "Menu", "Top Selling Item", top_item["name"] if top_item else "No sales yet", "text", f"{top_item['quantity']} qty / Rs. {top_item['revenue']:.2f}" if top_item else ""),
        make_report_card("top_category", "Menu", "Top Category", top_category["category"] if top_category else "No sales yet", "text", f"{top_category['quantity']} qty / Rs. {top_category['revenue']:.2f}" if top_category else ""),
        make_report_card("cancellation_loss", "Control", "Cancellation Loss", cancellation_loss_amount, "currency", f"{cancelled_quantity} cancelled item quantity."),
        make_report_card("deleted_bills", "Control", "Deleted Bills", len(deleted_bills), "number", f"Deleted bill value: Rs. {deleted_bill_amount:.2f}."),
        make_report_card("cash_adjustments", "Control", "Cash Adjustments", cash_adjustment_total, "currency", "Net cash adjustment amount."),
        make_report_card("table_utilization", "Tables", "Current Table Occupancy", table_utilization, "percent", f"{occupied_tables}/{total_tables} tables occupied right now."),
        make_report_card("unique_customers", "Customers", "Unique Customers", unique_customers, "number", "Unique customer names or phone numbers in orders."),
        make_report_card(
            "customer_contacts",
            "Customers",
            "Customer Contact Captures",
            len(customer_contacts),
            "number",
            f"QR: {contact_source_counts.get('QR Scan', 0)}, Counter: {contact_source_counts.get('Counter Order', 0)}, Waiter: {contact_source_counts.get('Waiter Dashboard', 0)}.",
        ),
    ]

    return {
        "period": safe_period,
        "selected_date": anchor_date,
        "start_date": start_date,
        "end_date": end_date,
        "reports": reports,
        "details": {
            "top_items": top_items,
            "top_categories": top_categories,
            "top_tables": top_tables,
            "payment_breakdown": payment_totals,
            "diet_sales": diet_sales,
            "customer_contacts": customer_contacts,
        },
    }


@api_router.get("/reports/summary")
async def get_admin_reports(
    request: Request,
    period: str = "daily",
    report_date: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
):
    _, restaurant_id = await resolve_restaurant_access(request, ["admin"])
    return await build_admin_reports_payload(restaurant_id, period, report_date, start_date, end_date)


@api_router.get("/reports/export")
async def export_admin_reports(
    request: Request,
    period: str = "daily",
    report_date: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    report_id: Optional[str] = None,
):
    _, restaurant_id = await resolve_restaurant_access(request, ["admin"])
    payload = await build_admin_reports_payload(restaurant_id, period, report_date, start_date, end_date)
    selected_report = None
    export_reports = payload["reports"]
    if report_id:
        selected_report = next((report for report in payload["reports"] if report["id"] == report_id), None)
        if not selected_report:
            raise HTTPException(status_code=404, detail="Report not found")
        export_reports = [selected_report]

    if selected_report and selected_report["id"] == "customer_contacts":
        rows = [
            [
                payload["period"].title(),
                payload["start_date"],
                payload["end_date"],
                contact.get("source", ""),
                contact.get("customer_name", ""),
                contact.get("phone", ""),
                contact.get("table", ""),
                contact.get("order_id", ""),
                contact.get("captured_at", ""),
            ]
            for contact in payload["details"].get("customer_contacts", [])
        ]
        workbook = build_xlsx_bytes(
            headers=["Period", "Start Date", "End Date", "Source", "Customer Name", "Phone", "Table", "Order ID", "Captured At"],
            rows=rows,
            sheet_name="Customer Contacts",
        )
        filename = make_report_export_filename(selected_report, payload)
        return StreamingResponse(
            BytesIO(workbook),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    rows = []
    for report in export_reports:
        rows.append([
            payload["period"].title(),
            payload["start_date"],
            payload["end_date"],
            report["category"],
            report["title"],
            format_report_export_value(report),
            report.get("note", ""),
        ])

    workbook = build_xlsx_bytes(
        headers=["Period", "Start Date", "End Date", "Category", "Report", "Value", "Notes"],
        rows=rows,
        sheet_name="Reports",
    )
    filename = make_report_export_filename(selected_report, payload)
    return StreamingResponse(
        BytesIO(workbook),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ============ Analytics Endpoints ============
@api_router.get("/analytics/dashboard")
async def get_analytics(request: Request, period: str = "daily"):
    user = await get_current_user(request, db)
    if user["role"] not in ["admin", "billing", "kitchen_billing"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    # Get restaurant_id for data isolation
    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")
    
    created_at_filter = build_period_date_match(period)
    
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

    restaurant_table_ids = await db.tables.distinct("table_id", {"restaurant_id": restaurant_id})
    total_tables = len(restaurant_table_ids)
    occupied_tables = len(await db.orders.distinct("table_id", {
        "restaurant_id": restaurant_id,
        "table_id": {"$in": restaurant_table_ids},
        "order_type": {"$ne": "takeaway"},
        "payment_status": {"$ne": "completed"},
        "status": {"$nin": ["served", "cancelled"]}
    }))
    empty_tables = max(total_tables - occupied_tables, 0)
    transaction_summary = await build_transaction_summary(restaurant_id, created_at_filter)
    billed_revenue = round(transaction_summary["payment_summary"].get("total_collected", 0), 2)
    loss_pipeline = [
        {"$match": {
            "restaurant_id": restaurant_id,
            "cancelled_at": created_at_filter,
            "reallocation_status": {"$in": ["loss", "no_matching_order_found"]},
        }},
        {"$group": {
            "_id": None,
            "loss_events": {"$sum": 1},
            "loss_quantity": {"$sum": {"$ifNull": ["$loss_quantity", "$quantity_cancelled"]}},
            "loss_amount": {"$sum": {"$ifNull": ["$loss_amount", 0]}},
        }},
    ]
    loss_result = await db.order_item_cancellations.aggregate(loss_pipeline).to_list(1)
    cancellation_loss = {
        "events": int(loss_result[0].get("loss_events", 0)) if loss_result else 0,
        "quantity": int(loss_result[0].get("loss_quantity", 0)) if loss_result else 0,
        "amount": round(float(loss_result[0].get("loss_amount", 0)), 2) if loss_result else 0,
    }
    deleted_bill_logs = await db.deleted_bills.find(
        {
            "restaurant_id": restaurant_id,
            "deleted_at": created_at_filter,
        },
        {"_id": 0}
    ).sort("deleted_at", -1).to_list(25)
    
    if not result:
        return {
            "total_orders": 0,
            "total_revenue": billed_revenue,
            "avg_order_value": 0,
            "top_items": [],
            "peak_hours": [],
            "occupied_tables": occupied_tables,
            "empty_tables": empty_tables,
            "recent_sales": [],
            "best_seller": None,
            "payment_summary": transaction_summary["payment_summary"],
            "cash_adjustments": transaction_summary["cash_adjustments"],
            "cash_drawer": transaction_summary["cash_drawer"],
            "cancellation_loss": cancellation_loss,
            "deleted_bills": deleted_bill_logs,
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

    avg_order_value = round(
        billed_revenue / result[0]["total_orders"],
        2,
    ) if result[0]["total_orders"] else 0
    
    return {
        "total_orders": result[0]["total_orders"],
        "total_revenue": billed_revenue,
        "avg_order_value": avg_order_value,
        "top_items": [{"name": item["_id"], "quantity": item["quantity"], "revenue": item["revenue"]} for item in top_items],
        "peak_hours": [],
        "occupied_tables": occupied_tables,
        "empty_tables": empty_tables,
        "recent_sales": recent_sales,
        "best_seller": best_seller,
        "payment_summary": transaction_summary["payment_summary"],
        "cash_adjustments": transaction_summary["cash_adjustments"],
        "cash_drawer": transaction_summary["cash_drawer"],
        "cancellation_loss": cancellation_loss,
        "deleted_bills": deleted_bill_logs,
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
    payment_query = {"status": "completed"}
    if scoped_restaurant_id:
        payment_query["restaurant_id"] = scoped_restaurant_id
    if created_at_filter:
        payment_query["created_at"] = created_at_filter

    payments = await db.payments.find(payment_query, {"_id": 0}).sort("created_at", -1).to_list(5000)
    linked_order_ids = sorted({
        order_id
        for payment in payments
        for order_id in (payment.get("order_ids") or ([payment.get("order_id")] if payment.get("order_id") else []))
        if order_id
    })
    order_map = {}
    if linked_order_ids:
        linked_orders = await db.orders.find(
            {"order_id": {"$in": linked_order_ids}},
            {"_id": 0}
        ).to_list(len(linked_order_ids))
        order_map = {order["order_id"]: order for order in linked_orders}

    restaurant_names = {}
    restaurant_ids = list({payment.get("restaurant_id") for payment in payments if payment.get("restaurant_id")})
    if restaurant_ids:
        restaurants = await db.restaurants.find(
            {"restaurant_id": {"$in": restaurant_ids}},
            {"_id": 0, "restaurant_id": 1, "name": 1}
        ).to_list(len(restaurant_ids))
        restaurant_names = {restaurant["restaurant_id"]: restaurant["name"] for restaurant in restaurants}

    rows = []
    for payment in payments:
        payment_order_ids = payment.get("order_ids") or ([payment.get("order_id")] if payment.get("order_id") else [])
        payment_orders = [order_map[order_id] for order_id in payment_order_ids if order_id in order_map]
        table_numbers = sorted({
            str(order.get("table_number") or order.get("table_label") or order.get("table_id") or "")
            for order in payment_orders
            if order.get("table_number") or order.get("table_label") or order.get("table_id")
        })
        customer_names = sorted({
            str(order.get("customer_name") or "")
            for order in payment_orders
            if order.get("customer_name")
        })
        items_summary = ", ".join(
            f"{item['name']} x{item['quantity']}"
            for order in payment_orders
            for item in order.get("items", [])
        )
        rows.append([
            restaurant_names.get(payment.get("restaurant_id"), payment.get("restaurant_name", "")),
            payment.get("bill_id") or payment.get("payment_id"),
            ", ".join(payment_order_ids),
            payment.get("created_at"),
            ", ".join(table_numbers),
            ", ".join(customer_names),
            items_summary,
            round(float(payment.get("subtotal", 0) or 0), 2),
            round(float(payment.get("service_charge", 0) or 0), 2),
            round(float(payment.get("parcel_charge", 0) or 0), 2),
            round(float(payment.get("tax", 0) or 0), 2),
            round(float(payment.get("discount", 0) or 0), 2),
            round(float(payment.get("total", 0) or 0), 2),
            (payment.get("payment_method") or "").upper(),
            payment.get("status", "completed"),
        ])

    workbook = build_xlsx_bytes(
        headers=[
            "Restaurant",
            "Bill Number",
            "Linked Order IDs",
            "Date & Time",
            "Table Number",
            "Customer",
            "Items Ordered",
            "Subtotal",
            "Service Charge",
            "Parcel Charge",
            "Tax",
            "Discount",
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
    allow_origin_regex=LOCAL_NETWORK_CORS_REGEX,
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
        await db.attendance_kiosks.create_index("restaurant_id", unique=True)
        await db.attendance_kiosks.create_index("token_hash", unique=True, sparse=True)
        await db.tables.create_index("table_id", unique=True)
        await db.tables.create_index([("restaurant_id", 1), ("table_number", 1)], unique=True)
        await db.menu_items.create_index("item_id", unique=True)
        await db.menu_categories.create_index([("restaurant_id", 1), ("order", 1)])
        await db.menu_items.create_index([("restaurant_id", 1), ("category_id", 1)])
        await db.orders.create_index("order_id", unique=True)
        await db.orders.create_index([("restaurant_id", 1), ("status", 1), ("created_at", -1)])
        await db.orders.create_index([("restaurant_id", 1), ("table_id", 1), ("status", 1), ("created_at", -1)])
        await db.customer_sessions.create_index("session_token", unique=True)
        await db.payments.create_index([("restaurant_id", 1), ("order_id", 1)])
        await db.payments.create_index([("restaurant_id", 1), ("status", 1), ("order_id", 1)])
        await db.payments.create_index([("restaurant_id", 1), ("status", 1), ("order_ids", 1)])
        await db.deleted_bills.create_index([("restaurant_id", 1), ("deleted_at", -1)])
        await db.cash_adjustments.create_index([("restaurant_id", 1), ("created_at", -1)])
        await db.cash_drawer_openings.create_index(
            [("restaurant_id", 1), ("business_day_start", -1)],
            unique=True,
        )
        await db.attendance_settings.create_index("restaurant_id", unique=True)
        await db.attendance_shifts.create_index([("restaurant_id", 1), ("shift_id", 1)], unique=True)
        await db.attendance_shifts.create_index([("restaurant_id", 1), ("active", 1), ("shift_start", 1)])
        await db.face_profiles.create_index([("restaurant_id", 1), ("staff_email", 1)], unique=True)
        await db.attendance_logs.create_index([("restaurant_id", 1), ("business_date", 1), ("staff_email", 1)])
        await db.attendance_logs.create_index([("restaurant_id", 1), ("status", 1), ("clock_in", -1)])
        
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
