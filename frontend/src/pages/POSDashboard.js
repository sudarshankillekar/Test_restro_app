import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CreditCard,
  FileText,
  Home,
  Loader2,
  LogOut,
  Menu,
  Minus,
  MoreHorizontal,
  Pencil,
  Plus,
  Receipt,
  Search,
  ShoppingBag,
  ShoppingCart,
  Trash2,
  Utensils,
  Wallet,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';
import { normalizeImageUrl } from '../lib/utils';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';

const formatCurrency = (value = 0) => new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(Number(value || 0));

const emptySummary = {
  payment_summary: { cash: 0, upi: 0, card: 0, other: 0, total_collected: 0, payment_count: 0 },
  cash_adjustments: { total_adjustments: 0, entries: [] },
  cash_drawer: { opening_balance: 0, closing_balance: 0 },
};

const paymentOptions = [
  { value: 'cash', label: 'Cash', icon: Wallet },
  { value: 'upi', label: 'UPI', icon: Receipt },
  { value: 'card', label: 'Card', icon: CreditCard },
];

const summarizeBillItems = (orders = []) => {
  const grouped = new Map();
  orders.forEach((order) => {
    (order.items || []).forEach((item) => {
      const key = `${item.item_id || item.name}-${item.price}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.quantity += item.quantity;
        existing.amount += item.quantity * item.price;
      } else {
        grouped.set(key, {
          item_id: item.item_id,
          name: item.name,
          quantity: item.quantity,
          amount: item.quantity * item.price,
        });
      }
    });
  });
  return Array.from(grouped.values());
};

const formatPaymentMethod = (method) => (method ? method.toUpperCase() : 'N/A');

const parseBillDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return new Date(value);
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  return new Date(hasTimezone ? value : `${value}Z`);
};

const formatBillDateTime = (value) => {
  const date = parseBillDate(value);
  if (!date || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
};

const printHtml = (html, title) => {
  const popup = window.open('', '_blank', 'width=900,height=720');
  if (!popup) {
    toast.error('Please allow popups to print.');
    return;
  }

  popup.document.write(`
    <html>
      <head>
        <title>${title}</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
          h1, h2, p { margin: 0 0 12px; }
          table { width: 100%; border-collapse: collapse; margin-top: 16px; table-layout: fixed; }
          th, td { border-bottom: 1px solid #ddd; padding: 8px; text-align: left; word-break: break-word; }
          th:nth-child(2), td:nth-child(2) { width: 48px; text-align: center; }
          th:nth-child(3), td:nth-child(3) { width: 96px; text-align: right; }
          .totals { margin-top: 20px; width: min(320px, 100%); margin-left: auto; }
          .totals div { display: flex; justify-content: space-between; margin-bottom: 8px; }
          .strong { font-weight: 700; }
          .header { border-bottom: 2px solid #111; padding-bottom: 12px; margin-bottom: 16px; }
          .muted { color: #555; }
          @page { size: auto; margin: 4mm; }
          @media print {
            html, body { margin: 0; padding: 0; }
            body { width: 100%; max-width: 80mm; padding: 3mm; font-size: 12px; }
            .print-actions { display: none; }
            h1 { font-size: 18px; }
            p { margin-bottom: 6px; }
            table { margin-top: 10px; }
            th, td { padding: 5px 2px; }
            th:nth-child(2), td:nth-child(2) { width: 32px; }
            th:nth-child(3), td:nth-child(3) { width: 66px; }
            .totals { width: 100%; margin-top: 12px; }
          }
        </style>
      </head>
      <body>
        <div class="print-actions" style="display:flex; justify-content:flex-end; gap:8px; margin-bottom:16px;">
          <button onclick="window.print()" style="padding:10px 16px; border:0; border-radius:8px; background:#a93107; color:white; font-weight:700; cursor:pointer;">Print Bill</button>
          <button onclick="window.close()" style="padding:10px 16px; border:1px solid #ddd; border-radius:8px; background:white; font-weight:700; cursor:pointer;">Close</button>
        </div>
        ${html}
      </body>
    </html>
  `);
  popup.document.close();
};

const POSDashboard = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { socket, joinRoom } = useSocket();
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [tables, setTables] = useState([]);
  const [restaurantProfile, setRestaurantProfile] = useState({});
  const [summary, setSummary] = useState(emptySummary);
  const [completedBills, setCompletedBills] = useState([]);
  const [showAllBills, setShowAllBills] = useState(false);
  const [billsDialogOpen, setBillsDialogOpen] = useState(false);
  const [editingBill, setEditingBill] = useState(null);
  const [billEditForm, setBillEditForm] = useState({
    customer_name: '',
    phone: '',
    payment_method: 'cash',
    discount: '',
    items: [],
    add_item_id: '',
    add_item_query: '',
  });
  const [billActionLoading, setBillActionLoading] = useState('');
  const [orderType, setOrderType] = useState('dine_in');
  const [selectedTableId, setSelectedTableId] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState([]);
  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [discount, setDiscount] = useState('');
  const [checkingOut, setCheckingOut] = useState(false);
  const [openingDialogOpen, setOpeningDialogOpen] = useState(false);
  const [openingInput, setOpeningInput] = useState('');
  const [openingSaving, setOpeningSaving] = useState(false);
  const [adjustmentAmount, setAdjustmentAmount] = useState('');
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [adjustmentSubmitting, setAdjustmentSubmitting] = useState(false);
  const [summaryCollapsed, setSummaryCollapsed] = useState(false);
  const [mobileTab, setMobileTab] = useState('pos');
  const [cartDialogOpen, setCartDialogOpen] = useState(false);

  const loadSummary = useCallback(async () => {
    const response = await api.get('/api/pos/summary', { withCredentials: true });
    setSummary({
      ...emptySummary,
      payment_summary: {
        ...emptySummary.payment_summary,
        ...(response.data?.payment_summary || {}),
      },
      cash_adjustments: {
        ...emptySummary.cash_adjustments,
        ...(response.data?.cash_adjustments || {}),
      },
      cash_drawer: {
        ...emptySummary.cash_drawer,
        ...(response.data?.cash_drawer || {}),
      },
    });
  }, []);

  const loadCompletedBills = useCallback(async () => {
    const response = await api.get('/api/pos/completed-bills?period=daily', { withCredentials: true });
    setCompletedBills(response.data || []);
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [categoriesResponse, menuResponse, tablesResponse, profileResponse] = await Promise.all([
        api.get('/api/menu/categories', { withCredentials: true }),
        api.get('/api/menu/items', { withCredentials: true }),
        api.get('/api/tables', { withCredentials: true }),
        api.get('/api/restaurant/profile', { withCredentials: true }),
      ]);
      setCategories(categoriesResponse.data || []);
      setMenuItems(menuResponse.data || []);
      setTables(tablesResponse.data || []);
      setRestaurantProfile(profileResponse.data || {});
      await Promise.all([loadSummary(), loadCompletedBills()]);
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to load POS');
    } finally {
      setLoading(false);
    }
  }, [loadSummary, loadCompletedBills]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (socket && user?.restaurant_id) {
      joinRoom(`restaurant_${user.restaurant_id}`);
    }
  }, [socket, user, joinRoom]);

  useEffect(() => {
    if (!socket) return undefined;
    socket.on('cash_drawer_updated', loadSummary);
    return () => {
      socket.off('cash_drawer_updated', loadSummary);
    };
  }, [socket, loadSummary]);

  const visibleItems = useMemo(() => {
    const searchTerm = search.trim().toLowerCase();
    return menuItems.filter((item) => {
      const categoryMatch = selectedCategory === 'all' || item.category_id === selectedCategory;
      const searchMatch = !searchTerm || item.name.toLowerCase().includes(searchTerm);
      return categoryMatch && searchMatch;
    });
  }, [menuItems, search, selectedCategory]);

  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = Number(cart.reduce((sum, item) => sum + item.price * item.quantity, 0).toFixed(2));
  const parsedDiscount = Math.max(Number(discount || 0), 0);
  const taxPercentage = restaurantProfile.tax_enabled === false ? 0 : Number(restaurantProfile.tax_percentage ?? 5);
  const serviceChargePercentage = restaurantProfile.service_charge_enabled && orderType !== 'takeaway'
    ? Number(restaurantProfile.service_charge_percentage || 0)
    : 0;
  const serviceCharge = Number((subtotal * serviceChargePercentage / 100).toFixed(2));
  const parcelCharge = restaurantProfile.parcel_charge_enabled && orderType === 'takeaway'
    ? Number(restaurantProfile.parcel_charge || 0)
    : 0;
  const tax = Number(((subtotal + serviceCharge + parcelCharge) * taxPercentage / 100).toFixed(2));
  const total = Math.max(Number((subtotal + serviceCharge + parcelCharge + tax - parsedDiscount).toFixed(2)), 0);
  const selectedTable = tables.find((table) => table.table_id === selectedTableId);
  const paymentSummary = summary.payment_summary || emptySummary.payment_summary;
  const cashAdjustments = summary.cash_adjustments || emptySummary.cash_adjustments;
  const cashDrawer = summary.cash_drawer || emptySummary.cash_drawer;
  const displayUserName = user?.name || user?.email || 'POS Staff';
  const displayedBills = showAllBills ? completedBills : completedBills.slice(0, 5);
  const billAddItemMatches = useMemo(() => {
    const query = (billEditForm.add_item_query || '').trim().toLowerCase();
    return menuItems
      .filter((item) => item.available !== false)
      .filter((item) => !query || item.name.toLowerCase().includes(query))
      .slice(0, 8);
  }, [billEditForm.add_item_query, menuItems]);
  const dashboardStats = [
    {
      label: 'Completed Bills',
      value: paymentSummary.payment_count ?? completedBills.length,
      icon: CreditCard,
      valueClassName: 'text-violet-600',
      tintClassName: 'bg-violet-50 text-violet-600',
    },
    {
      label: 'Cash Collected',
      value: formatCurrency(Math.max(Number(paymentSummary.cash || 0), 0)),
      icon: Wallet,
      valueClassName: 'text-emerald-600',
      tintClassName: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'UPI Collected',
      value: formatCurrency(paymentSummary.upi),
      icon: Receipt,
      valueClassName: 'text-sky-600',
      tintClassName: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Card Collected',
      value: formatCurrency(paymentSummary.card),
      icon: CreditCard,
      valueClassName: 'text-violet-600',
      tintClassName: 'bg-violet-50 text-violet-600',
    },
    {
      label: 'Cash Adjustment',
      value: formatCurrency(cashAdjustments.total_adjustments),
      icon: Receipt,
      valueClassName: Number(cashAdjustments.total_adjustments || 0) >= 0 ? 'text-amber-600' : 'text-rose-600',
      tintClassName: Number(cashAdjustments.total_adjustments || 0) >= 0 ? 'bg-amber-50 text-amber-600' : 'bg-rose-50 text-rose-600',
    },
  ];

  const addItem = (item) => {
    if (!item.available) {
      toast.error(`${item.name} is not available.`);
      return;
    }
    setCart((prev) => {
      const existing = prev.find((entry) => entry.item_id === item.item_id);
      if (existing) {
        return prev.map((entry) => (
          entry.item_id === item.item_id ? { ...entry, quantity: entry.quantity + 1 } : entry
        ));
      }
      return [...prev, {
        item_id: item.item_id,
        name: item.name,
        price: Number(item.price || 0),
        image: item.image,
        quantity: 1,
        instructions: '',
      }];
    });
  };

  const updateQuantity = (itemId, nextQuantity) => {
    setCart((prev) => prev
      .map((item) => (item.item_id === itemId ? { ...item, quantity: nextQuantity } : item))
      .filter((item) => item.quantity > 0));
  };

  const updateInstructions = (itemId, instructions) => {
    setCart((prev) => prev.map((item) => (
      item.item_id === itemId ? { ...item, instructions } : item
    )));
  };

  const printBill = (bill) => {
    const payment = bill.payment || {};
    const restaurantName = restaurantProfile.name || user?.restaurant_name || 'Restaurant';
    const gstNumber = restaurantProfile.gst_number?.trim();
    const summarizedItems = summarizeBillItems(bill.orders);
    const itemsHtml = summarizedItems.map((item) => `
      <tr>
        <td>${item.name}</td>
        <td>${item.quantity}</td>
        <td>Rs. ${item.amount.toFixed(2)}</td>
      </tr>
    `).join('');
    const billSubtotal = Number(payment.subtotal || 0);
    const billServiceCharge = Number(payment.service_charge || 0);
    const billParcelCharge = Number(payment.parcel_charge || 0);
    const billTax = Number(payment.tax || 0);
    const billTaxPercentage = Number(payment.tax_percentage || 0);
    const billDiscount = Number(payment.discount || 0);
    const billTotal = Number(payment.total || 0);

    printHtml(`
      <div class="header">
        <h1>${restaurantName}</h1>
        <p class="muted">Restaurant Bill</p>
        ${gstNumber ? `<p>GST Number: ${gstNumber}</p>` : ''}
      </div>
      <p>Bill: ${bill.bill_id}</p>
      <p>${bill.table_label || ''}</p>
      <p>Customer: ${bill.customer_name || 'Walk-in Customer'}</p>
      <p>Payment Method: ${formatPaymentMethod(payment.payment_method)}</p>
      <p>Printed At: ${new Date().toLocaleString()}</p>
      <table>
        <thead>
          <tr><th>Item</th><th>Qty</th><th>Amount</th></tr>
        </thead>
        <tbody>${itemsHtml}</tbody>
      </table>
      <div class="totals">
        <div><span>Subtotal</span><span>Rs. ${billSubtotal.toFixed(2)}</span></div>
        ${billServiceCharge > 0 ? `<div><span>Service Charge</span><span>Rs. ${billServiceCharge.toFixed(2)}</span></div>` : ''}
        ${billParcelCharge > 0 ? `<div><span>Parcel Charge</span><span>Rs. ${billParcelCharge.toFixed(2)}</span></div>` : ''}
        <div><span>Tax (${billTaxPercentage.toFixed(2)}%)</span><span>Rs. ${billTax.toFixed(2)}</span></div>
        <div><span>Discount</span><span>Rs. ${billDiscount.toFixed(2)}</span></div>
        <div class="strong"><span>Total</span><span>Rs. ${billTotal.toFixed(2)}</span></div>
      </div>
    `, `${restaurantName} - ${bill.bill_id}`);
  };

  const checkout = async () => {
    if (orderType === 'dine_in' && !selectedTableId) {
      toast.error('Please select a table.');
      return;
    }
    if (cart.length === 0) {
      toast.error('Please add at least one item.');
      return;
    }
    if (!paymentMethod) {
      toast.error('Please select a payment method.');
      return;
    }

    setCheckingOut(true);
    try {
      const response = await api.post('/api/pos/checkout', {
        order_type: orderType,
        table_id: orderType === 'dine_in' ? selectedTableId : undefined,
        customer_name: customerName.trim(),
        phone: phone.trim(),
        payment_method: paymentMethod,
        discount: parsedDiscount,
        items: cart.map((item) => ({
          item_id: item.item_id,
          quantity: item.quantity,
          instructions: item.instructions || '',
        })),
      });
      toast.success('POS bill completed.');
      setCart([]);
      setCustomerName('');
      setPhone('');
      setDiscount('');
      setPaymentMethod('cash');
      setCartDialogOpen(false);
      setCheckingOut(false);
      try {
        printBill(response.data);
      } catch (printError) {
        toast.error('Bill completed, but printing failed. You can reprint it from Bills.');
      }
      Promise.allSettled([loadSummary(), loadCompletedBills()]);
    } catch (error) {
      toast.error(error.response?.data?.detail || 'POS checkout failed');
      setCheckingOut(false);
    }
  };

  const createCashAdjustment = async () => {
    const parsedAmount = Number(adjustmentAmount);
    if (!adjustmentReason.trim()) {
      toast.error('Please enter a reason for the cash adjustment.');
      return;
    }
    if (!adjustmentAmount || Number.isNaN(parsedAmount) || parsedAmount === 0) {
      toast.error('Please enter a valid adjustment amount.');
      return;
    }
    const availableCash = Math.max(Number(summary.cash_drawer?.closing_balance || 0), 0);
    if (parsedAmount < 0 && Math.abs(parsedAmount) > availableCash) {
      toast.error(`Cannot withdraw ${formatCurrency(Math.abs(parsedAmount))}; only ${formatCurrency(availableCash)} cash is available.`);
      return;
    }

    setAdjustmentSubmitting(true);
    try {
      await api.post('/api/cash-adjustments', {
        amount: parsedAmount,
        reason: adjustmentReason.trim(),
      });
      toast.success('Cash adjustment saved.');
      setAdjustmentAmount('');
      setAdjustmentReason('');
      await loadSummary();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to save adjustment');
    } finally {
      setAdjustmentSubmitting(false);
    }
  };

  const saveOpeningBalance = async () => {
    const openingBalance = Number(openingInput);
    if (Number.isNaN(openingBalance) || openingBalance < 0) {
      toast.error('Please enter a valid opening balance.');
      return;
    }
    setOpeningSaving(true);
    try {
      await api.post('/api/cash-drawer/opening', { opening_balance: openingBalance });
      toast.success('Opening balance updated.');
      setOpeningDialogOpen(false);
      await loadSummary();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to update opening balance');
    } finally {
      setOpeningSaving(false);
    }
  };

  const openBillEditor = (bill) => {
    const payment = bill.payment || {};
    const billItems = summarizeBillItems(bill.orders).map((item) => ({
      item_id: item.item_id,
      name: item.name,
      quantity: item.quantity,
      instructions: '',
    })).filter((item) => item.item_id);
    setEditingBill(bill);
    setBillEditForm({
      customer_name: bill.customer_name || '',
      phone: bill.orders?.[0]?.phone || '',
      payment_method: payment.payment_method || 'cash',
      discount: String(payment.discount ?? ''),
      items: billItems,
      add_item_id: '',
      add_item_query: '',
    });
  };

  const updateBillEditItem = (itemId, changes) => {
    setBillEditForm((form) => ({
      ...form,
      items: form.items.map((item) => (
        item.item_id === itemId ? { ...item, ...changes } : item
      )),
    }));
  };

  const removeBillEditItem = (itemId) => {
    setBillEditForm((form) => ({
      ...form,
      items: form.items.filter((item) => item.item_id !== itemId),
    }));
  };

  const addBillEditItem = () => {
    if (!billEditForm.add_item_id) return;
    const menuItem = menuItems.find((item) => item.item_id === billEditForm.add_item_id);
    if (!menuItem) return;
    setBillEditForm((form) => {
      const existing = form.items.find((item) => item.item_id === menuItem.item_id);
      return {
        ...form,
        add_item_id: '',
        add_item_query: '',
        items: existing
          ? form.items.map((item) => (
            item.item_id === menuItem.item_id ? { ...item, quantity: item.quantity + 1 } : item
          ))
          : [...form.items, {
            item_id: menuItem.item_id,
            name: menuItem.name,
            quantity: 1,
            instructions: '',
          }],
      };
    });
  };

  const saveBillEdit = async () => {
    if (!editingBill?.bill_id) return;
    const discountValue = Number(billEditForm.discount || 0);
    if (Number.isNaN(discountValue) || discountValue < 0) {
      toast.error('Please enter a valid discount.');
      return;
    }
    if (billEditForm.items.length === 0) {
      toast.error('Bill must have at least one item.');
      return;
    }

    setBillActionLoading(`edit-${editingBill.bill_id}`);
    try {
      await api.patch(`/api/pos/completed-bills/${encodeURIComponent(editingBill.bill_id)}`, {
        customer_name: billEditForm.customer_name.trim(),
        phone: billEditForm.phone.trim(),
        payment_method: billEditForm.payment_method,
        discount: discountValue,
        items: billEditForm.items.map((item) => ({
          item_id: item.item_id,
          quantity: Math.max(Number(item.quantity || 1), 1),
          instructions: item.instructions || '',
        })),
      });
      toast.success('Bill updated.');
      setEditingBill(null);
      await Promise.all([loadCompletedBills(), loadSummary()]);
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to update bill');
    } finally {
      setBillActionLoading('');
    }
  };

  const deleteBill = async (bill) => {
    if (!bill?.bill_id) return;
    if (!window.confirm(`Delete ${bill.bill_id}? This will remove the bill and its POS order.`)) return;

    setBillActionLoading(`delete-${bill.bill_id}`);
    try {
      await api.delete(`/api/pos/completed-bills/${encodeURIComponent(bill.bill_id)}`);
      toast.success('Bill deleted.');
      await Promise.all([loadCompletedBills(), loadSummary()]);
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to delete bill');
    } finally {
      setBillActionLoading('');
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/pos-login', { replace: true });
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f8f9fa]">
        <Loader2 className="h-10 w-10 animate-spin text-[#a93107]" />
      </div>
    );
  }

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#f8f9fa] pb-40 text-[#191c1d] lg:pb-36 xl:h-screen xl:overflow-hidden xl:pb-0">
      <main className="flex min-h-screen flex-col overflow-visible lg:h-screen lg:min-h-0 lg:overflow-hidden xl:mr-[390px]">
        <header className="shrink-0 border-b border-[#e1bfb6]/50 bg-[#f8f9fa]/95 px-4 py-3 backdrop-blur md:px-6">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#ebe0dc]/70 text-[#191c1d] md:flex xl:hidden"
                onClick={() => setSummaryCollapsed((value) => !value)}
              >
                <Menu className="h-5 w-5" />
              </button>
              <div className="flex min-w-0 items-center gap-2">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#ebe0dc] font-black text-[#645d5a] sm:h-12 sm:w-12">
                  {displayUserName.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-black text-[#191c1d]">{displayUserName}</p>
                  <p className="text-xs font-bold text-[#645d5a]">Signed in</p>
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" className="h-10 shrink-0 rounded-2xl px-3 text-sm font-bold sm:h-11 sm:px-4" onClick={handleLogout}>
                <LogOut className="mr-2 h-4 w-4" />
                Logout
              </Button>
              <Badge className="h-10 rounded-2xl bg-[#ffdbd1]/70 px-3 text-sm font-black text-[#a93107] hover:bg-[#ffdbd1]/70 sm:h-11 sm:px-4">
                <Receipt className="mr-2 h-4 w-4 text-[#a93107]" />
                Billing
              </Badge>
            </div>
          </div>
        </header>

        <section className="shrink-0 border-b border-[#e1bfb6]/50 bg-white px-4 py-2 md:px-6">
          <div className="mx-auto grid max-w-5xl grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)] items-center gap-2 rounded-2xl border border-[#e1bfb6]/70 bg-white px-3 py-2 shadow-sm sm:gap-4 sm:px-4">
            <div className="flex items-center justify-center gap-2 sm:gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-green-50 text-green-700 sm:h-9 sm:w-9">
                <Wallet className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold leading-tight text-[#59413b] sm:text-sm">Opening</p>
                <p className="text-base font-black leading-tight text-green-700 sm:text-lg">{formatCurrency(cashDrawer.opening_balance)}</p>
                <button
                  type="button"
                  className="text-xs font-black leading-tight text-[#645d5a] hover:text-[#a93107]"
                  onClick={() => {
                    setOpeningInput(String(Math.max(Number(cashDrawer.opening_balance || 0), 0)));
                    setOpeningDialogOpen(true);
                  }}
                >
                  Edit
                </button>
              </div>
            </div>
            <div className="h-10 w-px bg-[#e1bfb6] sm:h-12" />
            <div className="flex items-center justify-center gap-2 sm:gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#ffdbd1]/60 text-[#a93107] sm:h-9 sm:w-9">
                <CreditCard className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold leading-tight text-[#59413b] sm:text-sm">Closing</p>
                <p className="text-base font-black leading-tight text-[#a93107] sm:text-lg">{formatCurrency(cashDrawer.closing_balance)}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="min-h-0 flex-1 px-4 py-3 md:px-6 md:py-4">
          <div className={`grid h-full min-h-0 gap-5 ${summaryCollapsed ? 'xl:grid-cols-[minmax(0,1fr)]' : 'lg:grid-cols-[300px,minmax(0,1fr)] xl:grid-cols-[320px,minmax(0,1fr)]'}`}>
            <div className={`${mobileTab === 'summary' || mobileTab === 'cash' ? 'flex' : 'hidden'} ${summaryCollapsed ? 'lg:hidden' : 'lg:flex'} min-h-0 flex-col`}>
          <div className="shrink-0 rounded-2xl border border-[#e1bfb6]/60 bg-white/90 px-3 py-2 shadow-sm">
            <div className="flex min-h-[58px] items-center">
              <p className="text-sm font-black text-[#59413b]">{mobileTab === 'cash' ? 'Cash' : 'Transaction Summary'}</p>
            </div>
          </div>

          <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <div className={`${mobileTab === 'summary' ? 'grid' : 'hidden'} gap-2 lg:grid`}>
            {dashboardStats.map((stat) => {
              const Icon = stat.icon;
              return (
                <Card key={stat.label} className="rounded-2xl border border-[#e1bfb6]/50 bg-white/90 shadow-sm">
                  <CardContent className="flex min-h-[58px] items-center gap-2 px-3 py-2">
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${stat.tintClassName}`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 sm:flex sm:items-baseline sm:gap-3">
                      <p className="truncate text-sm font-black text-[#59413b]">{stat.label}</p>
                      <p className={`truncate text-base font-black leading-tight ${stat.valueClassName}`}>{stat.value}</p>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <div className="rounded-2xl border border-[#e1bfb6]/40 bg-white/85 px-4 py-3 text-sm text-[#645d5a] shadow-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span>Drawer balance uses cash only. UPI and card payments are excluded.</span>
              <span className="font-bold text-[#59413b]">Opening: {formatCurrency(cashDrawer.opening_balance)}</span>
              <span className="font-bold text-[#59413b]">Base cash: {formatCurrency(paymentSummary.cash)}</span>
              <span className={Number(cashAdjustments.total_adjustments || 0) >= 0 ? 'font-bold text-emerald-600' : 'font-bold text-rose-600'}>
                Adjustment: {formatCurrency(cashAdjustments.total_adjustments)}
              </span>
              <span className="font-black text-[#191c1d]">Closing: {formatCurrency(cashDrawer.closing_balance)}</span>
            </div>
          </div>

          <Card className={`${mobileTab === 'cash' ? 'block' : 'hidden lg:block'} rounded-2xl border border-[#e1bfb6]/60 bg-white shadow-sm`}>
            <CardContent className="space-y-4 p-5">
              <div className="flex items-center gap-2">
                <Receipt className="h-5 w-5 text-[#a93107]" />
                <h2 className="text-xl font-black">Cash Adjustment</h2>
              </div>
              <div className="space-y-2">
                <Label htmlFor="pos-adjustment-amount" className="font-bold text-[#59413b]">Amount</Label>
                <Input
                  id="pos-adjustment-amount"
                  type="number"
                  step="0.01"
                  value={adjustmentAmount}
                  onChange={(event) => setAdjustmentAmount(event.target.value)}
                  placeholder="Use - for deduction, + for addition"
                  className="h-12 rounded-xl"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pos-adjustment-reason" className="font-bold text-[#59413b]">Reason</Label>
                <Textarea
                  id="pos-adjustment-reason"
                  value={adjustmentReason}
                  onChange={(event) => setAdjustmentReason(event.target.value)}
                  placeholder="Explain the cash adjustment"
                  className="min-h-[110px] rounded-xl"
                />
              </div>
              <Button
                type="button"
                disabled={adjustmentSubmitting}
                onClick={createCashAdjustment}
                className="h-12 w-full rounded-xl bg-[#cb4920] text-base font-black text-white hover:bg-[#a93107]"
              >
                {adjustmentSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : 'Save Adjustment'}
              </Button>
              <div className="rounded-xl bg-[#f8f9fa] p-3 text-sm font-medium text-[#645d5a]">
                This updates only the cash drawer closing balance. Revenue and Cash Collected are not affected.
              </div>
            </CardContent>
          </Card>

          <Card className="hidden rounded-2xl border border-[#e1bfb6]/60 bg-white shadow-sm lg:block">
            <CardContent className="space-y-4 p-5">
              <div className="flex items-center gap-2">
                <CreditCard className="h-5 w-5 text-violet-600" />
                <h2 className="text-xl font-black">Bills</h2>
              </div>
              <p className="text-sm font-medium text-[#645d5a]">
                View and reprint completed bills from today.
              </p>
              <Button
                type="button"
                variant="outline"
                className="h-12 w-full rounded-xl font-black"
                onClick={() => {
                  loadCompletedBills();
                  setBillsDialogOpen(true);
                }}
              >
                View Bills
              </Button>
            </CardContent>
          </Card>
          </div>
            </div>

            <div className={`${mobileTab === 'pos' ? 'flex' : 'hidden'} min-h-0 flex-col space-y-3 overflow-visible lg:flex lg:space-y-4 lg:overflow-hidden`}>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setOrderType('dine_in')}
              className={`flex h-12 items-center justify-center gap-2 rounded-3xl border text-base font-black transition sm:h-16 sm:text-lg ${orderType === 'dine_in' ? 'border-[#a93107] bg-[#d92d0b] text-white shadow-sm' : 'border-[#e1bfb6] bg-white text-[#59413b]'}`}
            >
              <Utensils className="h-5 w-5" />
              Dine-In
            </button>
            <button
              type="button"
              onClick={() => {
                setOrderType('takeaway');
                setSelectedTableId('');
              }}
              className={`flex h-12 items-center justify-center gap-2 rounded-3xl border text-base font-black transition sm:h-16 sm:text-lg ${orderType === 'takeaway' ? 'border-[#a93107] bg-[#d92d0b] text-white shadow-sm' : 'border-[#e1bfb6] bg-white text-[#59413b]'}`}
            >
              <ShoppingBag className="h-5 w-5" />
              Takeaway
            </button>
          </div>

          <div className="relative w-full">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#59413b]" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search items"
              className="h-12 rounded-3xl border-0 bg-[#edeeef] pl-12 pr-11 text-base shadow-none sm:h-14"
            />
            {search && (
              <button
                type="button"
                className="absolute right-4 top-1/2 -translate-y-1/2 text-[#59413b]"
                onClick={() => setSearch('')}
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>

          {orderType === 'dine_in' && (
            <div className="space-y-2 sm:space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-black uppercase tracking-wide text-[#645d5a]">Select Table</h2>
                <span className="text-sm font-bold text-[#a93107]">{tables.length} Tables</span>
              </div>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 sm:gap-3 md:grid-cols-8 xl:grid-cols-10">
                {tables.map((table) => (
                  <button
                    key={table.table_id}
                    type="button"
                    onClick={() => setSelectedTableId(table.table_id)}
                    className={`h-11 rounded-2xl border text-base font-black sm:h-14 ${selectedTableId === table.table_id ? 'border-[#a93107] bg-[#cb4920] text-white' : 'border-[#e1bfb6] bg-white text-[#191c1d]'}`}
                  >
                    T{table.table_number}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2 overflow-x-auto pb-1 sm:gap-3">
            <Button
              type="button"
              onClick={() => setSelectedCategory('all')}
              className={`h-11 shrink-0 rounded-2xl px-5 text-base font-black sm:h-12 sm:px-6 ${selectedCategory === 'all' ? 'bg-[#d92d0b] text-white hover:bg-[#b92308]' : 'border border-[#e1bfb6] bg-white text-[#191c1d] hover:bg-white'}`}
            >
              All
            </Button>
            {categories.map((category) => (
              <Button
                key={category.category_id}
                type="button"
                onClick={() => setSelectedCategory(category.category_id)}
                className={`h-11 shrink-0 rounded-2xl px-5 text-base font-bold sm:h-12 sm:px-6 ${selectedCategory === category.category_id ? 'bg-[#d92d0b] text-white hover:bg-[#b92308]' : 'border border-[#e1bfb6] bg-white text-[#191c1d] hover:bg-white'}`}
              >
                {category.name}
              </Button>
            ))}
          </div>

          <div className="flex items-center justify-between">
            <p className="text-xl font-black sm:text-2xl">{visibleItems.length} items</p>
            <p className="text-sm font-bold text-[#645d5a]">{cartCount} in cart</p>
          </div>

          <div className="min-h-0 flex-1 overflow-visible pb-8 pr-0 lg:overflow-y-auto lg:pb-0 lg:pr-1">
          <div className="grid grid-cols-3 gap-2 sm:gap-3 lg:grid-cols-4 2xl:grid-cols-5">
            {visibleItems.map((item) => {
              const cartItem = cart.find((entry) => entry.item_id === item.item_id);
              const imageUrl = normalizeImageUrl(item.image);
              return (
                <Card key={item.item_id} className={`overflow-hidden rounded-xl border-[#e1bfb6] bg-white shadow-[0_4px_12px_rgba(0,0,0,0.04)] ${!item.available ? 'opacity-60' : ''}`}>
                  <CardContent className="flex h-full flex-col p-0">
                    <button type="button" className="text-left" onClick={() => addItem(item)}>
                      {imageUrl ? (
                        <img src={imageUrl} alt={item.name} className="h-16 w-full object-cover sm:h-20 lg:h-24" />
                      ) : (
                        <div className="flex h-16 w-full items-center justify-center bg-[#edeeef] text-[#8d7169] sm:h-20 lg:h-24">
                          <Utensils className="h-5 w-5 sm:h-6 sm:w-6" />
                        </div>
                      )}
                    </button>
                    <div className="flex flex-1 flex-col p-2">
                      <div className="flex items-start justify-between gap-1 sm:gap-2">
                        <div className="min-w-0">
                          <h3 className="line-clamp-2 min-h-[2rem] text-xs font-black leading-tight sm:text-sm">{item.name}</h3>
                          <p className="mt-1 text-sm font-black text-[#d92d0b] sm:text-lg">{formatCurrency(item.price)}</p>
                        </div>
                        {cartItem && <Badge className="rounded-full bg-green-100 px-1.5 text-xs text-green-700 hover:bg-green-100">{cartItem.quantity}</Badge>}
                      </div>
                      <Button
                        type="button"
                        disabled={!item.available}
                        onClick={() => addItem(item)}
                        className="mt-2 h-8 rounded-xl bg-[#d92d0b] text-sm font-black text-white hover:bg-[#b92308] sm:h-9"
                      >
                        <Plus className="mr-1 h-4 w-4" />
                        Add
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          </div>

          </div>
          </div>
        </section>
      </main>

      <aside className="hidden border-t border-[#e1bfb6] bg-white xl:fixed xl:inset-y-0 xl:right-0 xl:z-30 xl:flex xl:w-[390px] xl:flex-col xl:border-l xl:border-t-0">
        <div className="flex items-center justify-between border-b border-[#e1bfb6] px-4 py-4">
          <div className="flex items-center gap-3">
            <ShoppingBag className="h-6 w-6 text-[#a93107]" />
            <h2 className="text-2xl font-black">Your Order ({cartCount})</h2>
          </div>
          {cart.length > 0 && (
            <Button variant="ghost" className="text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => setCart([])}>
              <Trash2 className="mr-2 h-4 w-4" />
              Clear
            </Button>
          )}
        </div>

        <div className="max-h-[46vh] overflow-y-auto px-4 py-4 xl:min-h-0 xl:flex-1 xl:max-h-none">
          {cart.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[#e1bfb6] p-6 text-center text-[#645d5a]">
              <ShoppingCart className="mx-auto h-10 w-10" />
              <p className="mt-3 font-bold">No items added</p>
            </div>
          ) : (
            <div className="space-y-4">
              {cart.map((item) => {
                const imageUrl = normalizeImageUrl(item.image);
                return (
                  <div key={item.item_id} className="border-b border-[#e1bfb6]/70 pb-4">
                    <div className="flex gap-3">
                      {imageUrl ? (
                        <img src={imageUrl} alt={item.name} className="h-16 w-16 rounded-xl object-cover" />
                      ) : (
                        <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-[#edeeef] text-[#8d7169]">
                          <Utensils className="h-6 w-6" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className="line-clamp-2 font-black">{item.name}</p>
                          <button type="button" onClick={() => updateQuantity(item.item_id, 0)} className="text-[#645d5a]">
                            <X className="h-5 w-5" />
                          </button>
                        </div>
                        <div className="mt-3 flex items-center justify-between gap-3">
                          <div className="flex items-center overflow-hidden rounded-xl bg-[#edeeef]">
                            <button type="button" className="flex h-11 w-11 items-center justify-center" onClick={() => updateQuantity(item.item_id, item.quantity - 1)}>
                              <Minus className="h-4 w-4" />
                            </button>
                            <span className="min-w-[2.5rem] text-center text-lg font-black">{item.quantity}</span>
                            <button type="button" className="flex h-11 w-11 items-center justify-center" onClick={() => updateQuantity(item.item_id, item.quantity + 1)}>
                              <Plus className="h-4 w-4" />
                            </button>
                          </div>
                          <p className="text-lg font-black">{formatCurrency(item.price * item.quantity)}</p>
                        </div>
                      </div>
                    </div>
                    <Textarea
                      value={item.instructions}
                      onChange={(event) => updateInstructions(item.item_id, event.target.value)}
                      placeholder="Special instructions"
                      className="mt-3 min-h-[42px] rounded-xl"
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-3 border-t border-[#e1bfb6] bg-[#f8f9fa] px-4 py-4">
          <div className="grid grid-cols-2 gap-3">
            <Input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Customer name" className="h-11 rounded-xl bg-white" />
            <Input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="Phone" className="h-11 rounded-xl bg-white" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            {paymentOptions.map((option) => {
              const Icon = option.icon;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setPaymentMethod(option.value)}
                  className={`flex h-12 items-center justify-center gap-1 rounded-xl border text-sm font-black ${paymentMethod === option.value ? 'border-[#a93107] bg-[#a93107] text-white' : 'border-[#e1bfb6] bg-white text-[#59413b]'}`}
                >
                  <Icon className="h-4 w-4" />
                  {option.label}
                </button>
              );
            })}
          </div>
          <Input
            type="number"
            min="0"
            value={discount}
            onChange={(event) => setDiscount(event.target.value)}
            placeholder="Discount"
            className="h-11 rounded-xl bg-white"
          />
          <div className="space-y-2 text-base">
            <div className="flex justify-between"><span className="text-[#645d5a]">Subtotal</span><span>{formatCurrency(subtotal)}</span></div>
            {serviceCharge > 0 && <div className="flex justify-between"><span className="text-[#645d5a]">Service</span><span>{formatCurrency(serviceCharge)}</span></div>}
            {parcelCharge > 0 && <div className="flex justify-between"><span className="text-[#645d5a]">Parcel</span><span>{formatCurrency(parcelCharge)}</span></div>}
            <div className="flex justify-between"><span className="text-[#645d5a]">Tax ({taxPercentage.toFixed(2)}%)</span><span>{formatCurrency(tax)}</span></div>
            <div className="flex justify-between"><span className="text-[#645d5a]">Discount</span><span>{formatCurrency(parsedDiscount)}</span></div>
            <div className="flex justify-between border-t border-[#e1bfb6] pt-3 text-3xl font-black text-[#a93107]">
              <span>Total</span>
              <span>{formatCurrency(total)}</span>
            </div>
          </div>
          <Button
            type="button"
            disabled={checkingOut || cart.length === 0 || (orderType === 'dine_in' && !selectedTable)}
            onClick={checkout}
            className="h-14 w-full rounded-2xl bg-[#a93107] text-lg font-black text-white hover:bg-[#862200]"
          >
            {checkingOut ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Completing...
              </>
            ) : 'Pay & Print Bill'}
          </Button>
        </div>
      </aside>

      <div className="fixed inset-x-4 bottom-20 z-40 xl:hidden">
        <button
          type="button"
          onClick={() => setCartDialogOpen(true)}
          className="flex w-full items-center gap-3 rounded-[2rem] border border-[#e1bfb6]/70 bg-[#fff2ee]/95 px-4 py-3 text-left shadow-lg backdrop-blur"
        >
          <div className="relative flex h-11 w-11 shrink-0 items-center justify-center text-[#a93107]">
            <ShoppingCart className="h-9 w-9" />
            <span className="absolute -right-1 -top-1 flex h-6 min-w-6 items-center justify-center rounded-full bg-[#d92d0b] px-1 text-xs font-black text-white">
              {cartCount}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-base font-black">Your Order</p>
            <p className="truncate text-sm font-bold text-[#645d5a]">{cart.length === 0 ? 'No items added' : `${cartCount} items added`}</p>
          </div>
          <p className="shrink-0 text-lg font-black text-[#d92d0b]">{formatCurrency(total)}</p>
          <span className="text-3xl font-black text-[#d92d0b]">›</span>
        </button>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-[#e1bfb6]/50 bg-white/95 px-4 pb-4 pt-3 shadow-[0_-6px_18px_rgba(0,0,0,0.06)] backdrop-blur xl:hidden">
        <div className="mx-auto grid max-w-3xl grid-cols-5 gap-2 text-xs font-bold">
          <button type="button" className={`flex flex-col items-center gap-1 ${mobileTab === 'pos' ? 'text-[#d92d0b]' : 'text-[#645d5a]'}`} onClick={() => setMobileTab('pos')}>
            <span className={`flex h-9 w-9 items-center justify-center rounded-2xl ${mobileTab === 'pos' ? 'bg-[#ffdbd1]/60' : ''}`}><Home className="h-5 w-5" /></span>
            POS
          </button>
          <button
            type="button"
            className="flex flex-col items-center gap-1 text-[#645d5a]"
            onClick={() => {
              setMobileTab('bills');
              loadCompletedBills();
              setBillsDialogOpen(true);
            }}
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-2xl"><FileText className="h-5 w-5" /></span>
            Bills
          </button>
          <button type="button" className={`flex flex-col items-center gap-1 ${mobileTab === 'cash' ? 'text-green-700' : 'text-[#645d5a]'}`} onClick={() => setMobileTab('cash')}>
            <span className={`flex h-9 w-9 items-center justify-center rounded-2xl ${mobileTab === 'cash' ? 'bg-green-50 text-green-700' : ''}`}><Wallet className="h-5 w-5" /></span>
            Cash
          </button>
          <button type="button" className={`flex flex-col items-center gap-1 ${mobileTab === 'summary' ? 'text-blue-600' : 'text-[#645d5a]'}`} onClick={() => setMobileTab('summary')}>
            <span className={`flex h-9 w-9 items-center justify-center rounded-2xl ${mobileTab === 'summary' ? 'bg-blue-50 text-blue-600' : ''}`}><Receipt className="h-5 w-5" /></span>
            Summary
          </button>
          <button type="button" className="flex flex-col items-center gap-1 text-[#645d5a]">
            <span className="flex h-9 w-9 items-center justify-center rounded-2xl"><MoreHorizontal className="h-5 w-5" /></span>
            More
          </button>
        </div>
      </nav>

      <Dialog open={cartDialogOpen} onOpenChange={setCartDialogOpen}>
        <DialogContent className="max-h-[88vh] overflow-hidden rounded-3xl sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShoppingCart className="h-5 w-5 text-[#a93107]" />
              Your Order ({cartCount})
            </DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-col gap-4">
            <div className="max-h-[34vh] overflow-y-auto rounded-2xl border border-[#e1bfb6]/70 p-3">
              {cart.length === 0 ? (
                <div className="p-6 text-center text-[#645d5a]">
                  <ShoppingCart className="mx-auto h-10 w-10" />
                  <p className="mt-3 font-bold">No items added</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {cart.map((item) => {
                    const imageUrl = normalizeImageUrl(item.image);
                    return (
                      <div key={item.item_id} className="border-b border-[#e1bfb6]/70 pb-3 last:border-b-0 last:pb-0">
                        <div className="flex gap-3">
                          {imageUrl ? (
                            <img src={imageUrl} alt={item.name} className="h-14 w-14 rounded-xl object-cover" />
                          ) : (
                            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[#edeeef] text-[#8d7169]">
                              <Utensils className="h-5 w-5" />
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-2">
                              <p className="line-clamp-2 font-black">{item.name}</p>
                              <button type="button" onClick={() => updateQuantity(item.item_id, 0)} className="text-[#645d5a]">
                                <X className="h-5 w-5" />
                              </button>
                            </div>
                            <div className="mt-2 flex items-center justify-between gap-3">
                              <div className="flex items-center overflow-hidden rounded-xl bg-[#edeeef]">
                                <button type="button" className="flex h-9 w-9 items-center justify-center" onClick={() => updateQuantity(item.item_id, item.quantity - 1)}>
                                  <Minus className="h-4 w-4" />
                                </button>
                                <span className="min-w-[2rem] text-center font-black">{item.quantity}</span>
                                <button type="button" className="flex h-9 w-9 items-center justify-center" onClick={() => updateQuantity(item.item_id, item.quantity + 1)}>
                                  <Plus className="h-4 w-4" />
                                </button>
                              </div>
                              <p className="font-black">{formatCurrency(item.price * item.quantity)}</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Customer name" className="h-11 rounded-xl bg-white" />
              <Input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="Phone" className="h-11 rounded-xl bg-white" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              {paymentOptions.map((option) => {
                const Icon = option.icon;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setPaymentMethod(option.value)}
                    className={`flex h-11 items-center justify-center gap-1 rounded-xl border text-sm font-black ${paymentMethod === option.value ? 'border-[#a93107] bg-[#a93107] text-white' : 'border-[#e1bfb6] bg-white text-[#59413b]'}`}
                  >
                    <Icon className="h-4 w-4" />
                    {option.label}
                  </button>
                );
              })}
            </div>
            <Input
              type="number"
              min="0"
              value={discount}
              onChange={(event) => setDiscount(event.target.value)}
              placeholder="Discount"
              className="h-11 rounded-xl bg-white"
            />
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-[#645d5a]">Subtotal</span><span>{formatCurrency(subtotal)}</span></div>
              {serviceCharge > 0 && <div className="flex justify-between"><span className="text-[#645d5a]">Service</span><span>{formatCurrency(serviceCharge)}</span></div>}
              {parcelCharge > 0 && <div className="flex justify-between"><span className="text-[#645d5a]">Parcel</span><span>{formatCurrency(parcelCharge)}</span></div>}
              <div className="flex justify-between"><span className="text-[#645d5a]">Tax ({taxPercentage.toFixed(2)}%)</span><span>{formatCurrency(tax)}</span></div>
              <div className="flex justify-between"><span className="text-[#645d5a]">Discount</span><span>{formatCurrency(parsedDiscount)}</span></div>
              <div className="flex justify-between border-t border-[#e1bfb6] pt-3 text-2xl font-black text-[#a93107]">
                <span>Total</span>
                <span>{formatCurrency(total)}</span>
              </div>
            </div>
            <Button
              type="button"
              disabled={checkingOut || cart.length === 0 || (orderType === 'dine_in' && !selectedTable)}
              onClick={checkout}
              className="h-12 w-full rounded-2xl bg-[#a93107] text-base font-black text-white hover:bg-[#862200]"
            >
              {checkingOut ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Completing...
                </>
              ) : 'Pay & Print Bill'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={openingDialogOpen} onOpenChange={setOpeningDialogOpen}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5 text-[#a93107]" />
              Opening Balance
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="pos-opening-balance">Amount</Label>
              <Input
                id="pos-opening-balance"
                type="number"
                min="0"
                step="0.01"
                value={openingInput}
                onChange={(event) => setOpeningInput(event.target.value)}
                className="h-12 rounded-xl"
              />
            </div>
            <Button
              type="button"
              disabled={openingSaving}
              onClick={saveOpeningBalance}
              className="h-12 w-full rounded-xl bg-[#a93107] font-black text-white hover:bg-[#862200]"
            >
              {openingSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save Opening Balance'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={billsDialogOpen} onOpenChange={setBillsDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-hidden rounded-2xl sm:max-w-7xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-[#a93107]" />
              Completed Bills
            </DialogTitle>
          </DialogHeader>
          <div className="min-h-0 space-y-4">
            {completedBills.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[#e1bfb6] p-6 text-center font-bold text-[#645d5a]">
                No completed bills found for today.
              </div>
            ) : (
              <>
                <div className="max-h-[58vh] overflow-auto rounded-2xl border border-[#e1bfb6]/70">
                  <div className="divide-y divide-[#e1bfb6]/60">
                    <div className="hidden grid-cols-[140px_minmax(150px,1fr)_150px_80px_110px_220px] gap-3 bg-[#f8f9fa] px-4 py-3 text-xs font-black uppercase text-[#645d5a] xl:grid">
                      <span>Bill</span>
                      <span>Table / Customer</span>
                      <span>Date & Time</span>
                      <span>Payment</span>
                      <span className="text-right">Total</span>
                      <span className="text-right">Actions</span>
                    </div>
                    {displayedBills.map((bill) => {
                      const payment = bill.payment || {};
                      const createdAt = formatBillDateTime(payment.created_at);
                      const isDeleting = billActionLoading === `delete-${bill.bill_id}`;
                      return (
                        <div key={bill.bill_id} className="grid gap-3 bg-white px-4 py-3 text-sm xl:grid-cols-[140px_minmax(150px,1fr)_150px_80px_110px_220px] xl:items-center">
                          <div className="flex items-start justify-between gap-3 xl:block">
                            <div className="min-w-0">
                              <p className="truncate font-black text-[#191c1d]">{bill.bill_id}</p>
                              <p className="mt-1 text-xs font-medium text-[#645d5a] xl:hidden">{createdAt || 'N/A'}</p>
                            </div>
                            <div className="shrink-0 text-right xl:hidden">
                              <p className="whitespace-nowrap text-base font-black text-[#a93107]">{formatCurrency(payment.total)}</p>
                              <p className="text-xs font-black text-[#645d5a]">{formatPaymentMethod(payment.payment_method)}</p>
                            </div>
                          </div>
                          <div className="min-w-0">
                            <p className="truncate font-bold text-[#191c1d]">{bill.table_label || 'POS Bill'}</p>
                            <p className="truncate text-xs font-medium text-[#645d5a]">{bill.customer_name || 'Walk-in Customer'}</p>
                          </div>
                          <div className="hidden font-medium text-[#645d5a] xl:block">{createdAt || 'N/A'}</div>
                          <div className="hidden font-black text-[#645d5a] xl:block">{formatPaymentMethod(payment.payment_method)}</div>
                          <div className="hidden whitespace-nowrap text-right text-base font-black text-[#a93107] xl:block">{formatCurrency(payment.total)}</div>
                          <div className="grid grid-cols-3 gap-2 xl:flex xl:justify-end xl:gap-1.5">
                            <Button type="button" variant="outline" className="h-9 rounded-xl px-2 font-black" onClick={() => openBillEditor(bill)}>
                              <Pencil className="mr-1 h-4 w-4" />
                              Edit
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              disabled={isDeleting}
                              className="h-9 rounded-xl px-2 font-black text-red-600 hover:bg-red-50 hover:text-red-700"
                              onClick={() => deleteBill(bill)}
                            >
                              {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}
                              {!isDeleting && 'Delete'}
                            </Button>
                            <Button type="button" variant="outline" className="h-9 rounded-xl px-2 font-black" onClick={() => printBill(bill)}>
                              Reprint
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                {completedBills.length > 5 && (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 w-full rounded-xl font-black"
                    onClick={() => setShowAllBills((value) => !value)}
                  >
                    {showAllBills ? 'Show Recent Bills' : `Show All ${completedBills.length} Bills`}
                  </Button>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editingBill)} onOpenChange={(open) => !open && setEditingBill(null)}>
        <DialogContent className="max-h-[90vh] overflow-hidden rounded-2xl sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5 text-[#a93107]" />
              Edit Bill
            </DialogTitle>
          </DialogHeader>
          <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-h-0 space-y-3">
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1 space-y-2">
                  <Label htmlFor="bill-add-item-search">Search item to add</Label>
                  <Input
                    id="bill-add-item-search"
                    value={billEditForm.add_item_query}
                    onChange={(event) => setBillEditForm((form) => ({
                      ...form,
                      add_item_query: event.target.value,
                      add_item_id: '',
                    }))}
                    placeholder="Search menu items"
                    className="h-11 rounded-xl"
                  />
                </div>
                <Button type="button" className="h-11 rounded-xl bg-[#a93107] font-black text-white hover:bg-[#862200]" onClick={addBillEditItem}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add
                </Button>
              </div>
              <div className="max-h-36 overflow-y-auto rounded-2xl border border-[#e1bfb6]/70 bg-white">
                {billAddItemMatches.map((item) => {
                  const selected = billEditForm.add_item_id === item.item_id;
                  return (
                    <button
                      key={item.item_id}
                      type="button"
                      className={`flex w-full items-center justify-between gap-3 border-b border-[#e1bfb6]/50 px-3 py-2 text-left last:border-b-0 ${selected ? 'bg-[#ffdbd1]/50' : 'hover:bg-[#f8f9fa]'}`}
                      onClick={() => setBillEditForm((form) => ({
                        ...form,
                        add_item_id: item.item_id,
                        add_item_query: item.name,
                      }))}
                    >
                      <span className="truncate text-sm font-black">{item.name}</span>
                      <span className="shrink-0 text-sm font-black text-[#a93107]">{formatCurrency(item.price)}</span>
                    </button>
                  );
                })}
                {billAddItemMatches.length === 0 && (
                  <div className="px-3 py-3 text-sm font-bold text-[#645d5a]">No items found.</div>
                )}
              </div>
              <div className="max-h-[52vh] overflow-y-auto rounded-2xl border border-[#e1bfb6]/70">
                <div className="grid grid-cols-[minmax(0,1fr)_92px_44px] bg-[#f8f9fa] px-3 py-2 text-xs font-black uppercase text-[#645d5a]">
                  <span>Item</span>
                  <span className="text-center">Qty</span>
                  <span />
                </div>
                {billEditForm.items.map((item) => (
                  <div key={item.item_id} className="grid grid-cols-[minmax(0,1fr)_92px_44px] items-center gap-2 border-t border-[#e1bfb6]/60 px-3 py-2">
                    <p className="truncate font-black">{item.name}</p>
                    <Input
                      type="number"
                      min="1"
                      value={item.quantity}
                      onChange={(event) => updateBillEditItem(item.item_id, { quantity: Math.max(Number(event.target.value || 1), 1) })}
                      className="h-10 rounded-xl text-center"
                    />
                    <button
                      type="button"
                      className="flex h-10 w-10 items-center justify-center rounded-xl text-red-600 hover:bg-red-50"
                      onClick={() => removeBillEditItem(item.item_id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                {billEditForm.items.length === 0 && (
                  <div className="p-4 text-center text-sm font-bold text-[#645d5a]">No items in this bill.</div>
                )}
              </div>
            </div>
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="bill-customer-name">Customer name</Label>
                <Input
                  id="bill-customer-name"
                  value={billEditForm.customer_name}
                  onChange={(event) => setBillEditForm((form) => ({ ...form, customer_name: event.target.value }))}
                  className="h-11 rounded-xl"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="bill-phone">Phone</Label>
                <Input
                  id="bill-phone"
                  value={billEditForm.phone}
                  onChange={(event) => setBillEditForm((form) => ({ ...form, phone: event.target.value }))}
                  className="h-11 rounded-xl"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="bill-payment-method">Payment method</Label>
                <select
                  id="bill-payment-method"
                  value={billEditForm.payment_method}
                  onChange={(event) => setBillEditForm((form) => ({ ...form, payment_method: event.target.value }))}
                  className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm"
                >
                  <option value="cash">Cash</option>
                  <option value="upi">UPI</option>
                  <option value="card">Card</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="bill-discount">Discount</Label>
                <Input
                  id="bill-discount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={billEditForm.discount}
                  onChange={(event) => setBillEditForm((form) => ({ ...form, discount: event.target.value }))}
                  className="h-11 rounded-xl"
                />
              </div>
              <Button
                type="button"
                disabled={billActionLoading === `edit-${editingBill?.bill_id}`}
                onClick={saveBillEdit}
                className="h-12 w-full rounded-xl bg-[#a93107] font-black text-white hover:bg-[#862200]"
              >
                {billActionLoading === `edit-${editingBill?.bill_id}` ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : 'Save Bill'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default POSDashboard;
