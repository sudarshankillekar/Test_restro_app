from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime

class LoginRequest(BaseModel):
    email: str
    password: str

class RegisterRequest(BaseModel):
    email: str
    password: str
    name: str
    role: str = "admin"  # admin, kitchen, billing

class UserResponse(BaseModel):
    email: str
    name: str
    role: str

# Restaurant models
class RestaurantCreate(BaseModel):
    name: str
    owner_name: str
    owner_email: str
    owner_password: str
    plan: str = "BASIC"  # BASIC, PRO, PREMIUM

class RestaurantUpdate(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None  # ACTIVE, SUSPENDED, EXPIRED
    plan: Optional[str] = None
    gst_number: Optional[str] = None

class RestaurantProfileUpdate(BaseModel):
    gst_number: Optional[str] = None
    google_review_url: Optional[str] = None
    
class SubscriptionRenew(BaseModel):
    plan: str
    payment_method: str  # upi, card, cash

class CategoryCreate(BaseModel):
    name: str

class MenuItemCreate(BaseModel):
    name: str
    category_id: str
    price: float
    description: Optional[str] = None
    image: Optional[str] = None

class MenuItemUpdate(BaseModel):
    name: Optional[str] = None
    price: Optional[float] = None
    description: Optional[str] = None
    image: Optional[str] = None
    available: Optional[bool] = None

class TableCreate(BaseModel):
    table_number: int

class CustomerSessionCreate(BaseModel):
    table_id: str
    customer_name: str
    phone: str

class OrderItem(BaseModel):
    item_id: str
    quantity: int
    instructions: Optional[str] = None

class OrderItemUpdate(BaseModel):
    item_id: str
    quantity: int = Field(gt=0)
    instructions: Optional[str] = None

class OrderCreate(BaseModel):
    customer_session_token: str
    items: List[OrderItem]

class CounterOrderCreate(BaseModel):
    order_type: str = "dine_in"  # dine_in, takeaway
    table_id: Optional[str] = None
    customer_name: str
    phone: Optional[str] = None
    items: List[OrderItem]

class OrderItemsUpdate(BaseModel):
    items: List[OrderItemUpdate]
    
class OrderResponse(BaseModel):
    order_id: str
    table_id: str
    customer_name: str
    phone: str
    items: List[dict]
    total: float
    status: str
    created_at: datetime

class PaymentCreate(BaseModel):
    order_id: Optional[str] = None
    order_ids: Optional[List[str]] = None
    payment_method: str  # cash, upi, card
    discount: Optional[float] = 0

class AnalyticsResponse(BaseModel):
    total_orders: int
    total_revenue: float
    avg_order_value: float
    top_items: List[dict]
