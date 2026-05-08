from datetime import datetime, timezone, timedelta
from fastapi import HTTPException, Request
import secrets

SUBSCRIPTION_PLANS = {
    "BASIC": {
        "name": "Basic",
        "price": 1999,
        "duration_days": 30,
        "features": ["QR ordering", "Menu management", "Basic analytics"]
    },
    "PRO": {
        "name": "Pro",
        "price": 2599,
        "duration_days": 30,
        "features": ["QR ordering", "Menu management", "Billing counter", "Advanced analytics", "Kitchen dashboard"]
    },
    "PREMIUM": {
        "name": "Premium",
        "price": 3000,
        "duration_days": 30,
        "features": ["All features", "Priority support", "Custom branding", "API access", "Advanced reports"]
    }
}
DEFAULT_SUBSCRIPTION_DAYS = 30


def get_subscription_terms(plan: str | None = None, custom_amount: float | None = None) -> dict:
    normalized_plan = (plan or "").strip().upper()
    if normalized_plan in SUBSCRIPTION_PLANS:
        plan_info = SUBSCRIPTION_PLANS[normalized_plan]
        return {
            "name": normalized_plan,
            "display_name": plan_info["name"],
            "price": float(plan_info["price"]),
            "duration_days": plan_info["duration_days"],
            "features": plan_info.get("features", []),
        }

    amount = float(custom_amount or 0)
    return {
        "name": "CUSTOM",
        "display_name": "Custom",
        "price": amount,
        "duration_days": DEFAULT_SUBSCRIPTION_DAYS,
        "features": ["Custom subscription amount set by super admin"],
    }
    
async def check_restaurant_subscription(db, restaurant_id: str) -> dict:
    """Check if restaurant subscription is active"""
    restaurant = await db.restaurants.find_one({"restaurant_id": restaurant_id}, {"_id": 0})
    
    if not restaurant:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    
    # Check status
    if restaurant["status"] == "SUSPENDED":
        raise HTTPException(status_code=403, detail="Restaurant account is suspended. Please contact support.")
    
    if restaurant["status"] == "EXPIRED":
        raise HTTPException(status_code=403, detail="Subscription has expired. Please renew your plan.")
    
    # Check expiry date
    subscription_end = restaurant["subscriptionEnd"]
    if isinstance(subscription_end, str):
        subscription_end = datetime.fromisoformat(subscription_end)
    if subscription_end.tzinfo is None:
        subscription_end = subscription_end.replace(tzinfo=timezone.utc)
    
    if subscription_end < datetime.now(timezone.utc):
        # Auto-expire
        await db.restaurants.update_one(
            {"restaurant_id": restaurant_id},
            {"$set": {"status": "EXPIRED", "updated_at": datetime.now(timezone.utc)}}
        )
        raise HTTPException(status_code=403, detail="Subscription has expired. Please renew your plan.")
    
    return restaurant

async def get_restaurant_from_user(db, user_id: str) -> str:
    """Get restaurant_id from user"""
    user = await db.users.find_one({"_id": user_id})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    restaurant_id = user.get("restaurant_id")
    if not restaurant_id:
        raise HTTPException(status_code=400, detail="User not associated with any restaurant")
    
    return restaurant_id

async def create_subscription_log(db, restaurant_id: str, action: str, details: dict, performed_by: str):
    """Create audit log for subscription changes"""
    log_entry = {
        "log_id": f"log_{secrets.token_hex(8)}",
        "restaurant_id": restaurant_id,
        "action": action,
        "details": details,
        "performed_by": performed_by,
        "timestamp": datetime.now(timezone.utc)
    }
    await db.subscription_logs.insert_one(log_entry)

async def create_notification(db, restaurant_id: str, notification_type: str, message: str):
    """Create notification for restaurant"""
    notification = {
        "notification_id": f"notif_{secrets.token_hex(8)}",
        "restaurant_id": restaurant_id,
        "type": notification_type,
        "message": message,
        "read": False,
        "created_at": datetime.now(timezone.utc)
    }
    await db.notifications.insert_one(notification)
    print(f"[NOTIFICATION] Restaurant {restaurant_id}: {message}")

async def check_and_expire_subscriptions(db):
    """Cron job to check and expire subscriptions"""
    now = datetime.now(timezone.utc)
    
    # Find restaurants with active status but expired subscription
    cursor = db.restaurants.find({
        "status": "ACTIVE",
        "subscriptionEnd": {"$lt": now}
    })
    
    expired_count = 0
    async for restaurant in cursor:
        # Mark as expired
        await db.restaurants.update_one(
            {"restaurant_id": restaurant["restaurant_id"]},
            {"$set": {"status": "EXPIRED", "updated_at": now}}
        )
        
        # Create notification
        await create_notification(
            db,
            restaurant["restaurant_id"],
            "SUBSCRIPTION_EXPIRED",
            f"Your {restaurant['plan']} subscription has expired. Please renew to continue using the system."
        )
        
        # Create log
        await create_subscription_log(
            db,
            restaurant["restaurant_id"],
            "AUTO_EXPIRED",
            {"reason": "Subscription end date reached"},
            "SYSTEM"
        )
        
        expired_count += 1
    
    if expired_count > 0:
        print(f"[CRON] Expired {expired_count} restaurant subscriptions")
    
    return expired_count

async def send_expiry_reminders(db):
    """Send reminders for upcoming expiries"""
    now = datetime.now(timezone.utc)
    
    # 3 days before expiry
    three_days_later = now + timedelta(days=3)
    cursor_3days = db.restaurants.find({
        "status": "ACTIVE",
        "subscriptionEnd": {
            "$gte": now,
            "$lte": three_days_later
        }
    })
    
    async for restaurant in cursor_3days:
        # Check if reminder already sent
        existing = await db.notifications.find_one({
            "restaurant_id": restaurant["restaurant_id"],
            "type": "EXPIRY_REMINDER_3DAYS",
            "created_at": {"$gte": now - timedelta(days=1)}
        })
        
        if not existing:
            await create_notification(
                db,
                restaurant["restaurant_id"],
                "EXPIRY_REMINDER_3DAYS",
                f"Your {restaurant['plan']} subscription expires in 3 days. Renew now to avoid service interruption."
            )
    
    # 1 day before expiry
    one_day_later = now + timedelta(days=1)
    cursor_1day = db.restaurants.find({
        "status": "ACTIVE",
        "subscriptionEnd": {
            "$gte": now,
            "$lte": one_day_later
        }
    })
    
    async for restaurant in cursor_1day:
        existing = await db.notifications.find_one({
            "restaurant_id": restaurant["restaurant_id"],
            "type": "EXPIRY_REMINDER_1DAY",
            "created_at": {"$gte": now - timedelta(hours=12)}
        })
        
        if not existing:
            await create_notification(
                db,
                restaurant["restaurant_id"],
                "EXPIRY_REMINDER_1DAY",
                f"URGENT: Your {restaurant['plan']} subscription expires tomorrow! Renew now."
            )
