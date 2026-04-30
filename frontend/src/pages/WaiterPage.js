import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, ClipboardList, Loader2, LogOut, Minus, Plus, Search, ShoppingBag, Store, UtensilsCrossed } from 'lucide-react';
import { toast } from 'sonner';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';
import { normalizeImageUrl } from '../lib/utils';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';

const formatCurrency = (value = 0) => `₹${Number(value || 0).toFixed(2)}`;

const createEmptyOrderDraft = () => ({
  orderType: 'dine_in',
  tableId: '',
  customerName: '',
  phone: '',
});

const WaiterDashboard = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { socket, joinRoom } = useSocket();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [restaurantProfile, setRestaurantProfile] = useState({ name: '' });
  const [tables, setTables] = useState([]);
  const [categories, setCategories] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [orders, setOrders] = useState([]);
  const [brokenImages, setBrokenImages] = useState({});
  const [draft, setDraft] = useState(createEmptyOrderDraft);
  const [cart, setCart] = useState([]);
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');

  useEffect(() => {
    const bootstrap = async () => {
      try {
        const [profileResponse, tablesResponse, categoriesResponse, itemsResponse, ordersResponse] = await Promise.all([
          api.get('/api/restaurant/profile', { withCredentials: true }),
          api.get('/api/tables', { withCredentials: true }),
          api.get('/api/menu/categories', { withCredentials: true }),
          api.get('/api/menu/items', { withCredentials: true }),
          api.get('/api/orders', { withCredentials: true }),
        ]);

        setRestaurantProfile({ name: profileResponse.data?.name || '' });
        setTables(tablesResponse.data || []);
        setCategories(categoriesResponse.data || []);
        setMenuItems((itemsResponse.data || []).filter((item) => item.available));
        setOrders(ordersResponse.data || []);
      } catch (error) {
        toast.error('Failed to load waiter dashboard');
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
          return prev.map((order) => (order.order_id === incomingOrder.order_id ? incomingOrder : order));
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

  const filteredItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    return menuItems.filter((item) => {
      const matchesCategory = selectedCategory === 'all' || item.category_id === selectedCategory;
      const matchesSearch = !term
        || item.name.toLowerCase().includes(term)
        || (item.description || '').toLowerCase().includes(term);
      return matchesCategory && matchesSearch;
    });
  }, [menuItems, search, selectedCategory]);

  const groupedItems = useMemo(() => {
    const grouped = categories
      .map((category) => ({
        ...category,
        items: filteredItems.filter((item) => item.category_id === category.category_id),
      }))
      .filter((category) => category.items.length > 0);
       const uncategorizedItems = filteredItems.filter((item) => (
      !categories.some((category) => category.category_id === item.category_id)
    ));

    if (uncategorizedItems.length > 0) {
      grouped.push({
        category_id: 'uncategorized',
        name: 'More Items',
        items: uncategorizedItems,
      });
    }

    if (grouped.length === 0 && filteredItems.length > 0) {
      return [{
        category_id: 'all-items',
        name: 'All Menu Items',
        items: filteredItems,
      }];
    }

    return grouped;
  }, [categories, filteredItems]);

  const activeOrders = useMemo(() => {
    return orders.filter((order) => !['served', 'cancelled'].includes(order.status));
  }, [orders]);

  const cartItemCount = useMemo(
    () => cart.reduce((sum, item) => sum + item.quantity, 0),
    [cart]
  );

  const cartTotal = useMemo(
    () => cart.reduce((sum, item) => sum + (item.price * item.quantity), 0),
    [cart]
  );

  const addItemToCart = (menuItem) => {
    setCart((prev) => {
      const existing = prev.find((item) => item.item_id === menuItem.item_id);
      if (existing) {
        return prev.map((item) => (
          item.item_id === menuItem.item_id
            ? { ...item, quantity: item.quantity + 1 }
            : item
        ));
      }

      return [
        ...prev,
        {
          item_id: menuItem.item_id,
          name: menuItem.name,
          price: menuItem.price,
          quantity: 1,
          instructions: '',
        },
      ];
    });
  };

  const updateCartItem = (itemId, changes) => {
    setCart((prev) => prev.map((item) => (
      item.item_id === itemId ? { ...item, ...changes } : item
    )));
  };

  const changeCartQuantity = (itemId, delta) => {
    setCart((prev) => prev
      .map((item) => (
        item.item_id === itemId
          ? { ...item, quantity: Math.max(0, item.quantity + delta) }
          : item
      ))
      .filter((item) => item.quantity > 0));
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const resetDraft = () => {
    setDraft(createEmptyOrderDraft());
    setCart([]);
  };

  const placeOrder = async () => {
    if (!draft.customerName.trim()) {
      toast.error('Please enter customer name');
      return;
    }
    if (draft.orderType === 'dine_in' && !draft.tableId) {
      toast.error('Please select a table');
      return;
    }
    if (cart.length === 0) {
      toast.error('Please add at least one item');
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/api/counter/orders', {
        order_type: draft.orderType,
        table_id: draft.orderType === 'dine_in' ? draft.tableId : null,
        customer_name: draft.customerName.trim(),
        phone: draft.phone.trim(),
        items: cart.map((item) => ({
          item_id: item.item_id,
          quantity: item.quantity,
          instructions: item.instructions?.trim() || '',
        })),
      }, { withCredentials: true });

      toast.success('Order placed successfully');
      resetDraft();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to place order');
    } finally {
      setSubmitting(false);
    }
  };

  const tableOptions = useMemo(
    () => tables.map((table) => ({
      value: table.table_id,
      label: `Table ${table.table_number}`,
    })),
    [tables]
  );

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#F7F4EF' }}>
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F7F4EF]">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-3 py-3 sm:px-4 sm:py-4 lg:px-6">
        <Card className="overflow-hidden rounded-[28px] border-white/80 bg-white/95 shadow-[0_16px_40px_rgba(15,23,42,0.08)]">
          <CardContent className="flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <UtensilsCrossed className="h-6 w-6" />
                </div>
                <div>
                  <h1 className="text-2xl font-black tracking-tight text-slate-900">Waiter Dashboard</h1>
                  <p className="text-sm text-slate-500">{restaurantProfile.name || user?.restaurant_name || 'Restaurant'}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge className="rounded-full bg-primary/10 px-3 py-1 text-primary hover:bg-primary/10">
                  <Store className="mr-1 h-3.5 w-3.5" />
                  {cartItemCount} item{cartItemCount === 1 ? '' : 's'} in cart
                </Badge>
                <Badge className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-700 hover:bg-emerald-50">
                  <ClipboardList className="mr-1 h-3.5 w-3.5" />
                  {activeOrders.length} active order{activeOrders.length === 1 ? '' : 's'}
                </Badge>
              </div>
            </div>

            <Button variant="outline" className="rounded-full" onClick={handleLogout}>
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </Button>
          </CardContent>
        </Card>

        <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)_360px]">
          <Card className="rounded-[26px] border-white/80 bg-white/95 shadow-[0_16px_40px_rgba(15,23,42,0.08)]">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg font-bold text-slate-900">Order Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Order Type</Label>
                <Select
                  value={draft.orderType}
                  onValueChange={(value) => setDraft((prev) => ({
                    ...prev,
                    orderType: value,
                    tableId: value === 'dine_in' ? prev.tableId : '',
                  }))}
                >
                  <SelectTrigger className="rounded-2xl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dine_in">Dine-In</SelectItem>
                    <SelectItem value="takeaway">Takeaway</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {draft.orderType === 'dine_in' && (
                <div className="space-y-2">
                  <Label>Select Table</Label>
                  <Select value={draft.tableId} onValueChange={(value) => setDraft((prev) => ({ ...prev, tableId: value }))}>
                    <SelectTrigger className="rounded-2xl">
                      <SelectValue placeholder="Choose a table" />
                    </SelectTrigger>
                    <SelectContent>
                      {tableOptions.map((table) => (
                        <SelectItem key={table.value} value={table.value}>
                          {table.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-2">
                <Label>Customer Name</Label>
                <Input
                  value={draft.customerName}
                  onChange={(event) => setDraft((prev) => ({ ...prev, customerName: event.target.value }))}
                  className="rounded-2xl"
                  placeholder="Enter customer name"
                />
              </div>

              <div className="space-y-2">
                <Label>Phone Number</Label>
                <Input
                  value={draft.phone}
                  onChange={(event) => setDraft((prev) => ({ ...prev, phone: event.target.value }))}
                  className="rounded-2xl"
                  placeholder="Optional phone number"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-3xl bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Cart Total</p>
                  <p className="mt-2 text-2xl font-black text-slate-900">{formatCurrency(cartTotal)}</p>
                </div>
                <div className="rounded-3xl bg-orange-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-orange-400">Active Orders</p>
                  <p className="mt-2 text-2xl font-black text-orange-600">{activeOrders.length}</p>
                </div>
              </div>

              <Button
                onClick={placeOrder}
                className="h-12 w-full rounded-2xl bg-primary text-base font-semibold hover:bg-[#C54E2C]"
                disabled={submitting}
              >
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Placing Order...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    Place Order
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card className="rounded-[26px] border-white/80 bg-white/95 shadow-[0_16px_40px_rgba(15,23,42,0.08)]">
              <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search menu items"
                    className="h-12 rounded-full border-slate-200 pl-11"
                  />
                </div>
                <Select value={selectedCategory} onValueChange={setSelectedCategory}>
                  <SelectTrigger className="h-12 rounded-full sm:w-[220px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {categories.map((category) => (
                      <SelectItem key={category.category_id} value={category.category_id}>
                        {category.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </CardContent>
            </Card>

            <div className="space-y-4">
              {groupedItems.map((category) => (
                <Card key={category.category_id} className="rounded-[26px] border-white/80 bg-white/95 shadow-[0_16px_40px_rgba(15,23,42,0.08)]">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-lg font-bold text-slate-900">{category.name}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-2 2xl:grid-cols-3">
                      {category.items.map((item) => {
                        const imageUrl = normalizeImageUrl(item.image);
                        const imageBroken = item.item_id ? brokenImages[item.item_id] : false;

                        return (
                          <div
                            key={item.item_id}
                            className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.06)]"
                          >
                            {imageUrl && !imageBroken && (
                              <div className="h-24 overflow-hidden border-b border-slate-100 bg-slate-50">
                                <img
                                  src={imageUrl}
                                  alt={item.name}
                                  className="h-full w-full object-cover"
                                  onError={() => setBrokenImages((prev) => ({ ...prev, [item.item_id]: true }))}
                                />
                              </div>
                            )}
                            <div className="space-y-3 p-4">
                              <div className="space-y-1">
                                <h3 className="text-base font-bold text-slate-900">{item.name}</h3>
                                <p className="line-clamp-2 min-h-[2.5rem] text-sm text-slate-500">
                                  {item.description || 'Freshly prepared for your guests.'}
                                </p>
                              </div>
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-xl font-black text-primary">{formatCurrency(item.price)}</span>
                                <Button
                                  onClick={() => addItemToCart(item)}
                                  className="h-10 rounded-full bg-primary px-4 font-semibold hover:bg-[#C54E2C]"
                                >
                                  <Plus className="mr-1 h-4 w-4" />
                                  Add
                                </Button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              ))}

              {groupedItems.length === 0 && (
                <Card className="rounded-[26px] border-dashed border-slate-300 bg-white/90">
                  <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                    <ShoppingBag className="h-10 w-10 text-slate-300" />
                    <div>
                      <p className="text-lg font-semibold text-slate-700">No menu items found</p>
                      <p className="text-sm text-slate-500">Try another search or category filter.</p>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>

          <Card className="rounded-[26px] border-white/80 bg-white/95 shadow-[0_16px_40px_rgba(15,23,42,0.08)]">
            <CardHeader className="border-b border-slate-100 pb-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-lg font-bold text-slate-900">Current Order</CardTitle>
                  <p className="text-sm text-slate-500">{cartItemCount} item{cartItemCount === 1 ? '' : 's'} selected</p>
                </div>
                {cart.length > 0 && (
                  <Button
                    variant="ghost"
                    className="rounded-full text-slate-500 hover:text-slate-900"
                    onClick={() => setCart([])}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </CardHeader>

            <CardContent className="flex max-h-[70vh] flex-col p-0">
              <div className="flex-1 space-y-3 overflow-y-auto p-4">
                {cart.length === 0 ? (
                  <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-3 rounded-[22px] border border-dashed border-slate-200 bg-slate-50 px-6 text-center">
                    <ShoppingBag className="h-9 w-9 text-slate-300" />
                    <div>
                      <p className="font-semibold text-slate-700">No items added yet</p>
                      <p className="text-sm text-slate-500">Tap menu items to build the order from the phone.</p>
                    </div>
                  </div>
                ) : (
                  cart.map((item) => (
                    <div key={item.item_id} className="rounded-[22px] border border-slate-200 bg-white p-4 shadow-[0_6px_24px_rgba(15,23,42,0.04)]">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-base font-bold text-slate-900">{item.name}</h3>
                          <p className="text-sm text-slate-500">{formatCurrency(item.price)} each</p>
                        </div>
                        <span className="text-base font-black text-primary">
                          {formatCurrency(item.price * item.quantity)}
                        </span>
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-3">
                        <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 p-1">
                          <button
                            type="button"
                            onClick={() => changeCartQuantity(item.item_id, -1)}
                            className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-slate-700 shadow-sm"
                          >
                            <Minus className="h-4 w-4" />
                          </button>
                          <span className="min-w-[2rem] text-center text-base font-bold text-slate-900">{item.quantity}</span>
                          <button
                            type="button"
                            onClick={() => changeCartQuantity(item.item_id, 1)}
                            className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-slate-700 shadow-sm"
                          >
                            <Plus className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                      <Textarea
                        value={item.instructions}
                        onChange={(event) => updateCartItem(item.item_id, { instructions: event.target.value })}
                        className="mt-3 min-h-[76px] rounded-2xl border-slate-200"
                        placeholder="Special instructions"
                      />
                    </div>
                  ))
                )}
              </div>

              <div className="border-t border-slate-100 bg-white p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-400">Total</span>
                  <span className="text-2xl font-black text-slate-900">{formatCurrency(cartTotal)}</span>
                </div>
                <Button
                  onClick={placeOrder}
                  className="h-12 w-full rounded-2xl bg-primary text-base font-semibold hover:bg-[#C54E2C]"
                  disabled={submitting || cart.length === 0}
                >
                  {submitting ? 'Placing Order...' : 'Confirm Order'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="rounded-[26px] border-white/80 bg-white/95 shadow-[0_16px_40px_rgba(15,23,42,0.08)]">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg font-bold text-slate-900">Live Order Queue</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {activeOrders.slice(0, 9).map((order) => (
                <div key={order.order_id} className="rounded-[22px] border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">
                        {order.table_label || order.table_id}
                      </p>
                      <p className="mt-1 text-base font-black text-slate-900">{order.customer_name}</p>
                    </div>
                    <Badge className="rounded-full bg-white text-slate-700 hover:bg-white">
                      {order.status}
                    </Badge>
                  </div>
                  <div className="mt-3 space-y-1">
                    {(order.items || []).slice(0, 3).map((item) => (
                      <p key={`${order.order_id}-${item.item_id}-${item.name}`} className="text-sm text-slate-600">
                        {item.quantity} x {item.name}
                      </p>
                    ))}
                  </div>
                  <p className="mt-3 text-lg font-black text-primary">{formatCurrency(order.total)}</p>
                </div>
              ))}

              {activeOrders.length === 0 && (
                <div className="col-span-full rounded-[22px] border border-dashed border-slate-300 bg-slate-50 px-6 py-10 text-center">
                  <p className="text-lg font-semibold text-slate-700">No active orders right now</p>
                  <p className="mt-1 text-sm text-slate-500">New dine-in and takeaway orders will appear here.</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default WaiterDashboard;
