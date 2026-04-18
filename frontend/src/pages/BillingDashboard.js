import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, CreditCard, DollarSign, Loader2, LogOut, Pencil, Plus, Printer, Receipt, Search, ShoppingCart, Trash2, Wallet, X } from 'lucide-react';
import { toast } from 'sonner';
import api from '../lib/api';
import { useSocket } from '../contexts/SocketContext';
import { useAuth } from '../contexts/AuthContext';
import { normalizeImageUrl } from '../lib/utils';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';

const formatCurrency = (value = 0) => `₹${Number(value || 0).toFixed(2)}`;

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
          table { width: 100%; border-collapse: collapse; margin-top: 16px; }
          th, td { border-bottom: 1px solid #ddd; padding: 8px; text-align: left; }
          .totals { margin-top: 20px; width: 320px; margin-left: auto; }
          .totals div { display: flex; justify-content: space-between; margin-bottom: 8px; }
          .strong { font-weight: 700; }
          .header { border-bottom: 2px solid #111; padding-bottom: 12px; margin-bottom: 16px; }
          .muted { color: #555; }
          .chip { display: inline-block; padding: 6px 12px; border-radius: 999px; background: #f1f5f9; margin-right: 8px; }
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

const BillingDashboard = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { socket, joinRoom } = useSocket();

  const [orders, setOrders] = useState([]);
  const [tables, setTables] = useState([]);
  const [categories, setCategories] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [discount, setDiscount] = useState(0);
  const [editingOrder, setEditingOrder] = useState(null);
  const [editingItems, setEditingItems] = useState([]);
  const [restaurantProfile, setRestaurantProfile] = useState({ name: '', gst_number: '' });
  const [counterDialogOpen, setCounterDialogOpen] = useState(false);
  const [counterSubmitting, setCounterSubmitting] = useState(false);
  const [counterOrderType, setCounterOrderType] = useState('dine_in');
  const [counterTableId, setCounterTableId] = useState('');
  const [counterCustomerName, setCounterCustomerName] = useState('');
  const [counterPhone, setCounterPhone] = useState('');
  const [counterCart, setCounterCart] = useState([]);
  const [counterSearch, setCounterSearch] = useState('');
  const [counterCategory, setCounterCategory] = useState('all');

  useEffect(() => {
    const bootstrap = async () => {
      try {
        const [ordersResponse, tablesResponse, itemsResponse, categoriesResponse, profileResponse] = await Promise.all([
          api.get('/api/orders', { withCredentials: true }),
          api.get('/api/tables', { withCredentials: true }),
          api.get('/api/menu/items', { withCredentials: true }),
          api.get('/api/menu/categories', { withCredentials: true }),
          api.get('/api/restaurant/profile', { withCredentials: true }),
        ]);

        setOrders(ordersResponse.data);
        setTables(tablesResponse.data);
        setMenuItems(itemsResponse.data.filter((item) => item.available));
        setCategories(categoriesResponse.data);
        setRestaurantProfile({
          name: profileResponse.data.name || '',
          gst_number: profileResponse.data.gst_number || '',
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

    return () => {
      socket.off('new_order', upsertOrder);
      socket.off('order_status_updated', upsertOrder);
      socket.off('order_deleted');
    };
  }, [socket]);

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

  const completedBills = useMemo(() => {
    const completedOrders = orders.filter((order) => order.payment_status === 'completed' || order.status === 'served');
    const grouped = completedOrders.reduce((accumulator, order) => {
      const billKey = order.payment?.bill_id || order.payment?.payment_id || order.order_id;
      if (!accumulator[billKey]) {
        accumulator[billKey] = {
          bill_id: billKey,
          table_label: order.table_label || `Table ${order.table_id}`,
          customer_name: order.customer_name,
          payment: order.payment,
          orders: [],
        };
      }
      accumulator[billKey].orders.push(order);
      if (order.payment) {
        accumulator[billKey].payment = order.payment;
      }
      return accumulator;
    }, {});

    return Object.values(grouped).sort((a, b) => {
      const timeA = new Date(a.payment?.created_at || a.orders[0]?.updated_at || 0).getTime();
      const timeB = new Date(b.payment?.created_at || b.orders[0]?.updated_at || 0).getTime();
      return timeB - timeA;
    });
  }, [orders]);

  const currentSelectedGroup = useMemo(() => {
    if (!selectedGroup) return null;
    return activeReadyGroups.find((group) => group.table_id === selectedGroup.table_id) || selectedGroup;
  }, [activeReadyGroups, selectedGroup]);

  const calculateBill = (group) => {
    if (!group) {
      return { subtotal: 0, tax: 0, discount: 0, total: 0 };
    }

    const subtotal = group.orders.reduce((sum, order) => sum + order.total, 0);
    const tax = subtotal * 0.05;
    const discountAmount = Number(discount) || 0;
    return {
      subtotal,
      tax,
      discount: discountAmount,
      total: subtotal + tax - discountAmount,
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
    const subtotal = payment.subtotal ?? lineItemsTotal;
    const tax = payment.tax ?? subtotal * 0.05;
    const total = payment.total ?? (subtotal + tax - (payment.discount || 0));
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
        <div><span>Tax (5%)</span><span>Rs. ${tax.toFixed(2)}</span></div>
        <div><span>Discount</span><span>Rs. ${(payment.discount || 0).toFixed(2)}</span></div>
        <div class="strong"><span>Total</span><span>Rs. ${total.toFixed(2)}</span></div>
      </div>
    `, `${restaurantName} - ${bill.bill_id}`);
  };

  const submitCounterOrder = async (shouldPrint = false) => {
    if (!counterCustomerName.trim()) {
      toast.error('Please enter customer name.');
      return;
    }
    if (counterOrderType === 'dine_in' && !counterTableId) {
      toast.error('Please select a table for dine-in order.');
      return;
    }
    if (counterCart.length === 0) {
      toast.error('Please add at least one item.');
      return;
    }

    setCounterSubmitting(true);
    try {
      const response = await api.post('/api/counter/orders', {
        order_type: counterOrderType,
        table_id: counterOrderType === 'dine_in' ? counterTableId : undefined,
        customer_name: counterCustomerName.trim(),
        phone: counterPhone.trim(),
        items: counterCart.map((item) => ({
          item_id: item.item_id,
          quantity: item.quantity,
          instructions: item.instructions || '',
        })),
      });

      setOrders((prev) => [response.data, ...prev.filter((order) => order.order_id !== response.data.order_id)]);
      setCounterDialogOpen(false);
      resetCounterForm();
      toast.success('Counter order created successfully.');
      if (shouldPrint) {
        printOrderTicket(response.data);
      }
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to create counter order');
    } finally {
      setCounterSubmitting(false);
    }
  };

  const processPayment = async () => {
    if (!currentSelectedGroup) return;

    try {
      await api.post('/api/payments', {
        order_ids: currentSelectedGroup.orders.map((order) => order.order_id),
        payment_method: paymentMethod,
        discount: Number(discount) || 0,
      });

      toast.success('Bill completed successfully.');
      setSelectedGroup(null);
      setDiscount(0);
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Payment failed');
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

  return (
    <div className="min-h-screen" style={{ background: '#F3F4F6' }}>
      <div className="bg-white border-b border-border sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <CreditCard className="w-8 h-8 text-primary" />
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Billing Counter</h1>
              <p className="text-sm text-muted-foreground">Welcome, {user?.name}</p>
              {user?.restaurant_name && (
                <p className="text-xs sm:text-sm text-muted-foreground truncate">{user.restaurant_name}</p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
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
              <DialogContent className="flex h-[90vh] max-h-[90vh] max-w-[1180px] flex-col overflow-hidden rounded-[28px] border-border bg-white p-0">
                <DialogHeader>
                  <div className="border-b border-border px-6 py-5">
                    <DialogTitle className="text-2xl tracking-tight">Create Billing Counter Order</DialogTitle>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Search menu items fast, review the cart on the left, and place large orders without losing the action buttons.
                    </p>
                  </div>
                </DialogHeader>
                <div className="grid min-h-0 flex-1 gap-0 xl:grid-cols-[300px,minmax(0,1fr),310px]">
                  <div className="border-b border-border bg-white xl:border-b-0 xl:border-r">
                    <div className="flex h-full min-h-0 flex-col px-5 py-5">
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <Label>Order Type</Label>
                          <Select value={counterOrderType} onValueChange={(value) => {
                            setCounterOrderType(value);
                            if (value !== 'dine_in') {
                              setCounterTableId('');
                            }
                          }}>
                            <SelectTrigger className="rounded-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="dine_in">Dine-In</SelectItem>
                              <SelectItem value="takeaway">Takeaway</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        {counterOrderType === 'dine_in' && (
                          <div className="space-y-2">
                            <Label>Table</Label>
                            <div className="flex gap-2">
                              <Select value={counterTableId} onValueChange={setCounterTableId}>
                                <SelectTrigger className="rounded-full">
                                  <SelectValue placeholder="Choose a table" />
                                </SelectTrigger>
                                <SelectContent>
                                  {tables.map((table) => (
                                    <SelectItem key={table.table_id} value={table.table_id}>
                                      Table {table.table_number}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Button type="button" variant="outline" className="rounded-xl px-3">
                                <CalendarDays className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        )}

                        <div className="space-y-2">
                          <Label htmlFor="counter-customer-name">Customer Name</Label>
                          <Input
                            id="counter-customer-name"
                            value={counterCustomerName}
                            onChange={(event) => setCounterCustomerName(event.target.value)}
                            placeholder="Enter customer name"
                            className="rounded-full"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="counter-phone">Phone Number</Label>
                          <Input
                            id="counter-phone"
                            value={counterPhone}
                            onChange={(event) => setCounterPhone(event.target.value)}
                            placeholder="Enter phone number"
                            className="rounded-full"
                          />
                        </div>

                        <div className="rounded-[24px] border border-border bg-white p-4 shadow-sm">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <h3 className="text-lg font-semibold">Order Summary</h3>
                              <p className="text-sm text-muted-foreground">
                                {cartItemCount} item{cartItemCount !== 1 ? 's' : ''} in cart
                              </p>
                            </div>
                            {counterCart.length > 0 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="rounded-full text-muted-foreground"
                                onClick={() => setCounterCart([])}
                              >
                                Clear
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
                        <div className="space-y-3 pr-1">
                          {cartPreviewItems.slice(0, 2).map((item) => (
                            <div key={item.item_id} className="rounded-[24px] border border-border bg-white p-4 shadow-sm">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="truncate text-xl font-semibold">{item.name}</p>
                                  <p className="text-xs text-muted-foreground">{formatCurrency(item.price)} each</p>
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
                              <div className="mt-3 flex items-center gap-2">
                                <div className="flex items-center rounded-full border border-border bg-accent/60">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-9 w-9 rounded-full p-0"
                                    onClick={() => updateCounterQuantity(item.item_id, item.quantity - 1)}
                                  >
                                    -
                                  </Button>
                                  <div className="min-w-[2.5rem] text-center text-base font-semibold">{item.quantity}</div>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-9 w-9 rounded-full p-0"
                                    onClick={() => updateCounterQuantity(item.item_id, item.quantity + 1)}
                                  >
                                    +
                                  </Button>
                                </div>
                                <div className="ml-auto text-2xl font-bold text-primary">
                                  {formatCurrency(item.quantity * item.price)}
                                </div>
                              </div>
                              <Textarea
                                value={item.instructions}
                                onChange={(event) => updateCounterInstructions(item.item_id, event.target.value)}
                                placeholder="Special instructions"
                                className="mt-3 min-h-[48px] rounded-2xl text-sm"
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex min-h-0 flex-col bg-white xl:border-r">
                    <div className="shrink-0 space-y-4 border-b border-border px-5 py-5">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                          <h3 className="text-xl font-semibold">Available Menu Items</h3>
                          <p className="text-sm text-muted-foreground">
                            {filteredMenuItems.length} showing out of {menuItems.length} items
                          </p>
                        </div>
                        <Badge className="w-fit rounded-full bg-accent text-foreground">
                          {cartItemCount} items selected
                        </Badge>
                      </div>

                      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                        <div className="relative flex-1">
                          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            value={counterSearch}
                            onChange={(event) => setCounterSearch(event.target.value)}
                            placeholder="Search by item name or description"
                            className="rounded-full pl-11 pr-11"
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
                          <SelectTrigger className="w-full rounded-full border-primary/40 sm:w-[220px]">
                            <SelectValue placeholder={`View by: ${selectedCategoryName}`} />
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

                      {categories.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant={counterCategory === 'all' ? 'default' : 'outline'}
                            className="rounded-full"
                            onClick={() => setCounterCategory('all')}
                          >
                            All
                          </Button>
                          {categories.map((category) => (
                            <Button
                              key={category.category_id}
                              type="button"
                              variant={counterCategory === category.category_id ? 'default' : 'outline'}
                              className="rounded-full whitespace-nowrap"
                              onClick={() => setCounterCategory(category.category_id)}
                            >
                              {category.name}
                            </Button>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
                      {filteredMenuItems.length === 0 ? (
                        <div className="rounded-[24px] border border-dashed border-border p-10 text-center">
                          <p className="text-base font-medium">No menu items found</p>
                          <p className="mt-2 text-sm text-muted-foreground">
                            Try a different search or switch the category filter.
                          </p>
                        </div>
                      ) : (
                        <div className="grid gap-4 md:grid-cols-2">
                          {filteredMenuItems.map((item) => {
                            const cartItem = counterCart.find((cartEntry) => cartEntry.item_id === item.item_id);
                            return (
                              <Card
                                key={item.item_id}
                                className={`overflow-hidden rounded-[24px] border-border transition-colors ${cartItem ? 'border-primary/30 bg-[#FFF8F4]' : 'bg-white'}`}
                              >
                                <CardContent className="flex h-full flex-col p-4">
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="flex min-w-0 items-center gap-3">
                                      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-2xl bg-accent">
                                        {item.image && (
                                          <img
                                            src={normalizeImageUrl(item.image)}
                                            alt={item.name}
                                            className="h-full w-full object-cover"
                                            onError={(event) => {
                                              event.currentTarget.style.display = 'none';
                                            }}
                                          />
                                        )}
                                      </div>
                                      <div className="min-w-0">
                                        <p className="truncate text-lg font-semibold">{item.name}</p>
                                      </div>
                                    </div>
                                  </div>

                                  <div className="mt-4 flex items-center justify-between gap-3">
                                    <span className="text-xl font-bold text-primary">{formatCurrency(item.price)}</span>
                                    <div className="flex items-center gap-2 rounded-full border border-border bg-accent/60 px-1 py-1">
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 w-8 rounded-full p-0"
                                        onClick={() => updateCounterQuantity(item.item_id, Math.max((cartItem?.quantity || 0) - 1, 0))}
                                      >
                                        -
                                      </Button>
                                      <span className="min-w-[1.5rem] text-center font-semibold">{cartItem?.quantity || 0}</span>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 w-8 rounded-full p-0"
                                        onClick={() => cartItem ? updateCounterQuantity(item.item_id, cartItem.quantity + 1) : addCounterItem(item)}
                                      >
                                        +
                                      </Button>
                                    </div>
                                  </div>

                                  <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => addCounterItem(item)}
                                    className="mt-4 w-full rounded-xl border-border bg-white text-base font-medium hover:bg-accent"
                                  >
                                    Add to Order
                                  </Button>
                                </CardContent>
                              </Card>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex min-h-0 flex-col overflow-hidden bg-white">
                    <div className="shrink-0 border-b border-border px-5 py-5">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-2xl font-semibold tracking-tight">Order Summary</h3>
                          <p className="text-sm text-muted-foreground">
                            {cartItemCount} item{cartItemCount !== 1 ? 's' : ''} in cart
                          </p>
                        </div>
                        {counterCart.length > 0 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="rounded-full text-muted-foreground"
                            onClick={() => setCounterCart([])}
                          >
                            Clear
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                      <div className="space-y-3">
                        {counterCart.length === 0 && (
                          <div className="rounded-[24px] border border-dashed border-border bg-white p-6 text-center">
                            <ShoppingCart className="mx-auto h-10 w-10 text-muted-foreground" />
                            <p className="mt-3 text-sm font-medium text-foreground">No items added yet</p>
                            <p className="mt-1 text-sm text-muted-foreground">
                              Choose items from the center panel to start this counter order.
                            </p>
                          </div>
                        )}

                        {cartPreviewItems.map((item) => (
                          <div key={item.item_id} className="rounded-[24px] border border-border bg-white p-4 shadow-sm">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate text-xl font-semibold">{item.name}</p>
                                <p className="text-xs text-muted-foreground">{formatCurrency(item.price)} each</p>
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

                            <div className="mt-4 flex items-center gap-3">
                              <div className="flex items-center rounded-full border border-border bg-accent/60 px-1 py-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 w-8 rounded-full p-0"
                                  onClick={() => updateCounterQuantity(item.item_id, item.quantity - 1)}
                                >
                                  -
                                </Button>
                                <div className="min-w-[2.5rem] text-center text-base font-semibold">{item.quantity}</div>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 w-8 rounded-full p-0"
                                  onClick={() => updateCounterQuantity(item.item_id, item.quantity + 1)}
                                >
                                  +
                                </Button>
                              </div>
                              <div className="ml-auto text-2xl font-bold text-primary">
                                {formatCurrency(item.quantity * item.price)}
                              </div>
                            </div>

                            <Textarea
                              value={item.instructions}
                              onChange={(event) => updateCounterInstructions(item.item_id, event.target.value)}
                              placeholder="Special instructions"
                              className="mt-3 min-h-[52px] rounded-2xl text-sm"
                            />
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="sticky bottom-0 shrink-0 border-t border-border bg-white px-5 py-4 shadow-[0_-8px_24px_rgba(15,23,42,0.06)]">
                      <div className="mb-4 flex items-center justify-between text-lg font-bold">
                        <span>Total</span>
                        <span className="text-primary">{formatCurrency(counterCartTotal)}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <Button
                          type="button"
                          variant="outline"
                          disabled={counterSubmitting || counterCart.length === 0}
                          onClick={() => submitCounterOrder(true)}
                          className="rounded-xl py-6 text-base"
                        >
                          <Printer className="mr-2 h-4 w-4" />
                          Print
                        </Button>
                        <Button
                          type="button"
                          disabled={counterSubmitting || counterCart.length === 0}
                          onClick={() => submitCounterOrder(false)}
                          className="rounded-xl bg-[#2D8DA7] py-6 text-base hover:bg-[#24778d]"
                        >
                          {counterSubmitting ? (
                            <>
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              Ordering...
                            </>
                          ) : (
                            <>
                              <ShoppingCart className="mr-2 h-4 w-4" />
                              Order
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              </DialogContent>
            </Dialog>

            <Button
              onClick={handleLogout}
              variant="outline"
              className="rounded-full border-border"
              data-testid="logout-button"
            >
              <LogOut className="w-4 h-4 mr-2" />
              Logout
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
        <div className="grid gap-4 md:grid-cols-3">
          <Card className="rounded-2xl border-border">
            <CardContent className="p-5">
              <p className="text-sm text-muted-foreground">Ready To Bill</p>
              <p className="mt-2 text-3xl font-bold">{activeReadyGroups.length}</p>
            </CardContent>
          </Card>
          <Card className="rounded-2xl border-border">
            <CardContent className="p-5">
              <p className="text-sm text-muted-foreground">Counter Orders</p>
              <p className="mt-2 text-3xl font-bold">{activeCounterOrders.length}</p>
            </CardContent>
          </Card>
          <Card className="rounded-2xl border-border">
            <CardContent className="p-5">
              <p className="text-sm text-muted-foreground">Completed Bills</p>
              <p className="mt-2 text-3xl font-bold">{completedBills.length}</p>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Ready To Bill</h2>
            {activeReadyGroups.map((group) => {
              const bill = calculateBill(group);
              return (
                <Card key={group.table_id} className="rounded-2xl border-border">
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
                    {group.orders.map((order) => (
                      <div key={order.order_id} className="rounded-xl border border-border bg-accent/60 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="font-medium">{order.order_id}</p>
                            <p className="text-xs text-muted-foreground">
                              {order.items.length} item{order.items.length > 1 ? 's' : ''} • {new Date(order.created_at).toLocaleString()}
                            </p>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="rounded-full"
                              onClick={() => openEditOrder(order)}
                            >
                              <Pencil className="mr-1 h-3.5 w-3.5" />
                              Edit
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="rounded-full"
                              onClick={() => printOrderTicket(order)}
                            >
                              <Printer className="mr-1 h-3.5 w-3.5" />
                              Print
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}

                    <div className="space-y-2 border-t pt-2">
                      <div className="flex justify-between">
                        <span>Subtotal</span>
                        <span>{formatCurrency(bill.subtotal)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Tax (5%)</span>
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
                      <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                        <SelectTrigger className="rounded-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="cash">Cash</SelectItem>
                          <SelectItem value="upi">UPI</SelectItem>
                          <SelectItem value="card">Card</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <Dialog>
                      <DialogTrigger asChild>
                        <Button
                          onClick={() => setSelectedGroup(group)}
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
                              <div className="flex justify-between">
                                <span>Tax</span>
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
                            <Button onClick={processPayment} className="w-full rounded-full bg-success hover:bg-[#3E6648]">
                              Confirm Payment
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
              <Card className="rounded-2xl border-border">
                <CardContent className="p-10 text-center text-muted-foreground">
                  No prepared orders are waiting for payment.
                </CardContent>
              </Card>
            )}
          </div>

          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Counter Orders</h2>
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
              <Card className="rounded-2xl border-border">
                <CardContent className="p-10 text-center text-muted-foreground">
                  No active counter orders yet.
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Completed Bills</h2>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {completedBills.slice(0, 10).map((bill) => (
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
