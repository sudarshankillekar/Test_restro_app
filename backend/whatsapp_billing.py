"""Generate completed bills and deliver them through Evolution API."""

import base64
import html
import logging
import os
import re
from datetime import datetime, timezone
from io import BytesIO
from zoneinfo import ZoneInfo

import httpx


logger = logging.getLogger(__name__)


def _money(value):
    return f"Rs. {float(value or 0):,.2f}"


def _message_money(value):
    amount = float(value or 0)
    if amount.is_integer():
        return f"Rs.{int(amount):,}"
    return f"Rs.{amount:,.2f}"


def _format_bill_datetime(value):
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return value
    if hasattr(value, "astimezone"):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        value = value.astimezone(ZoneInfo("Asia/Kolkata"))
        return value.strftime("%d/%m/%Y %H:%M")
    return datetime.now(ZoneInfo("Asia/Kolkata")).strftime("%d/%m/%Y %H:%M")


def normalize_whatsapp_number(phone):
    """Return the digits-only international number expected by Evolution API."""
    digits = re.sub(r"\D", "", str(phone or ""))
    if digits.startswith("00"):
        digits = digits[2:]
    if len(digits) == 10:
        digits = f"{os.getenv('WHATSAPP_DEFAULT_COUNTRY_CODE', '91')}{digits}"
    return digits if len(digits) >= 10 else ""


def _first_present(*values):
    for value in values:
        if value is not None and str(value).strip():
            return value
    return ""


def find_order_phone(orders):
    for order in orders:
        phone = _first_present(
            order.get("phone"),
            order.get("customer_phone"),
            order.get("mobile"),
            order.get("contact_number"),
        )
        normalized = normalize_whatsapp_number(phone)
        if normalized:
            return normalized
    return ""


async def resolve_bill_recipient_phone(payment, orders, db):
    """Resolve the bill recipient from orders first, then nearby customer records."""
    direct_phone = normalize_whatsapp_number(_first_present(
        payment.get("phone"),
        payment.get("customer_phone"),
        payment.get("mobile"),
        payment.get("contact_number"),
    ))
    if direct_phone:
        return direct_phone

    order_phone = find_order_phone(orders)
    if order_phone:
        return order_phone

    restaurant_id = payment.get("restaurant_id")
    table_id = payment.get("table_id")
    if restaurant_id and table_id and hasattr(db, "customer_sessions"):
        session = await db.customer_sessions.find_one(
            {
                "restaurant_id": restaurant_id,
                "table_id": table_id,
                "phone": {"$exists": True, "$ne": ""},
            },
            {"_id": 0, "phone": 1},
            sort=[("created_at", -1)],
        )
        session_phone = normalize_whatsapp_number((session or {}).get("phone"))
        if session_phone:
            return session_phone

    customer_name = next((order.get("customer_name") for order in orders if order.get("customer_name")), "")
    if restaurant_id and customer_name and hasattr(db, "customers"):
        customer = await db.customers.find_one(
            {
                "restaurant_id": restaurant_id,
                "customer_name": customer_name,
                "phone": {"$exists": True, "$ne": ""},
            },
            {"_id": 0, "phone": 1},
            sort=[("last_visit", -1)],
        )
        customer_phone = normalize_whatsapp_number((customer or {}).get("phone"))
        if customer_phone:
            return customer_phone

    return ""


def build_bill_pdf(payment, orders, restaurant):
    """Build a compact, printable A4 bill and return its bytes."""
    # Imported lazily so the API can still boot for non-billing endpoints if a
    # local developer has not installed the optional PDF dependency yet.
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    output = BytesIO()
    document = SimpleDocTemplate(
        output,
        pagesize=A4,
        rightMargin=16 * mm,
        leftMargin=16 * mm,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        title=f"Bill {payment.get('bill_id', payment.get('payment_id', ''))}",
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("BillTitle", parent=styles["Title"], alignment=TA_CENTER, fontSize=18, leading=22)
    center_style = ParagraphStyle("BillCenter", parent=styles["Normal"], alignment=TA_CENTER, fontSize=9)
    right_style = ParagraphStyle("BillRight", parent=styles["Normal"], alignment=TA_RIGHT, fontSize=9)
    small_style = ParagraphStyle("BillSmall", parent=styles["Normal"], fontSize=8, leading=10)

    restaurant_name = html.escape(str((restaurant or {}).get("name") or "Restaurant"))
    bill_id = html.escape(str(payment.get("bill_id") or payment.get("payment_id") or ""))
    customer_name = html.escape(str(next((o.get("customer_name") for o in orders if o.get("customer_name")), "Customer")))
    phone = html.escape(str(next((o.get("phone") for o in orders if o.get("phone")), "")))
    created_at = payment.get("created_at") or datetime.now(timezone.utc)
    if hasattr(created_at, "strftime"):
        created_text = created_at.strftime("%d %b %Y, %I:%M %p")
    else:
        created_text = str(created_at)

    story = [
        Paragraph(restaurant_name, title_style),
        Paragraph("Payment Receipt", center_style),
        Spacer(1, 5 * mm),
        Paragraph(f"Bill: {bill_id}<br/>Customer: {customer_name}<br/>Phone: {phone}<br/>Date: {html.escape(created_text)}", small_style),
        Spacer(1, 5 * mm),
    ]

    rows = [[Paragraph("Item", small_style), Paragraph("Qty", small_style), Paragraph("Amount", right_style)]]
    for order in orders:
        for item in order.get("items", []):
            quantity = float(item.get("quantity") or 0)
            amount = quantity * float(item.get("price") or 0)
            quantity_text = str(int(quantity)) if quantity.is_integer() else str(quantity)
            rows.append([
                Paragraph(html.escape(str(item.get("name") or "Item")), small_style),
                Paragraph(quantity_text, small_style),
                Paragraph(_money(amount), right_style),
            ])
    items_table = Table(rows, colWidths=[110 * mm, 20 * mm, 42 * mm], repeatRows=1)
    items_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f3f4f6")),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#d1d5db")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(items_table)
    story.append(Spacer(1, 5 * mm))

    totals = [
        ["Subtotal", _money(payment.get("subtotal"))],
        ["Service Charge", _money(payment.get("service_charge"))],
        ["Parcel Charge", _money(payment.get("parcel_charge"))],
        [f"Tax ({float(payment.get('tax_percentage') or 0):.2f}%)", _money(payment.get("tax"))],
        ["Discount", _money(payment.get("discount"))],
        ["Total Paid", _money(payment.get("total"))],
        ["Payment Method", str(payment.get("payment_method") or "").upper()],
    ]
    totals_table = Table(totals, colWidths=[130 * mm, 42 * mm], hAlign="RIGHT")
    totals_table.setStyle(TableStyle([
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("LINEABOVE", (0, -2), (-1, -2), 0.8, colors.HexColor("#111827")),
        ("FONTNAME", (0, -2), (-1, -2), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.extend([totals_table, Spacer(1, 7 * mm), Paragraph("Thank you for visiting us.", center_style)])
    document.build(story)
    return output.getvalue()


def build_whatsapp_bill_message(payment, orders, restaurant):
    customer_name = next((o.get("customer_name") for o in orders if o.get("customer_name")), "Customer")
    restaurant_name = (restaurant or {}).get("name") or "Restaurant"
    amount = _message_money(payment.get("total") or payment.get("amount"))
    created_text = _format_bill_datetime(payment.get("created_at"))
    payment_method = str(payment.get("payment_method") or "").upper()
    bill_id = payment.get("bill_id") or payment.get("payment_id")

    return (
        f"Dear {customer_name},\n\n"
        f"Thank you for your recent order at *{restaurant_name}*!\n"
        "Your invoice PDF is now available. ✨\n\n"
        f"💰 Amount : *{amount}*\n"
        f"📅 Date : {created_text}\n"
        f"🧾 Bill No : {bill_id}\n"
        f"💳 Payment : {payment_method}\n"
        "🔗 View Invoice : PDF attached\n\n"
        f"How was your experience with your order at *{restaurant_name}* today?\n\n"
        "Reply with:\n"
        "1. Loved it!\n"
        "2. Okay\n"
        "3. Needs Improvement"
    )


async def send_bill_pdf_via_evolution(payment, orders, restaurant, db):
    """Send one bill PDF and persist delivery state without affecting payment success."""
    payment_filter = {
        "restaurant_id": payment.get("restaurant_id"),
        "payment_id": payment.get("payment_id"),
    }
    api_url = (os.getenv("EVOLUTION_API_URL") or "").rstrip("/")
    api_key = os.getenv("EVOLUTION_API_KEY") or ""
    instance = os.getenv("EVOLUTION_INSTANCE") or ""
    phone = await resolve_bill_recipient_phone(payment, orders, db)

    if not api_url or not api_key or not instance:
        await db.payments.update_one(payment_filter, {"$set": {
            "whatsapp_status": "skipped",
            "whatsapp_error": "Evolution API is not configured",
            "whatsapp_updated_at": datetime.now(timezone.utc),
        }})
        return
    if not phone:
        await db.payments.update_one(payment_filter, {"$set": {
            "whatsapp_status": "skipped",
            "whatsapp_error": "Customer phone number is missing or invalid",
            "whatsapp_updated_at": datetime.now(timezone.utc),
        }})
        return

    await db.payments.update_one(payment_filter, {"$set": {
        "whatsapp_status": "sending",
        "whatsapp_updated_at": datetime.now(timezone.utc),
    }})
    try:
        pdf_bytes = build_bill_pdf(payment, orders, restaurant)
        caption = build_whatsapp_bill_message(payment, orders, restaurant)
        payload = {
            "number": phone,
            "mediatype": "document",
            "mimetype": "application/pdf",
            "caption": caption,
            "media": base64.b64encode(pdf_bytes).decode("ascii"),
            "fileName": f"{payment.get('bill_id') or 'bill'}.pdf",
        }
        endpoint = f"{api_url}/message/sendMedia/{instance}"
        async with httpx.AsyncClient(timeout=35) as client:
            response = await client.post(endpoint, headers={"apikey": api_key, "Content-Type": "application/json"}, json=payload)
            response.raise_for_status()
            result = response.json()
        message_id = ((result.get("key") or {}).get("id") if isinstance(result, dict) else None)
        await db.payments.update_one(payment_filter, {"$set": {
            "whatsapp_status": "sent",
            "whatsapp_message_id": message_id,
            "whatsapp_sent_at": datetime.now(timezone.utc),
            "whatsapp_updated_at": datetime.now(timezone.utc),
        }, "$unset": {"whatsapp_error": ""}})
    except Exception as exc:
        logger.exception("Evolution API bill delivery failed for %s", payment.get("payment_id"))
        await db.payments.update_one(payment_filter, {"$set": {
            "whatsapp_status": "failed",
            "whatsapp_error": str(exc)[:500],
            "whatsapp_updated_at": datetime.now(timezone.utc),
        }})
