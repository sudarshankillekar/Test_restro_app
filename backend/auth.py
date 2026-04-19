import os
import bcrypt
import jwt
from datetime import datetime, timezone, timedelta
from pathlib import Path
from fastapi import HTTPException, Request
from bson import ObjectId

JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 7
REFRESH_TOKEN_EXPIRE_DAYS = 30
ACCESS_TOKEN_MAX_AGE_SECONDS = ACCESS_TOKEN_EXPIRE_DAYS * 24 * 60 * 60
REFRESH_TOKEN_MAX_AGE_SECONDS = REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60

def get_jwt_secret() -> str:
    return os.environ.get("JWT_SECRET", "dev_secret_key_change_in_production")

def hash_password(password: str) -> str:
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(password.encode("utf-8"), salt)
    return hashed.decode("utf-8")

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))

def create_access_token(user_id: str, email: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "exp": datetime.now(timezone.utc) + timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS),
        "type": "access"
    }
    return jwt.encode(payload, get_jwt_secret(), algorithm=JWT_ALGORITHM)

def create_refresh_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "exp": datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
        "type": "refresh"
    }
    return jwt.encode(payload, get_jwt_secret(), algorithm=JWT_ALGORITHM)

async def attach_restaurant_context(user: dict, db) -> dict:
    user["_id"] = str(user["_id"])
    user.pop("password_hash", None)

    restaurant_id = user.get("restaurant_id")
    if restaurant_id:
        restaurant = await db.restaurants.find_one(
            {"restaurant_id": restaurant_id},
            {"_id": 0, "name": 1, "restaurant_id": 1, "gst_number": 1}
        )
        if restaurant:
            user["restaurant_name"] = restaurant.get("name")
            user["restaurant_gst_number"] = restaurant.get("gst_number")

    return user

async def get_current_user(request: Request, db) -> dict:
    """Get user from JWT cookie or session_token cookie or Authorization header"""
    # Try JWT access_token first
    token = request.cookies.get("access_token")
    if token:
        try:
            payload = jwt.decode(token, get_jwt_secret(), algorithms=[JWT_ALGORITHM])
            if payload.get("type") != "access":
                raise HTTPException(status_code=401, detail="Invalid token type")
            user = await db.users.find_one({"_id": ObjectId(payload["sub"])})
            if not user:
                raise HTTPException(status_code=401, detail="User not found")
            return await attach_restaurant_context(user, db)
        except jwt.ExpiredSignatureError:
            raise HTTPException(status_code=401, detail="Token expired")
        except jwt.InvalidTokenError:
            raise HTTPException(status_code=401, detail="Invalid token")
    
    # Try session_token (Google OAuth)
    session_token = request.cookies.get("session_token")
    if session_token:
        session = await db.user_sessions.find_one({"session_token": session_token})
        if not session:
            raise HTTPException(status_code=401, detail="Session not found")
        
        # Check expiry
        expires_at = session["expires_at"]
        if isinstance(expires_at, str):
            expires_at = datetime.fromisoformat(expires_at)
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        
        if expires_at < datetime.now(timezone.utc):
            raise HTTPException(status_code=401, detail="Session expired")
        
        user = await db.users.find_one({"_id": ObjectId(session["user_id"])})
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        return await attach_restaurant_context(user, db)
    
    # Try Authorization header
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
        try:
            payload = jwt.decode(token, get_jwt_secret(), algorithms=[JWT_ALGORITHM])
            if payload.get("type") != "access":
                raise HTTPException(status_code=401, detail="Invalid token type")
            user = await db.users.find_one({"_id": ObjectId(payload["sub"])})
            if not user:
                raise HTTPException(status_code=401, detail="User not found")
            return await attach_restaurant_context(user, db)
        except jwt.ExpiredSignatureError:
            raise HTTPException(status_code=401, detail="Token expired")
        except jwt.InvalidTokenError:
            raise HTTPException(status_code=401, detail="Invalid token")
    
    raise HTTPException(status_code=401, detail="Not authenticated")

async def check_brute_force(db, ip: str, email: str):
    identifier = f"{ip}:{email}"
    attempt = await db.login_attempts.find_one({"identifier": identifier})
    
    if not attempt:
        return
    
    if attempt["count"] >= 5:
        locked_until = attempt["locked_until"]
        if isinstance(locked_until, str):
            locked_until = datetime.fromisoformat(locked_until)
        if locked_until.tzinfo is None:
            locked_until = locked_until.replace(tzinfo=timezone.utc)
        
        if locked_until > datetime.now(timezone.utc):
            raise HTTPException(status_code=429, detail="Too many failed attempts. Try again later.")

async def record_failed_login(db, ip: str, email: str):
    identifier = f"{ip}:{email}"
    attempt = await db.login_attempts.find_one({"identifier": identifier})
    
    if not attempt:
        await db.login_attempts.insert_one({
            "identifier": identifier,
            "count": 1,
            "last_attempt": datetime.now(timezone.utc),
            "locked_until": None
        })
    else:
        count = attempt["count"] + 1
        locked_until = datetime.now(timezone.utc) + timedelta(minutes=15) if count >= 5 else None
        await db.login_attempts.update_one(
            {"identifier": identifier},
            {
                "$set": {
                    "count": count,
                    "last_attempt": datetime.now(timezone.utc),
                    "locked_until": locked_until
                }
            }
        )

async def clear_failed_logins(db, ip: str, email: str):
    identifier = f"{ip}:{email}"
    await db.login_attempts.delete_one({"identifier": identifier})

async def seed_admin(db):
    """Seed admin user from .env"""
    admin_email = os.environ.get("ADMIN_EMAIL", "admin@restaurant.com")
    admin_password = os.environ.get("ADMIN_PASSWORD", "admin123")
    
    existing = await db.users.find_one({"email": admin_email})
    
    if existing is None:
        hashed = hash_password(admin_password)
        await db.users.insert_one({
            "email": admin_email,
            "password_hash": hashed,
            "name": "Admin",
            "role": "admin",
            "created_at": datetime.now(timezone.utc)
        })
        print(f"Admin user created: {admin_email}")
    elif not verify_password(admin_password, existing.get("password_hash", "")):
        await db.users.update_one(
            {"email": admin_email},
            {"$set": {"password_hash": hash_password(admin_password)}}
        )
        print(f"Admin password updated: {admin_email}")
    
    # Seed super admin
    super_admin_email = os.environ.get("SUPER_ADMIN_EMAIL", "superadmin@platform.com")
    super_admin_password = os.environ.get("SUPER_ADMIN_PASSWORD", "superadmin123")
    
    existing_super = await db.users.find_one({"email": super_admin_email})
    
    if existing_super is None:
        hashed = hash_password(super_admin_password)
        await db.users.insert_one({
            "email": super_admin_email,
            "password_hash": hashed,
            "name": "Super Admin",
            "role": "super_admin",
            "created_at": datetime.now(timezone.utc)
        })
        print(f"Super admin user created: {super_admin_email}")
    elif not verify_password(super_admin_password, existing_super.get("password_hash", "")):
        await db.users.update_one(
            {"email": super_admin_email},
            {"$set": {"password_hash": hash_password(super_admin_password)}}
        )
        print(f"Super admin password updated: {super_admin_email}")
    
    # Write test credentials into the local workspace, not a container-only path.
    memory_dir = Path(__file__).resolve().parent.parent / "memory"
    memory_dir.mkdir(parents=True, exist_ok=True)
    with open(memory_dir / "test_credentials.md", "w") as f:
        f.write("# Test Credentials\n\n")
        f.write("## Super Admin (Platform Owner)\n")
        f.write(f"- Email: {super_admin_email}\n")
        f.write(f"- Password: {super_admin_password}\n")
        f.write(f"- Role: super_admin\n\n")
        f.write("## Admin User\n")
        f.write(f"- Email: {admin_email}\n")
        f.write(f"- Password: {admin_password}\n")
        f.write(f"- Role: admin\n\n")
        f.write("## Staff User (Kitchen)\n")
        f.write(f"- Email: kitchen@restaurant.com\n")
        f.write(f"- Password: kitchen123\n")
        f.write(f"- Role: kitchen\n\n")
        f.write("## Staff User (Billing)\n")
        f.write(f"- Email: billing@restaurant.com\n")
        f.write(f"- Password: billing123\n")
        f.write(f"- Role: billing\n\n")
        f.write("## Endpoints\n")
        f.write("- Login: POST /api/auth/login\n")
        f.write("- Register: POST /api/auth/register\n")
        f.write("- Me: GET /api/auth/me\n")
        f.write("- Google OAuth: POST /api/auth/google/session\n")
