import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, CreditCard, DollarSign, Loader2, LogOut, Menu, Pencil, Plus, Printer, Receipt, Search, ShoppingCart, Trash2, Wallet, X } from 'lucide-react';
import { toast } from 'sonner';
import api from '../lib/api';
import { useSocket } from '../contexts/SocketContext';
import { useAuth } from '../contexts/AuthContext';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../components/ui/accordion';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';

const formatCurrency = (value = 0) => new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(Number(value || 0));

const createEmptyTransactionSummary = () => ({
  payment_summary: {
    cash: 0,
    upi: 0,
    card: 0,
    other: 0,
    total_collected: 0,
    payment_count: 0,
  },
  cash_adjustments: {
    total_adjustments: 0,
    entries: [],
  },
  cash_drawer: {
    opening_balance: 0,
    closing_balance: 0,
    cash_payments: 0,
    cash_adjustments: 0,
    cash_refunds: 0,
    net_cash_activity: 0,
    opening_source: 'previous_day',
    manual_opening_id: null,
    period_start: null,
    period_end: null,
  },
});

const formatPaymentMethod = (method) => {
  if (!method) return 'N/A';
  return method.toUpperCase();
};

const summarizeBillItems = (orders = []) => {
  const grouped = new Map();

  orders.forEach((order) => {
    (order.items || []).forEach((item) => {
      const key = `${item.item_id || item.name}-${item.price}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.quantity += item.quantity;
        existing.amount += item.quantity * item.price;
        return;
      }

      grouped.set(key, {
        item_id: item.item_id,
        name: item.name,
        quantity: item.quantity,
        amount: item.quantity * item.price,
      });
    });
  });

  return Array.from(grouped.values());
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
          .chip { display: inline-block; padding: 6px 12px; border-radius: 999px; background: #f1f5f9; margin-right: 8px; }
          @page { size: auto; margin: 4mm; }
          @media print {
            html, body { margin: 0; padding: 0; }
            body { width: 100%; max-width: 80mm; padding: 3mm; font-size: 12px; }
            h1 { font-size: 18px; }
            p { margin-bottom: 6px; }
            table { margin-top: 10px; }
            th, td { padding: 5px 2px; }
            th:nth-child(2), td:nth-child(2) { width: 32px; }
            th:nth-child(3), td:nth-child(3) { width: 66px; }
            .totals { width: 100%; margin-top: 12px; }
            .chip { padding: 3px 6px; margin-bottom: 4px; }
          }
        </style>
      </head>
      <body>
        ${html}
        <script>window.onload = () => window.print();</script>
      </body>
    </html>
  `);
  popup.document.close();
};

const BillingDashboard = ({ embedded = false }) => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { socket, joinRoom } = useSocket();

  const [orders, setOrders] = useState([]);
  const [tables, setTables] = useState([]);
  const [categories, setCategories] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [counterCatalogLoaded, setCounterCatalogLoaded] = useState(false);
  const [counterCatalogLoading, setCounterCatalogLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [paymentMethod, setPaymentMethod] = useState('');
  const [paymentMethodError, setPaymentMethodError] = useState('');
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);
  const completedPaymentKeysRef = useRef(new Set());
  const paymentInFlightRef = useRef(false);
  const [discount, setDiscount] = useState(0);
  const [editingOrder, setEditingOrder] = useState(null);
  const [editingItems, setEditingItems] = useState([]);
  const [restaurantProfile, setRestaurantProfile] = useState({
    name: '',
    gst_number: '',
    tax_enabled: true,
    tax_percentage: 5,
    service_charge_enabled: false,
    service_charge_percentage: 0,
    parcel_charge_enabled: false,
    parcel_charge: 0,
  });
  const [counterDialogOpen, setCounterDialogOpen] = useState(false);
  const [counterSubmitting, setCounterSubmitting] = useState(false);
  const [counterOrderType, setCounterOrderType] = useState('dine_in');
  const [counterTableId, setCounterTableId] = useState('');
  const [counterCustomerName, setCounterCustomerName] = useState('');
  const [counterPhone, setCounterPhone] = useState('');
  const [counterCart, setCounterCart] = useState([]);
  const [counterSearch, setCounterSearch] = useState('');
  const [counterCategory, setCounterCategory] = useState('all');
  const [transactionSummary, setTransactionSummary] = useState(createEmptyTransactionSummary);
  const [transactionPeriod, setTransactionPeriod] = useState('daily');
  const [completedBillRecords, setCompletedBillRecords] = useState([]);
  const [adjustmentAmount, setAdjustmentAmount] = useState('');
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [adjustmentSubmitting, setAdjustmentSubmitting] = useState(false);
  const [openingBalanceInput, setOpeningBalanceInput] = useState('');
  const [openingBalanceEditing, setOpeningBalanceEditing] = useState(false);
  const [openingBalanceSubmitting, setOpeningBalanceSubmitting] = useState(false);
  const [showAllCompletedBills, setShowAllCompletedBills] = useState(false);

  const refreshOrders = async () => {
    const response = await api.get('/api/orders', { withCredentials: true });
    setOrders(response.data);
  };

  const loadTransactionSummary = useCallback(async () => {
    try {
      const [response, completedBillsResponse] = await Promise.all([
        api.get(`/api/analytics/dashboard?period=${transactionPeriod}`, { withCredentials: true }),
        api.get(`/api/payments/completed?period=${transactionPeriod}`, { withCredentials: true }),
      ]);
      setTransactionSummary({
        payment_summary: {
          ...createEmptyTransactionSummary().payment_summary,
          ...(response.data?.payment_summary || {}),
        },
        cash_adjustments: {
          ...createEmptyTransactionSummary().cash_adjustments,
          ...(response.data?.cash_adjustments || {}),
        },
        cash_drawer: {
          ...createEmptyTransactionSummary().cash_drawer,
          ...(response.data?.cash_drawer || {}),
        },
      });
      setCompletedBillRecords(completedBillsResponse.data || []);
    } catch (error) {
      toast.error('Failed to load transaction summary');
    }
  }, [transactionPeriod]);

  const loadCounterCatalog = async () => {
    if (counterCatalogLoaded || counterCatalogLoading) return;

    setCounterCatalogLoading(true);
    try {
      const [itemsResponse, categoriesResponse] = await Promise.all([
        api.get('/api/menu/items', { withCredentials: true }),
        api.get('/api/menu/categories', { withCredentials: true }),
      ]);
      setMenuItems(itemsResponse.data.filter((item) => item.available));
      setCategories(categoriesResponse.data);
      setCounterCatalogLoaded(true);
    } catch (error) {
      toast.error('Failed to load counter menu');
    } finally {
      setCounterCatalogLoading(false);
    }
  };

  useEffect(() => {
    const bootstrap = async () => {
      try {
        const [ordersResponse, tablesResponse, profileResponse] = await Promise.all([
          api.get('/api/orders', { withCredentials: true }),
          api.get('/api/tables', { withCredentials: true }),
          api.get('/api/restaurant/profile', { withCredentials: true }),
        ]);

        setOrders(ordersResponse.data);
        setTables(tablesResponse.data);
        setRestaurantProfile({
          name: profileResponse.data.name || '',
          gst_number: profileResponse.data.gst_number || '',
          tax_enabled: profileResponse.data.tax_enabled ?? true,
          tax_percentage: profileResponse.data.tax_percentage ?? 5,
          service_charge_enabled: profileResponse.data.service_charge_enabled ?? false,
          service_charge_percentage: profileResponse.data.service_charge_percentage ?? 0,
          parcel_charge_enabled: profileResponse.data.parcel_charge_enabled ?? false,
          parcel_charge: profileResponse.data.parcel_charge ?? 0,
        });
      } catch (error) {
        toast.error('Failed to load billing dashboard');
      } finally {
        setLoading(false);
      }
    };

    bootstrap();
  }, []);

  useEffect(() => {
    loadTransactionSummary();
    setShowAllCompletedBills(false);
  }, [loadTransactionSummary]);

  useEffect(() => {
    if (counterDialogOpen) {
      loadCounterCatalog();
    }
  }, [counterDialogOpen]);

  useEffect(() => {
    if (socket && user?.restaurant_id) {
      joinRoom(`restaurant_${user.restaurant_id}`);
    }
  }, [socket, user, joinRoom]);

  useEffect(() => {
    if (!socket) return;

    const upsertOrder = (incomingOrder) => {
      setOrders((prev) => {
        const existing = prev.find((order) => order.order_id === incomingOrder.order_id);
        if (existing) {
          return prev.map((order) => order.order_id === incomingOrder.order_id ? incomingOrder : order);
        }
        return [incomingOrder, ...prev];
      });
    };

    socket.on('new_order', upsertOrder);
    socket.on('order_status_updated', upsertOrder);
    socket.on('order_deleted', (payload) => {
      setOrders((prev) => prev.filter((order) => order.order_id !== payload.order_id));
    });
    socket.on('cash_drawer_updated', loadTransactionSummary);

    return () => {
      socket.off('new_order', upsertOrder);
      socket.off('order_status_updated', upsertOrder);
      socket.off('order_deleted');
      socket.off('cash_drawer_updated', loadTransactionSummary);
    };
  }, [socket, loadTransactionSummary]);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const activeReadyGroups = useMemo(() => {
    const preparedOrders = orders.filter((order) => order.payment_status !== 'completed' && order.status === 'prepared');
    const grouped = preparedOrders.reduce((accumulator, order) => {
      const key = order.table_id;
      if (!accumulator[key]) {
        accumulator[key] = {
          table_id: order.table_id,
          table_label: order.table_label || `Table ${order.table_id}`,
          customer_name: order.customer_name,
          order_type: order.order_type || 'dine_in',
          orders: [],
        };
      }
      accumulator[key].orders.push(order);
      return accumulator;
    }, {});

    return Object.values(grouped).map((group) => ({
      ...group,
      orders: group.orders.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
    }));
  }, [orders]);

  const activeCounterOrders = useMemo(() => (
    orders
      .filter((order) => order.order_source === 'billing_counter' && order.payment_status !== 'completed')
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  ), [orders]);

  const completedBills = completedBillRecords;

  const currentSelectedGroup = useMemo(() => {
    if (!selectedGroup) return null;
    return activeReadyGroups.find((group) => group.table_id === selectedGroup.table_id) || selectedGroup;
  }, [activeReadyGroups, selectedGroup]);

  const calculateBill = (group) => {
    if (!group) {
      return { subtotal: 0, tax: 0, taxPercentage: 0, serviceCharge: 0, serviceChargePercentage: 0, parcelCharge: 0, discount: 0, total: 0 };
    }

    const subtotal = group.orders.reduce((sum, order) => sum + order.total, 0);
    const taxPercentage = restaurantProfile.tax_enabled ? Number(restaurantProfile.tax_percentage || 0) : 0;
    const serviceChargePercentage = restaurantProfile.service_charge_enabled && group.order_type !== 'takeaway'
      ? Number(restaurantProfile.service_charge_percentage || 0)
      : 0;
    const serviceCharge = subtotal * serviceChargePercentage / 100;
    const parcelCharge = group.order_type === 'takeaway' && restaurantProfile.parcel_charge_enabled
      ? Number(restaurantProfile.parcel_charge || 0)
      : 0;
    const taxableAmount = subtotal + serviceCharge + parcelCharge;
    const tax = taxableAmount * taxPercentage / 100;
    const discountAmount = Number(discount) || 0;
    return {
      subtotal,
      serviceCharge,
      serviceChargePercentage,
      parcelCharge,
      tax,
      taxPercentage,
      discount: discountAmount,
      total: Math.max(taxableAmount + tax - discountAmount, 0),
    };
  };

  const resetCounterForm = () => {
    setCounterOrderType('dine_in');
    setCounterTableId('');
    setCounterCustomerName('');
    setCounterPhone('');
    setCounterCart([]);
    setCounterSearch('');
    setCounterCategory('all');
  };

  const addCounterItem = (menuItem) => {
    setCounterCart((prev) => {
      const existing = prev.find((item) => item.item_id === menuItem.item_id);
      if (existing) {
        return prev.map((item) => item.item_id === menuItem.item_id ? { ...item, quantity: item.quantity + 1 } : item);
      }

      return [...prev, {
        item_id: menuItem.item_id,
        name: menuItem.name,
        price: menuItem.price,
        quantity: 1,
        instructions: '',
      }];
    });
  };

  const updateCounterQuantity = (itemId, nextQuantity) => {
    setCounterCart((prev) => (
      prev
        .map((item) => item.item_id === itemId ? { ...item, quantity: nextQuantity } : item)
        .filter((item) => item.quantity > 0)
    ));
  };

  const updateCounterInstructions = (itemId, instructions) => {
    setCounterCart((prev) => prev.map((item) => (
      item.item_id === itemId ? { ...item, instructions } : item
    )));
  };

  const printOrderTicket = (order) => {
    const restaurantName = restaurantProfile.name || user?.restaurant_name || 'Restaurant';
    const orderTypeLabel = order.order_type === 'takeaway' ? 'Takeaway' : 'Dine-In';
    const itemsHtml = (order.items || []).map((item) => `
      <tr>
        <td>${item.name}</td>
        <td>${item.quantity}</td>
        <td>Rs. ${(item.price * item.quantity).toFixed(2)}</td>
      </tr>
    `).join('');

    printHtml(`
      <div class="header">
        <h1>${restaurantName}</h1>
        <p class="muted">Order Ticket</p>
        <p>${order.order_id}</p>
      </div>
      <p><span class="chip">${orderTypeLabel}</span><span class="chip">${order.status.toUpperCase()}</span></p>
      <p>${order.table_label || order.table_id}</p>
      <p>Customer: ${order.customer_name}</p>
      <p>Phone: ${order.phone || 'N/A'}</p>
      <p>Created At: ${new Date(order.created_at || Date.now()).toLocaleString()}</p>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Qty</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>${itemsHtml}</tbody>
      </table>
      <div class="totals">
        <div class="strong"><span>Total</span><span>Rs. ${(order.total || 0).toFixed(2)}</span></div>
      </div>
    `, `${restaurantName} - ${order.order_id}`);
  };

  const printBill = (bill) => {
    const payment = bill.payment || {};
    const restaurantName = restaurantProfile.name || user?.restaurant_name || 'Restaurant';
    const gstNumber = restaurantProfile.gst_number?.trim();
    const summarizedItems = summarizeBillItems(bill.orders);
    const lineItemsTotal = summarizedItems.reduce((sum, item) => sum + item.amount, 0);
    const subtotal = Number(payment.subtotal ?? lineItemsTotal);
    const discount = Number(payment.discount || 0);
    const serviceCharge = Number(payment.service_charge || 0);
    const parcelCharge = Number(payment.parcel_charge || 0);
    const taxPercentage = Number(payment.tax_percentage ?? restaurantProfile.tax_percentage ?? 5);
    const fallbackTax = Number(((subtotal + serviceCharge + parcelCharge) * taxPercentage / 100).toFixed(2));
    const parsedTax = Number(payment.tax);
    const tax = Number.isFinite(parsedTax) && parsedTax > 0 ? parsedTax : fallbackTax;
    const recalculatedTotal = Number((subtotal + serviceCharge + parcelCharge + tax - discount).toFixed(2));
    const parsedTotal = Number(payment.total);
    const total = Number.isFinite(parsedTotal) && parsedTotal > subtotal - discount
      ? parsedTotal
      : recalculatedTotal; 
    const itemsHtml = summarizedItems.map((item) => `
      <tr>
        <td>${item.name}</td>
        <td>${item.quantity}</td>
        <td>Rs. ${item.amount.toFixed(2)}</td>
      </tr>
    `).join('');

    printHtml(`
      <div class="header">
        <h1>${restaurantName}</h1>
        <p class="muted">Restaurant Bill</p>
        ${gstNumber ? `<p>GST Number: ${gstNumber}</p>` : ''}
      </div>
      <p>Bill: ${bill.bill_id}</p>
      <p>${bill.table_label}</p>
      <p>Customer: ${bill.customer_name}</p>
      <p>Payment Method: ${formatPaymentMethod(payment.payment_method)}</p>
      <p>Printed At: ${new Date().toLocaleString()}</p>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Qty</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>${itemsHtml}</tbody>
      </table>
      <div class="totals">
        <div><span>Subtotal</span><span>Rs. ${subtotal.toFixed(2)}</span></div>
        ${serviceCharge > 0 ? `<div><span>Service Charge</span><span>Rs. ${serviceCharge.toFixed(2)}</span></div>` : ''}
        ${parcelCharge > 0 ? `<div><span>Parcel Charge</span><span>Rs. ${parcelCharge.toFixed(2)}</span></div>` : ''}
        <div><span>Tax (${taxPercentage.toFixed(2)}%)</span><span>Rs. ${tax.toFixed(2)}</span></div>
        <div><span>Discount</span><span>Rs. ${discount.toFixed(2)}</span></div>
        <div class="strong"><span>Total</span><span>Rs. ${total.toFixed(2)}</span></div>
      </div>
    `, `${restaurantName} - ${bill.bill_id}`);
  };

  const submitCounterOrder = async (shouldPrint = false) => {
    if (counterSubmitting) return;
    if (counterOrderType === 'dine_in' && !counterTableId) {
      toast.error('Please select a table for dine-in order.');
      return;
    }
    if (counterCart.length === 0) {
      toast.error('Please add at least one item.');
      return;
    }

    const orderTypeSnapshot = counterOrderType;
    const tableIdSnapshot = counterTableId;
    const customerNameSnapshot = counterCustomerName;
    const phoneSnapshot = counterPhone;
    const cartSnapshot = [...counterCart];
    const searchSnapshot = counterSearch;
    const categorySnapshot = counterCategory;
    const optimisticSubmit = !shouldPrint;

    setCounterSubmitting(true);
    if (optimisticSubmit) {
      setCounterDialogOpen(false);
      resetCounterForm();
    }

    try {
      const response = await api.post('/api/counter/orders', {
        order_type: orderTypeSnapshot,
        table_id: orderTypeSnapshot === 'dine_in' ? tableIdSnapshot : undefined,
        customer_name: customerNameSnapshot.trim(),
        phone: phoneSnapshot.trim(),
        items: cartSnapshot.map((item) => ({
          item_id: item.item_id,
          quantity: item.quantity,
          instructions: item.instructions || '',
        })),
      });

      setOrders((prev) => [response.data, ...prev.filter((order) => order.order_id !== response.data.order_id)]);
      if (!optimisticSubmit) {
        setCounterDialogOpen(false);
        resetCounterForm();
      }
      toast.success('Counter order created successfully.');
      if (shouldPrint) {
        printOrderTicket(response.data);
      }
    } catch (error) {
      if (optimisticSubmit) {
        setCounterOrderType(orderTypeSnapshot);
        setCounterTableId(tableIdSnapshot);
        setCounterCustomerName(customerNameSnapshot);
        setCounterPhone(phoneSnapshot);
        setCounterCart(cartSnapshot);
        setCounterSearch(searchSnapshot);
        setCounterCategory(categorySnapshot);
        setCounterDialogOpen(true);
      }
      toast.error(error.response?.data?.detail || 'Failed to create counter order');
    } finally {
      setCounterSubmitting(false);
    }
  };

  const processPayment = async () => {
    if (!currentSelectedGroup) return;
    if (!paymentMethod) {
      setPaymentMethodError('Please select a payment method before completing payment.');
      toast.error('Please select a payment method.');
      return;
    }

    const paymentKey = currentSelectedGroup.orders
      .map((order) => order.order_id)
      .sort()
      .join('|');

    if (paymentInFlightRef.current || completedPaymentKeysRef.current.has(paymentKey)) {
      toast.error('Bill generated already.');
      return;
    }

    paymentInFlightRef.current = true;
    setPaymentSubmitting(true);

    try {
      await api.post('/api/payments', {
        order_ids: currentSelectedGroup.orders.map((order) => order.order_id),
        payment_method: paymentMethod,
        discount: Number(discount) || 0,
      });

      completedPaymentKeysRef.current.add(paymentKey);
      await Promise.all([
        loadTransactionSummary(),
        refreshOrders(),
      ]);
      toast.success('Bill completed successfully.');
      setSelectedGroup(null);
      setPaymentMethod('');
      setPaymentMethodError('');
      setDiscount(0);
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Payment failed');
    } finally {
      paymentInFlightRef.current = false;
      setPaymentSubmitting(false);
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
    const availableCash = Math.max(Number(transactionSummary.cash_drawer?.closing_balance || 0), 0);
    if (parsedAmount < 0 && Math.abs(parsedAmount) > availableCash) {
      toast.error(`Cannot withdraw ${formatCurrency(Math.abs(parsedAmount))}; only ${formatCurrency(availableCash)} cash is available.`);
      return;
    }

    setAdjustmentSubmitting(true);
    try {
      await api.post('/api/cash-adjustments', {
        amount: parsedAmount,
        reason: adjustmentReason.trim(),
      }, { withCredentials: true });
      await loadTransactionSummary();
      setAdjustmentAmount('');
      setAdjustmentReason('');
      toast.success('Cash adjustment saved.');
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to save cash adjustment');
    } finally {
      setAdjustmentSubmitting(false);
    }
  };

  const openOpeningBalanceEditor = () => {
    setOpeningBalanceInput(String(Math.max(Number(transactionSummary.cash_drawer?.opening_balance || 0), 0)));
    setOpeningBalanceEditing(true);
  };

  const saveOpeningBalance = async () => {
    const parsedAmount = Number(openingBalanceInput);
    if (openingBalanceInput === '' || Number.isNaN(parsedAmount) || parsedAmount < 0) {
      toast.error('Please enter a valid opening balance.');
      return;
    }

    setOpeningBalanceSubmitting(true);
    try {
      await api.post('/api/cash-drawer/opening', {
        opening_balance: parsedAmount,
      }, { withCredentials: true });
      await loadTransactionSummary();
      setOpeningBalanceEditing(false);
      toast.success('Opening balance updated.');
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to update opening balance');
    } finally {
      setOpeningBalanceSubmitting(false);
    }
  };

  const openEditOrder = (order) => {
    setEditingOrder(order);
    setEditingItems(order.items.map((item) => ({ ...item })));
  };

  const updateEditingQuantity = (itemId, nextQuantity) => {
    if (nextQuantity <= 0) {
      setEditingItems((prev) => prev.filter((item) => item.item_id !== itemId));
      return;
    }

    setEditingItems((prev) => prev.map((item) => (
      item.item_id === itemId ? { ...item, quantity: nextQuantity } : item
    )));
  };

  const saveOrderChanges = async () => {
    if (!editingOrder) return;
    if (editingItems.length === 0) {
      toast.error('Please keep at least one item in the order.');
      return;
    }

    try {
      const response = await api.put(`/api/orders/${editingOrder.order_id}/items`, {
        items: editingItems.map((item) => ({
          item_id: item.item_id,
          quantity: item.quantity,
          instructions: item.instructions || '',
        })),
      });

      setOrders((prev) => prev.map((order) => (
        order.order_id === editingOrder.order_id ? response.data : order
      )));
      setEditingOrder(null);
      setEditingItems([]);
      toast.success('Order updated');
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to update order');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#F3F4F6' }}>
        <Wallet className="h-10 w-10 animate-pulse text-primary" />
      </div>
    );
  }

  const counterCartTotal = counterCart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const cartItemCount = counterCart.reduce((sum, item) => sum + item.quantity, 0);
  const menuItemMap = new Map(menuItems.map((item) => [item.item_id, item]));
  const filteredMenuItems = menuItems.filter((item) => {
    const matchesCategory = counterCategory === 'all' || item.category_id === counterCategory;
    const search = counterSearch.trim().toLowerCase();
    const matchesSearch = !search || item.name.toLowerCase().includes(search) || (item.description || '').toLowerCase().includes(search);
    return matchesCategory && matchesSearch;
  });
  const cartPreviewItems = counterCart
    .map((item) => {
      const menuItem = menuItemMap.get(item.item_id);
      return {
        ...item,
        category_id: menuItem?.category_id,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const selectedCategoryName = counterCategory === 'all'
    ? 'All Categories'
    : (categories.find((category) => category.category_id === counterCategory)?.name || 'Category');
  const paymentSummary = transactionSummary.payment_summary || createEmptyTransactionSummary().payment_summary;
  const cashAdjustments = transactionSummary.cash_adjustments || createEmptyTransactionSummary().cash_adjustments;
  const cashDrawer = transactionSummary.cash_drawer || createEmptyTransactionSummary().cash_drawer;
  const recentAdjustmentEntries = cashAdjustments.entries?.slice(0, 5) || [];
  const cashCollected = Math.max(Number(paymentSummary.cash || 0), 0);
  const openingBalance = Math.max(Number(cashDrawer.opening_balance || 0), 0);
  const closingBalance = Math.max(Number(cashDrawer.closing_balance || 0), 0);
  const dashboardStats = [
    {
      label: 'Ready To Bill',
      value: activeReadyGroups.length,
      icon: Receipt,
      valueClassName: 'text-blue-600',
      tintClassName: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Counter Orders',
      value: activeCounterOrders.length,
      icon: ShoppingCart,
      valueClassName: 'text-emerald-600',
      tintClassName: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Completed Bills',
      value: paymentSummary.payment_count ?? completedBills.length,
      icon: CreditCard,
      valueClassName: 'text-violet-600',
      tintClassName: 'bg-violet-50 text-violet-600',
    },
    {
      label: 'Cash Collected',
      value: formatCurrency(cashCollected),
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
  const visibleCompletedBills = showAllCompletedBills ? completedBills : completedBills.slice(0, 10);

  return (
    <div className="min-h-screen bg-[#f4f7fb]">
      <div className="border-b border-white/70 bg-white/90 shadow-[0_10px_40px_rgba(15,23,42,0.05)] backdrop-blur sticky top-0 z-10">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 py-4 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <Button variant="outline" size="icon" className="h-11 w-11 rounded-2xl border-slate-200 bg-white text-slate-600 shadow-sm">
              <Menu className="h-5 w-5" />
            </Button>
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-orange-50 text-primary shadow-sm">
              <Receipt className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl sm:text-[2rem] font-bold tracking-tight text-slate-900">Billing Counter</h1>
              <p className="text-sm text-slate-500">Welcome, {user?.name}</p>
              {user?.restaurant_name && (
                <div className="flex items-center gap-2 text-xs sm:text-sm text-slate-500 truncate">
                  <span className="truncate">{user.restaurant_name}</span>
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                </div>
              )}
            </div>
          </div>
          <div className="flex w-full min-w-0 flex-col gap-2 rounded-2xl border border-slate-100 bg-white/85 px-3 py-2 shadow-sm sm:w-auto sm:flex-row sm:items-center sm:gap-4">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
                <Wallet className="h-4 w-4" />
              </div>
              {openingBalanceEditing ? (
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 text-sm font-bold text-slate-700">Opening</span>
                  <Input
                    type="number"
                    min="0"
                    value={openingBalanceInput}
                    onChange={(event) => setOpeningBalanceInput(event.target.value)}
                    className="h-9 w-28 rounded-xl border-slate-200 text-sm"
                    aria-label="Opening balance"
                  />
                  <Button
                    type="button"
                    onClick={saveOpeningBalance}
                    disabled={openingBalanceSubmitting}
                    className="h-9 rounded-xl px-3 text-xs font-bold"
                  >
                    {openingBalanceSubmitting ? 'Saving' : 'Set'}
                  </Button>
                </div>
              ) : (
                <div className="flex min-w-0 items-baseline gap-3">
                  <span className="shrink-0 text-sm font-bold text-slate-700">Opening</span>
                  <span className="truncate text-base font-black text-emerald-600">{formatCurrency(openingBalance)}</span>
                  <button
                    type="button"
                    onClick={openOpeningBalanceEditor}
                    className="shrink-0 rounded-lg px-2 py-1 text-xs font-bold text-slate-500 hover:bg-slate-50 hover:text-slate-900"
                  >
                    Edit
                  </button>
                </div>
              )}
            </div>
            <div className="hidden h-9 w-px bg-slate-200 sm:block" />
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-600">
                <CreditCard className="h-4 w-4" />
              </div>
              <div className="flex min-w-0 items-baseline gap-3">
                <span className="shrink-0 text-sm font-bold text-slate-700">Closing (Expected)</span>
                <span className="truncate text-base font-black text-violet-600">{formatCurrency(closingBalance)}</span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 xl:justify-end">
            <Dialog open={counterDialogOpen} onOpenChange={(open) => {
              setCounterDialogOpen(open);
              if (!open) {
                resetCounterForm();
              }
            }}>
              <DialogTrigger asChild>
                <Button className="rounded-full bg-primary hover:bg-[#C54E2C]">
                  <Plus className="mr-2 h-4 w-4" />
                  Take Counter Order
                </Button>
              </DialogTrigger>
              <DialogContent className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col overflow-hidden rounded-none border-border bg-[#fbfcfe] p-0 sm:h-[92dvh] sm:max-h-[92dvh] sm:w-[calc(100vw-1rem)] sm:rounded-[24px]">
                <DialogHeader>
                  <div className="flex shrink-0 items-center gap-3 border-b border-border bg-white px-4 py-3 sm:px-6">
                    <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-orange-50 text-primary">
                      <Receipt className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <DialogTitle className="text-xl tracking-tight sm:text-2xl">Create Billing Counter Order</DialogTitle>
                      <p className="mt-0.5 text-sm text-muted-foreground sm:text-base">Fast order creation. Less clicks. More speed.</p>
                    </div>
                  </div>
                </DialogHeader>
                <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-y-auto md:grid-cols-[240px,minmax(0,1fr)] xl:grid-cols-[240px,minmax(0,1fr),290px] xl:overflow-hidden 2xl:grid-cols-[270px,minmax(0,1fr),310px]">
                  <div className="border-b border-border bg-white md:border-b-0 md:border-r">
                    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto px-4 py-4">
                      <div className="rounded-2xl border border-border bg-white p-3 shadow-sm">
                        <div className="mb-3 flex items-center gap-2">
                          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-600">1</span>
                          <h3 className="text-base font-bold">Order Type</h3>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <button
                            type="button"
                            onClick={() => setCounterOrderType('dine_in')}
                            className={`rounded-xl border p-3 text-center transition-colors ${counterOrderType === 'dine_in' ? 'border-primary bg-orange-50 text-primary shadow-sm' : 'border-border bg-white text-slate-800 hover:bg-slate-50'}`}
                          >
                            <ShoppingCart className="mx-auto h-6 w-6" />
                            <span className="mt-1.5 block font-bold">Dine-In</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setCounterOrderType('takeaway');
                              setCounterTableId('');
                            }}
                            className={`rounded-xl border p-3 text-center transition-colors ${counterOrderType === 'takeaway' ? 'border-primary bg-orange-50 text-primary shadow-sm' : 'border-border bg-white text-slate-800 hover:bg-slate-50'}`}
                          >
                            <Wallet className="mx-auto h-6 w-6" />
                            <span className="mt-1.5 block font-bold">Takeaway</span>
                          </button>
                        </div>
                      </div>

                      {counterOrderType === 'dine_in' && (
                        <div className="rounded-2xl border border-border bg-white p-3 shadow-sm">
                          <div className="mb-3 flex items-center gap-2">
                            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-600">2</span>
                            <h3 className="text-base font-bold">Select Table</h3>
                          </div>
                          <div className="grid grid-cols-4 gap-2">
                            {tables.slice(0, 12).map((table) => (
                              <button
                                key={table.table_id}
                                type="button"
                                onClick={() => setCounterTableId(table.table_id)}
                                className={`h-10 rounded-xl border text-sm font-bold transition-colors ${counterTableId === table.table_id ? 'border-primary bg-primary text-white shadow-sm' : 'border-border bg-white text-slate-900 hover:bg-slate-50'}`}
                              >
                                T{table.table_number}
                              </button>
                            ))}
                          </div>
                          {tables.length > 12 && (
                            <Select value={counterTableId} onValueChange={setCounterTableId}>
                              <SelectTrigger className="mt-3 rounded-xl">
                                <SelectValue placeholder="+ More Tables" />
                              </SelectTrigger>
                              <SelectContent>
                                {tables.map((table) => (
                                  <SelectItem key={table.table_id} value={table.table_id}>
                                    Table {table.table_number}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                      )}

                      <div className="rounded-2xl border border-border bg-white p-3 shadow-sm">
                        <div className="grid gap-3">
                          <div className="space-y-2">
                            <Label htmlFor="counter-customer-name">Customer Name (Optional)</Label>
                          <Input
                            id="counter-customer-name"
                            value={counterCustomerName}
                            onChange={(event) => setCounterCustomerName(event.target.value)}
                            placeholder="Enter customer name"
                            className="rounded-full"
                          />
                          </div>

                          <div className="space-y-2">
                            <Label htmlFor="counter-phone">Phone Number (Optional)</Label>
                          <Input
                            id="counter-phone"
                            value={counterPhone}
                            onChange={(event) => setCounterPhone(event.target.value)}
                            placeholder="Enter phone number"
                            className="rounded-full"
                          />
                          </div>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-border bg-white p-3 shadow-sm">
                        <h3 className="text-base font-bold">Selected</h3>
                        <div className="mt-3 space-y-2 text-sm">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-muted-foreground">Order Type</span>
                            <span className="font-bold text-primary">{counterOrderType === 'takeaway' ? 'Takeaway' : 'Dine-In'}</span>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-muted-foreground">Table</span>
                            <span className="font-bold text-primary">
                              {counterOrderType === 'takeaway'
                                ? 'Takeaway'
                                : (tables.find((table) => table.table_id === counterTableId)?.table_number ? `T${tables.find((table) => table.table_id === counterTableId)?.table_number}` : 'Not selected')}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-blue-100 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700">
                        Tip: Tap any item card to add instantly. Use + for repeat items.
                      </div>
                    </div>
                  </div>

                  <div className="flex min-h-0 flex-col bg-white xl:border-r">
                    <div className="shrink-0 space-y-3 border-b border-border px-4 py-3 sm:px-5">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <div className="relative flex-1">
                          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            value={counterSearch}
                            onChange={(event) => setCounterSearch(event.target.value)}
                            placeholder="Search items (e.g. Pizza, Burger, Coke...)"
                            className="h-11 rounded-xl pl-11 pr-11 text-base"
                          />
                          {counterSearch && (
                            <button
                              type="button"
                              className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground"
                              onClick={() => setCounterSearch('')}
                            >
                              <X className="h-4 w-4" />
                            </button>
                          )}
                        </div>

                        <Select value={counterCategory} onValueChange={setCounterCategory}>
                          <SelectTrigger className="h-11 w-full rounded-xl border-slate-200 bg-white sm:w-44">
                            <SelectValue placeholder="Filter" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">View by: All Categories</SelectItem>
                            {categories.map((category) => (
                              <SelectItem key={category.category_id} value={category.category_id}>
                                View by: {category.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="flex gap-2 overflow-x-auto pb-1">
                        <Button
                          type="button"
                          variant={counterCategory === 'all' ? 'default' : 'outline'}
                          className="shrink-0 rounded-xl px-6"
                          onClick={() => setCounterCategory('all')}
                        >
                          All
                        </Button>
                        {categories.slice(0, 6).map((category) => (
                          <Button
                            key={category.category_id}
                            type="button"
                            variant={counterCategory === category.category_id ? 'default' : 'outline'}
                            className="shrink-0 rounded-xl px-4"
                            onClick={() => setCounterCategory(category.category_id)}
                          >
                            {category.name}
                          </Button>
                        ))}
                      </div>

                      <p className="text-sm text-muted-foreground">
                        {filteredMenuItems.length} items {counterCategory !== 'all' ? `in ${selectedCategoryName}` : ''}
                      </p>
                    </div>

                    <div className="max-h-[68dvh] min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5 lg:max-h-[70dvh] 2xl:max-h-none">
                      {counterCatalogLoading ? (
                        <div className="rounded-[24px] border border-dashed border-border p-10 text-center">
                          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
                          <p className="mt-3 text-base font-medium">Loading menu</p>
                        </div>
                      ) : filteredMenuItems.length === 0 ? (
                        <div className="rounded-[24px] border border-dashed border-border p-10 text-center">
                          <p className="text-base font-medium">No menu items found</p>
                          <p className="mt-2 text-sm text-muted-foreground">
                            {counterCatalogLoaded ? 'Try a different search or switch the category filter.' : 'Open the counter again to retry loading menu items.'}
                          </p>
                        </div>
                      ) : (
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-4">
                          {filteredMenuItems.map((item) => {
                            const cartItem = counterCart.find((cartEntry) => cartEntry.item_id === item.item_id);
                            return (
                              <Card
                                key={item.item_id}
                                className={`overflow-hidden rounded-2xl border-border transition-colors ${cartItem ? 'border-primary/40 bg-[#FFF8F4]' : 'bg-white'}`}
                              >
                                <CardContent className="flex h-full flex-col p-3">
                                  <button type="button" className="min-w-0 text-left" onClick={() => addCounterItem(item)}>
                                    <p className="min-h-[2.6rem] overflow-hidden text-base font-semibold leading-snug text-slate-950">{item.name}</p>
                                  </button>

                                  <div className="mt-3 flex items-center justify-between gap-3">
                                    <span className="text-lg font-bold text-primary">{formatCurrency(item.price)}</span>
                                    {cartItem && (
                                      <Badge className="rounded-full bg-emerald-100 text-emerald-700">{cartItem.quantity}</Badge>
                                    )}
                                  </div>

                                  <Button
                                    type="button"
                                    onClick={() => addCounterItem(item)}
                                    variant="outline"
                                    className="mt-3 h-10 w-full rounded-xl border-orange-100 bg-orange-50 text-base font-bold text-primary hover:bg-orange-100"
                                  >
                                    <Plus className="mr-2 h-4 w-4" />
                                    Add
                                  </Button>
                                </CardContent>
                              </Card>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex min-h-0 flex-col overflow-hidden border-t border-border bg-white md:col-span-2 xl:col-span-1 xl:border-t-0">
                    <div className="shrink-0 border-b border-border px-4 py-3 sm:px-5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <ShoppingCart className="h-5 w-5" />
                          <h3 className="text-lg font-bold tracking-tight">Your Order ({cartItemCount})</h3>
                        </div>
                        {counterCart.length > 0 && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="rounded-xl border-red-100 text-red-600 hover:bg-red-50"
                            onClick={() => setCounterCart([])}
                          >
                            Clear All
                          </Button>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {cartItemCount} item{cartItemCount !== 1 ? 's' : ''} in cart
                      </p>
                    </div>

                    <div className="max-h-[42dvh] min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5 lg:max-h-[34dvh] xl:max-h-none">
                      <div className="space-y-4">
                        {counterCart.length === 0 && (
                          <div className="rounded-2xl border border-dashed border-border bg-white p-5 text-center">
                            <ShoppingCart className="mx-auto h-10 w-10 text-muted-foreground" />
                            <p className="mt-3 text-sm font-medium text-foreground">No items added yet</p>
                          <p className="text-sm text-muted-foreground">
                              Choose items from the center panel to start this counter order.
                          </p>
                          </div>
                        )}

                        {cartPreviewItems.map((item) => (
                          <div key={item.item_id} className="border-b border-border pb-4">
                            <div className="flex items-center gap-3">
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-base font-semibold">{item.name}</p>
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 rounded-full p-0 text-destructive"
                                onClick={() => updateCounterQuantity(item.item_id, 0)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>

                            <div className="mt-3 flex items-center gap-3">
                              <div className="flex items-center overflow-hidden rounded-xl border border-border bg-white">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-9 w-10 rounded-none p-0"
                                  onClick={() => updateCounterQuantity(item.item_id, item.quantity - 1)}
                                >
                                  -
                                </Button>
                                <div className="min-w-[2.5rem] border-x border-border text-center text-sm font-semibold">{item.quantity}</div>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-9 w-10 rounded-none p-0"
                                  onClick={() => updateCounterQuantity(item.item_id, item.quantity + 1)}
                                >
                                  +
                                </Button>
                              </div>
                              <div className="ml-auto text-lg font-bold text-primary">
                                {formatCurrency(item.quantity * item.price)}
                              </div>
                            </div>

                            <Textarea
                              value={item.instructions}
                              onChange={(event) => updateCounterInstructions(item.item_id, event.target.value)}
                              placeholder="Special instructions"
                              className="mt-3 min-h-[40px] rounded-xl text-sm"
                            />
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="sticky bottom-0 shrink-0 border-t border-border bg-white px-4 py-3 shadow-[0_-8px_24px_rgba(15,23,42,0.06)] sm:px-5">
                      <div className="mb-3 flex items-center justify-between text-lg font-bold">
                        <span>Total</span>
                        <span className="text-primary">{formatCurrency(counterCartTotal)}</span>
                      </div>
                      <Button
                        type="button"
                        disabled={counterSubmitting || counterCart.length === 0}
                        onClick={() => submitCounterOrder(false)}
                        className="h-12 w-full rounded-xl bg-primary text-base font-bold hover:bg-[#C54E2C]"
                      >
                        {counterSubmitting ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Ordering...
                          </>
                        ) : (
                          <>
                            Place Order
                            <span className="ml-2">→</span>
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              </DialogContent>
            </Dialog>

            {!embedded && (
              <Button
                onClick={handleLogout}
                variant="outline"
                className="rounded-2xl border-slate-200 bg-white px-4"
                data-testid="logout-button"
              >
                <LogOut className="w-4 h-4 mr-2" />
                Logout
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-[1440px] mx-auto p-4 sm:p-6 space-y-6">
        <div className="rounded-2xl border border-slate-100 bg-white/85 px-3 py-2 shadow-sm backdrop-blur">
          <div className="flex min-h-[58px] flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-bold text-slate-700">Transaction Summary</p>
            </div>
            <Select value={transactionPeriod} onValueChange={setTransactionPeriod}>
              <SelectTrigger className="h-10 w-full rounded-xl border-slate-200 bg-white sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-7">
          {dashboardStats.map((stat) => {
            const Icon = stat.icon;
            return (
              <Card key={stat.label} className="rounded-2xl border border-slate-100 bg-white/85 shadow-sm">
                <CardContent className="flex min-h-[58px] items-center gap-2 px-3 py-2">
                  <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${stat.tintClassName}`}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 sm:flex sm:items-baseline sm:gap-3">
                    <p className="truncate text-sm font-bold text-slate-700">{stat.label}</p>
                    <p className={`truncate text-base font-black leading-tight ${stat.valueClassName}`}>{stat.value}</p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="rounded-[28px] border border-white/70 bg-white/80 px-4 py-3 shadow-[0_12px_30px_rgba(15,23,42,0.04)] backdrop-blur">
          <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
            <span>Drawer balance uses cash only. UPI and card payments are excluded.</span>
            <span className="font-medium text-slate-700">Opening: {formatCurrency(openingBalance)}</span>
            <span className="font-medium text-slate-700">Base cash: {formatCurrency(paymentSummary.cash)}</span>
            <span className={Number(cashAdjustments.total_adjustments || 0) >= 0 ? 'font-medium text-emerald-600' : 'font-medium text-rose-600'}>
              Adjustment: {formatCurrency(cashAdjustments.total_adjustments)}
            </span>
            <span className="font-semibold text-slate-900">Closing: {formatCurrency(closingBalance)}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[320px,minmax(0,1fr)] xl:items-start">
          <div className="space-y-6">
            <Card className="rounded-[28px] border border-white/70 bg-white shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg text-slate-900">
                  <Receipt className="h-5 w-5 text-primary" />
                  Cash Adjustment
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="adjustment-amount" className="text-sm font-medium text-slate-700">Amount</Label>
                  <Input
                    id="adjustment-amount"
                    type="number"
                    value={adjustmentAmount}
                    onChange={(event) => setAdjustmentAmount(event.target.value)}
                    placeholder="Use - for deduction, + for addition"
                    className="h-11 rounded-xl border-slate-200"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="adjustment-reason" className="text-sm font-medium text-slate-700">Reason</Label>
                  <Textarea
                    id="adjustment-reason"
                    value={adjustmentReason}
                    onChange={(event) => setAdjustmentReason(event.target.value)}
                    placeholder="Explain the cash adjustment"
                    className="min-h-[104px] rounded-2xl border-slate-200 text-sm"
                  />
                </div>
                <Button
                  type="button"
                  onClick={createCashAdjustment}
                  disabled={adjustmentSubmitting}
                  className="w-full rounded-xl bg-primary py-6 text-base hover:bg-[#C54E2C]"
                >
                  {adjustmentSubmitting ? 'Saving...' : 'Save Adjustment'}
                </Button>
                <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">
                  This updates the cash drawer balance for the current restaurant day. Use a negative amount for cash-out or shortage, and a positive amount for cash-in correction.
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-[28px] border border-white/70 bg-white shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg text-slate-900">
                  <Receipt className="h-5 w-5 text-primary" />
                  Cash Adjustment History
                </CardTitle>
              </CardHeader>
              <CardContent>
                {recentAdjustmentEntries.length ? (
                  <div className="space-y-3">
                    {recentAdjustmentEntries.map((entry) => (
                      <div key={entry.adjustment_id} className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium text-slate-900">{entry.reason}</p>
                            <p className="mt-1 text-xs text-slate-500">{entry.created_by_name || 'Staff'}</p>
                            <p className="mt-1 text-xs text-slate-400">{new Date(entry.created_at).toLocaleString()}</p>
                          </div>
                          <p className={Number(entry.amount || 0) >= 0 ? 'text-sm font-semibold text-emerald-600' : 'text-sm font-semibold text-rose-600'}>
                            {formatCurrency(entry.amount)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">
                    No cash adjustments added yet.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <div className="space-y-4">
                <Card className="rounded-[28px] border border-white/70 bg-white shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-xl text-slate-900">
                      <Receipt className="h-5 w-5 text-blue-600" />
                      Ready To Bill
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                {activeReadyGroups.map((group) => {
                  const bill = calculateBill(group);
                  return (
                    <Card key={group.table_id} className="rounded-2xl border-slate-200 shadow-none">
                      <CardHeader>
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <CardTitle className="text-lg">{group.table_label}</CardTitle>
                            <p className="text-sm text-muted-foreground">{group.customer_name}</p>
                          </div>
                          <Badge className="rounded-full bg-emerald-100 text-emerald-700">
                            {group.order_type === 'takeaway' ? 'Takeaway' : 'Dine-In'}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <Accordion type="single" collapsible className="space-y-2">
                          {group.orders.map((order) => (
                            <AccordionItem
                              key={order.order_id}
                              value={order.order_id}
                              className="overflow-hidden rounded-xl border border-border bg-accent/60 px-0"
                            >
                              <div className="space-y-3 p-3">
                                <div className="flex flex-wrap gap-2">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-10 rounded-full px-4 text-sm font-semibold shadow-sm"
                                    onClick={() => openEditOrder(order)}
                                  >
                                    <Pencil className="mr-1 h-3.5 w-3.5" />
                                    Edit
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-10 rounded-full px-4 text-sm font-semibold shadow-sm"
                                    onClick={() => printOrderTicket(order)}
                                  >
                                    <Printer className="mr-1 h-3.5 w-3.5" />
                                    Print
                                  </Button>
                                  <AccordionTrigger className="h-10 flex-none rounded-full border border-input bg-background px-4 py-0 text-sm font-semibold text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground hover:no-underline [&>svg]:ml-2 [&>svg]:h-5 [&>svg]:w-5">
                                    Details
                                  </AccordionTrigger>
                                </div>
                                <div className="min-w-0 rounded-lg bg-white/70 px-3 py-2">
                                  <p className="break-all font-medium">{order.order_id}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {order.items.length} item{order.items.length > 1 ? 's' : ''} • {new Date(order.created_at).toLocaleString()}
                                  </p>
                                </div>
                              </div>
                              <AccordionContent className="px-3 pb-3 pt-0">
                                <div className="space-y-2">
                                  {(order.items || []).map((item, index) => (
                                    <div
                                      key={`${order.order_id}-bill-item-${index}`}
                                      className="flex items-center justify-between gap-3 rounded-lg bg-white px-3 py-2 text-sm"
                                    >
                                      <span className="min-w-0 truncate">
                                        {item.quantity}x {item.name}
                                      </span>
                                      <span className="shrink-0 font-medium">
                                        {formatCurrency(Number(item.price || 0) * Number(item.quantity || 0))}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </AccordionContent>
                            </AccordionItem>
                          ))}
                        </Accordion>

                        <div className="space-y-2 border-t pt-2">
                          <div className="flex justify-between">
                            <span>Subtotal</span>
                            <span>{formatCurrency(bill.subtotal)}</span>
                          </div>
                          {bill.serviceCharge > 0 && (
                            <div className="flex justify-between">
                              <span>Service Charge ({bill.serviceChargePercentage}%)</span>
                              <span>{formatCurrency(bill.serviceCharge)}</span>
                            </div>
                          )}
                          {bill.parcelCharge > 0 && (
                            <div className="flex justify-between">
                              <span>Parcel Charge</span>
                              <span>{formatCurrency(bill.parcelCharge)}</span>
                            </div>
                          )}
                          <div className="flex justify-between">
                            <span>Tax ({bill.taxPercentage}%)</span>
                            <span>{formatCurrency(bill.tax)}</span>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <Label htmlFor={`discount-${group.table_id}`}>Discount</Label>
                            <Input
                              id={`discount-${group.table_id}`}
                              type="number"
                              value={discount}
                              onChange={(event) => setDiscount(event.target.value)}
                              className="w-28 rounded-full"
                              placeholder="0"
                            />
                          </div>
                          <div className="flex justify-between border-t pt-2 text-lg font-bold">
                            <span>Total</span>
                            <span className="text-primary">{formatCurrency(bill.total)}</span>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <Label>Payment Method</Label>
                          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Payment Method" aria-invalid={Boolean(paymentMethodError)}>
                            {[
                              { value: 'cash', label: 'Cash' },
                              { value: 'upi', label: 'UPI' },
                              { value: 'card', label: 'Card' },
                            ].map((option) => (
                              <button
                                key={option.value}
                                type="button"
                                role="radio"
                                aria-checked={paymentMethod === option.value}
                                onClick={() => {
                                  setPaymentMethod(option.value);
                                  setPaymentMethodError('');
                                }}
                                className={`rounded-full border px-3 py-3 text-sm font-semibold transition-colors ${
                                  paymentMethod === option.value
                                    ? 'border-emerald-600 bg-emerald-50 text-emerald-700 shadow-sm'
                                    : 'border-border bg-white text-slate-700 hover:bg-slate-50'
                                }`}
                              >
                                <span className="mr-2 inline-flex h-3 w-3 rounded-full border border-current align-middle">
                                  {paymentMethod === option.value && (
                                    <span className="m-auto h-1.5 w-1.5 rounded-full bg-current" />
                                  )}
                                </span>
                                {option.label}
                              </button>
                            ))}
                          </div>
                          {paymentMethodError && (
                            <p className="text-sm font-medium text-destructive">{paymentMethodError}</p>
                          )}
                        </div>

                        <Dialog>
                          <DialogTrigger asChild>
                            <Button
                              onClick={(event) => {
                                if (!paymentMethod) {
                                  event.preventDefault();
                                  setPaymentMethodError('Please select a payment method before completing payment.');
                                  return;
                                }
                                setSelectedGroup(group);
                              }}
                              className="w-full rounded-full bg-success hover:bg-[#3E6648]"
                            >
                              <DollarSign className="mr-2 h-4 w-4" />
                              Complete Payment
                            </Button>
                          </DialogTrigger>
                          {selectedGroup?.table_id === group.table_id && (
                            <DialogContent className="rounded-2xl">
                              <DialogHeader>
                                <DialogTitle>Confirm Payment - {group.table_label}</DialogTitle>
                              </DialogHeader>
                              <div className="space-y-3 py-3">
                                <p className="text-sm text-muted-foreground">
                                  This will mark {currentSelectedGroup?.orders.length || group.orders.length} order(s) as paid and served.
                                </p>
                                <div className="rounded-xl border border-border p-4 space-y-2">
                                  <div className="flex justify-between">
                                    <span>Subtotal</span>
                                    <span>{formatCurrency(calculateBill(currentSelectedGroup || group).subtotal)}</span>
                                  </div>
                                  {calculateBill(currentSelectedGroup || group).serviceCharge > 0 && (
                                    <div className="flex justify-between">
                                      <span>Service Charge ({calculateBill(currentSelectedGroup || group).serviceChargePercentage}%)</span>
                                      <span>{formatCurrency(calculateBill(currentSelectedGroup || group).serviceCharge)}</span>
                                    </div>
                                  )}
                                  {calculateBill(currentSelectedGroup || group).parcelCharge > 0 && (
                                    <div className="flex justify-between">
                                      <span>Parcel Charge</span>
                                      <span>{formatCurrency(calculateBill(currentSelectedGroup || group).parcelCharge)}</span>
                                    </div>
                                  )}
                                  <div className="flex justify-between">
                                    <span>Tax ({calculateBill(currentSelectedGroup || group).taxPercentage}%)</span>
                                    <span>{formatCurrency(calculateBill(currentSelectedGroup || group).tax)}</span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span>Discount</span>
                                    <span>{formatCurrency(calculateBill(currentSelectedGroup || group).discount)}</span>
                                  </div>
                                  <div className="flex justify-between border-t pt-2 font-bold">
                                    <span>Total</span>
                                    <span className="text-primary">{formatCurrency(calculateBill(currentSelectedGroup || group).total)}</span>
                                  </div>
                                </div>
                                <Button
                                  onClick={processPayment}
                                  disabled={paymentSubmitting}
                                  className="w-full rounded-full bg-success hover:bg-[#3E6648]"
                                >
                                  {paymentSubmitting ? 'Generating Bill...' : 'Confirm Payment'}
                                </Button>
                              </div>
                            </DialogContent>
                          )}
                        </Dialog>
                      </CardContent>
                    </Card>
                  );
                })}
                {activeReadyGroups.length === 0 && (
                  <div className="rounded-[24px] border border-dashed border-blue-200 bg-blue-50/40 p-10 text-center text-slate-500">
                    <Receipt className="mx-auto h-7 w-7 text-blue-500" />
                    <div className="mt-3 text-base">
                      No prepared orders are waiting for payment.
                    </div>
                  </div>
                )}
                  </CardContent>
                </Card>
              </div>

              <div className="space-y-4">
                <Card className="rounded-[28px] border border-white/70 bg-white shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-xl text-slate-900">
                      <ShoppingCart className="h-5 w-5 text-emerald-600" />
                      Counter Orders
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                {activeCounterOrders.map((order) => (
                  <Card key={order.order_id} className="rounded-2xl border-border">
                    <CardHeader>
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <CardTitle className="text-lg">{order.table_label || order.order_id}</CardTitle>
                          <p className="text-sm text-muted-foreground">{order.customer_name}</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Badge className="rounded-full bg-accent text-foreground">
                            {order.order_type === 'takeaway' ? 'Takeaway' : 'Dine-In'}
                          </Badge>
                          <Badge className="rounded-full bg-slate-100 text-slate-700">
                            {order.status}
                          </Badge>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {(order.items || []).map((item, index) => (
                        <div key={`${order.order_id}-${index}`} className="flex items-center justify-between rounded-xl bg-accent/60 p-3 text-sm">
                          <span>{item.quantity}x {item.name}</span>
                          <span>{formatCurrency(item.quantity * item.price)}</span>
                        </div>
                      ))}
                      <div className="flex items-center justify-between border-t pt-3">
                        <span className="font-medium">Order Total</span>
                        <span className="font-bold text-primary">{formatCurrency(order.total)}</span>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          className="flex-1 rounded-full"
                          onClick={() => printOrderTicket(order)}
                        >
                          <Printer className="mr-2 h-4 w-4" />
                          Print Order
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="flex-1 rounded-full"
                          onClick={() => openEditOrder(order)}
                        >
                          <Pencil className="mr-2 h-4 w-4" />
                          Edit Order
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
                {activeCounterOrders.length === 0 && (
                  <div className="rounded-[24px] border border-dashed border-emerald-200 bg-emerald-50/40 p-10 text-center text-slate-500">
                    <ShoppingCart className="mx-auto h-7 w-7 text-emerald-500" />
                    <div className="mt-3 text-base">
                      No active counter orders yet.
                    </div>
                  </div>
                )}
                  </CardContent>
                </Card>
              </div>
            </div>

            <div className="space-y-4">
              <Card className="rounded-[28px] border border-white/70 bg-white shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                  <CardTitle className="flex items-center gap-2 text-xl text-slate-900">
                    <CreditCard className="h-5 w-5 text-violet-600" />
                    Completed Bills
                  </CardTitle>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-xl border-slate-200 text-slate-600"
                    disabled={completedBills.length <= 10}
                    onClick={() => setShowAllCompletedBills((current) => !current)}
                  >
                    {showAllCompletedBills ? 'Show Recent Bills' : 'View All Bills'}
                  </Button>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {visibleCompletedBills.map((bill) => (
              <Card key={bill.bill_id} className="rounded-2xl border-border bg-gray-50">
                <CardHeader>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <CardTitle className="text-lg">{bill.table_label}</CardTitle>
                      <p className="text-sm text-muted-foreground">{bill.customer_name}</p>
                    </div>
                    <Badge className="rounded-full bg-primary">Paid</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-sm text-muted-foreground">{bill.bill_id}</span>
                    <span className="font-semibold">{formatCurrency(bill.payment?.total || 0)}</span>
                  </div>
                  <div className="space-y-2">
                    {bill.orders.map((order) => (
                      <div key={order.order_id} className="rounded-xl border border-border bg-white p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="font-medium">{order.order_id}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="rounded-full"
                            onClick={() => printOrderTicket(order)}
                          >
                            <Printer className="h-4 w-4" />
                          </Button>
                        </div>
                        {(order.items || []).map((item, index) => (
                          <p key={`${order.order_id}-${index}`} className="text-sm text-muted-foreground">
                            {item.name} • {item.quantity} qty
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Payment Mode</span>
                    <span className="text-sm font-medium">{formatPaymentMethod(bill.payment?.payment_method)}</span>
                  </div>
                  <Button onClick={() => printBill(bill)} variant="outline" className="w-full rounded-full">
                    <Receipt className="mr-2 h-4 w-4" />
                    Print Bill
                  </Button>
                </CardContent>
              </Card>
            ))}
                    {completedBills.length === 0 && (
                      <div className="col-span-full rounded-[24px] border border-dashed border-violet-200 bg-violet-50/40 p-10 text-center text-slate-500">
                        <CreditCard className="mx-auto h-7 w-7 text-violet-500" />
                        <div className="mt-3 text-base">
                          No completed bills found for {transactionPeriod}.
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={Boolean(editingOrder)} onOpenChange={(open) => {
        if (!open) {
          setEditingOrder(null);
          setEditingItems([]);
        }
      }}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>Edit Order {editingOrder?.order_id}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] space-y-3 overflow-y-auto py-2">
            {editingItems.map((item) => (
              <div key={item.item_id} className="space-y-2 rounded-xl border border-border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{item.name}</p>
                    <p className="text-xs text-muted-foreground">{formatCurrency(item.price)} each</p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="rounded-full text-destructive"
                    onClick={() => updateEditingQuantity(item.item_id, 0)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => updateEditingQuantity(item.item_id, item.quantity - 1)}
                  >
                    -
                  </Button>
                  <div className="min-w-[3rem] text-center font-semibold">{item.quantity}</div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => updateEditingQuantity(item.item_id, item.quantity + 1)}
                  >
                    +
                  </Button>
                  <div className="ml-auto font-semibold text-primary">
                    {formatCurrency(item.quantity * item.price)}
                  </div>
                </div>
              </div>
            ))}
            <Button onClick={saveOrderChanges} className="w-full rounded-full bg-primary hover:bg-[#C54E2C]">
              Save Order Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default BillingDashboard;
