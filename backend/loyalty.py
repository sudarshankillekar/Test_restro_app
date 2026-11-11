"""Restaurant-scoped loyalty accounting, committed atomically with each bill."""
from datetime import datetime, timezone
from decimal import Decimal, ROUND_DOWN, InvalidOperation
import re

from fastapi import HTTPException


def normalize_phone(value):
    digits = re.sub(r"[\s()+-]", "", str(value or ""))
    if digits.startswith("0091"):
        digits = digits[2:]
    if len(digits) == 10:
        digits = "91" + digits
    if not re.fullmatch(r"91[6-9]\d{9}", digits):
        raise HTTPException(400, "Enter a valid Indian mobile number for Dineflo Coins.")
    return digits


def calculate_coins(total, balance, redeem):
    try:
        amount = Decimal(str(total)).quantize(Decimal("0.01"))
    except InvalidOperation:
        raise HTTPException(400, "Invalid bill amount.")
    if not amount.is_finite() or amount < 0:
        raise HTTPException(400, "Invalid bill amount.")
    if isinstance(redeem, bool) or not isinstance(redeem, int) or redeem < 0:
        raise HTTPException(400, "Redeem a whole number of coins.")
    if redeem and balance < 200:
        raise HTTPException(400, "A balance of at least 200 coins is required to redeem.")
    if redeem > balance or Decimal(redeem) > amount:
        raise HTTPException(400, "Redemption exceeds the available balance or bill amount.")
    paid = amount - redeem
    earned = int((paid / 100).to_integral_value(rounding=ROUND_DOWN)) * 8
    return float(paid), earned, balance - redeem + earned


async def save_payment(db, payment, phone, redeem=0, order_updates=None, new_order=None):
    """Never commit a coin change without its payment and order updates."""
    if not phone:
        if redeem:
            raise HTTPException(400, "Enter the customer's phone number to redeem coins.")
        # Existing non-loyalty payments retain their original persistence flow.
        await db.payments.insert_one(dict(payment))
        return payment
    phone = normalize_phone(phone)
    account_id = f"{payment['restaurant_id']}:{phone}"
    base = dict(payment)

    async def commit(session):
        account = await db.loyalty_accounts.find_one({"_id": account_id}, session=session)
        balance = int((account or {}).get("balance", 0))
        paid, earned, closing = calculate_coins(base["total"], balance, redeem)
        document = {**base, "total": paid, "loyalty_phone": phone,
                    "loyalty_earned": earned, "loyalty_redeemed": redeem,
                    "loyalty_balance": closing, "loyalty_bill_total": base["total"],
                    "whatsapp_recipient_phone": phone}
        now = datetime.now(timezone.utc)
        await db.loyalty_accounts.update_one(
            {"_id": account_id},
            {"$set": {"restaurant_id": base["restaurant_id"], "phone": phone,
                      "balance": closing, "updated_at": now}}, upsert=True, session=session)
        await db.loyalty_ledger.insert_one({
            "_id": f"{base['restaurant_id']}:{base['payment_id']}:payment",
            "restaurant_id": base["restaurant_id"], "phone": phone,
            "payment_id": base["payment_id"], "bill_id": base["bill_id"],
            "kind": "payment", "earned": earned, "redeemed": redeem,
            "change": earned - redeem, "balance": closing, "amount_paid": paid,
            "created_at": now, "staff_id": base.get("created_by"),
        }, session=session)
        await db.payments.insert_one(dict(document), session=session)
        if order_updates:
            await db.orders.update_many(*order_updates, session=session)
        if new_order:
            await db.orders.insert_one(dict(new_order), session=session)
        return document

    async with await db.client.start_session() as session:
        document = await session.with_transaction(commit)
    payment.update(document)
    return payment


async def delete_loyalty_bill(db, payment, archive, order_ids):
    """Reverse coins and archive/delete the bill in the same transaction."""
    restaurant_id = payment["restaurant_id"]
    query = {"restaurant_id": restaurant_id, "payment_id": payment["payment_id"]}

    async def commit(session):
        current = await db.payments.find_one(query, session=session)
        if not current:
            raise HTTPException(409, "Bill has already been deleted.")
        phone = current["loyalty_phone"]
        account_id = f"{restaurant_id}:{phone}"
        account = await db.loyalty_accounts.find_one({"_id": account_id}, session=session)
        change = current.get("loyalty_redeemed", 0) - current.get("loyalty_earned", 0)
        # A reversal may create debt if earned coins were already spent.
        # Future earnings offset it; redemption remains disabled below 200.
        closing = int((account or {}).get("balance", 0)) + change
        now = datetime.now(timezone.utc)
        await db.loyalty_accounts.update_one({"_id": account_id}, {"$set": {
            "balance": closing, "updated_at": now}}, session=session)
        await db.loyalty_ledger.insert_one({
            "_id": f"{restaurant_id}:{current['payment_id']}:reversal",
            **query, "phone": phone, "bill_id": current["bill_id"], "kind": "reversal",
            "earned": -current.get("loyalty_earned", 0),
            "redeemed": -current.get("loyalty_redeemed", 0),
            "change": change, "balance": closing, "created_at": now,
            "reason": archive["reason"], "staff_id": archive.get("deleted_by_user_id"),
        }, session=session)
        await db.deleted_bills.insert_one(dict(archive), session=session)
        await db.payments.delete_one(query, session=session)
        if order_ids:
            await db.orders.delete_many({"restaurant_id": restaurant_id, "order_id": {"$in": order_ids}}, session=session)

    async with await db.client.start_session() as session:
        await session.with_transaction(commit)
