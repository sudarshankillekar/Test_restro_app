import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, Minus, Plus, RefreshCw, Send, ShoppingBag, Trash2, UtensilsCrossed } from 'lucide-react';
import { toast } from 'sonner';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';
import OrderMenuItem from '../components/OrderMenuItem';
import { DIET_TYPES } from '../components/DietIndicator';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';

const money = value => `₹${Number(value || 0).toFixed(2)}`;
const emptyDraft = () => ({ items: [], name: '', phone: '', pending: null });
const statusLabel = { pending: 'Sent to kitchen', accepted: 'Preparing', prepared: 'Ready to serve', served: 'Served' };
const unpaid = order => order.status !== 'cancelled' && order.payment_status !== 'completed';

export default function WaiterPage() {
  const { user, logout } = useAuth();
  const { socket, connected } = useSocket();
  const navigate = useNavigate();
  const [tables, setTables] = useState([]);
  const [categories, setCategories] = useState([]);
  const [items, setItems] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState('');
  const storageKey = `waiter-drafts:${user?.restaurant_id}:${user?.user_id || user?.email}`;
  const [drafts, setDrafts] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem(storageKey) || '{}'); } catch { return {}; }
  });
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [diet, setDiet] = useState('all');
  const [view, setView] = useState('menu');
  const [cartOpen, setCartOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const sendLock = useRef(false);
  const requestLock = useRef(false);

  useEffect(() => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(drafts)); } catch { /* Storage may be unavailable. */ }
  }, [drafts, storageKey]);
  const refresh = useCallback(async () => {
    try {
      const [t, c, m, o] = await Promise.all([
        api.get('/api/tables'), api.get('/api/menu/categories'), api.get('/api/menu/items'), api.get('/api/orders'),
      ]);
      setTables(t.data || []); setCategories(c.data || []); setItems(m.data || []); setOrders(o.data || []); setError('');
    } catch { setError('Could not refresh orders. Check your connection and retry.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (connected && socket && user?.restaurant_id) {
      socket.emit('join_room', { room: `restaurant_${user.restaurant_id}` }); refresh();
    }
  }, [connected, socket, user?.restaurant_id, refresh]);
  useEffect(() => {
    const interval = window.setInterval(refresh, 30000);
    return () => window.clearInterval(interval);
  }, [refresh]);
  useEffect(() => {
    if (!socket) return undefined;
    const upsert = order => {
      if (!order?.order_id) return;
      setOrders(old => [order, ...old.filter(entry => entry.order_id !== order.order_id)]);
    };
    const remove = payload => setOrders(old => old.filter(entry => entry.order_id !== payload.order_id));
    socket.on('new_order', upsert); socket.on('order_status_updated', upsert); socket.on('order_deleted', remove);
    socket.on('payment_completed', refresh);
    return () => {
      socket.off('new_order', upsert); socket.off('order_status_updated', upsert); socket.off('order_deleted', remove);
      socket.off('payment_completed', refresh);
    };
  }, [socket, refresh]);

  const draft = drafts[selection] || emptyDraft();
  const locked = sending || Boolean(draft.pending);
  const selectedTable = tables.find(table => table.table_id === selection);
  const label = selection === 'takeaway' ? 'Takeaway' : selectedTable ? `Table ${selectedTable.table_number}` : 'Select a table';
  const count = draft.items.reduce((sum, item) => sum + item.quantity, 0);
  const total = draft.items.reduce((sum, item) => sum + item.quantity * item.price, 0);
  const tableOrders = orders.filter(order => unpaid(order) && (selection === 'takeaway' ? order.order_type === 'takeaway' : order.table_id === selection));
  const readyCount = orders.filter(order => unpaid(order) && order.status === 'prepared').length;
  const billRequested = tableOrders.some(order => order.bill_requested);
  const canRequest = selection !== 'takeaway' && tableOrders.length > 0 && tableOrders.every(order => ['prepared', 'served'].includes(order.status)) && !billRequested && count === 0;
  const visibleItems = useMemo(() => items.filter(item =>
    (category === 'all' || item.category_id === category) &&
    (diet === 'all' || (item.diet_type || 'veg') === diet) &&
    `${item.name} ${item.description || ''}`.toLowerCase().includes(search.trim().toLowerCase())
  ), [items, category, diet, search]);
  const editDraft = change => {
    if (!selection || locked) return;
    setDrafts(old => ({ ...old, [selection]: { ...(old[selection] || emptyDraft()), ...change } }));
  };
  const add = item => {
    if (!selection) { toast.error('Select a table or takeaway first'); return; }
    if (!item.available || locked) return;
    const exists = draft.items.some(entry => entry.item_id === item.item_id);
    editDraft({ items: exists ? draft.items.map(entry => entry.item_id === item.item_id ? { ...entry, quantity: entry.quantity + 1 } : entry)
      : [...draft.items, { item_id: item.item_id, name: item.name, price: item.price, quantity: 1, instructions: '' }] });
  };
  const quantity = (id, delta) => editDraft({ items: draft.items.map(item => item.item_id === id ? { ...item, quantity: item.quantity + delta } : item).filter(item => item.quantity > 0) });
  const send = async () => {
    if (sendLock.current || !selection || !draft.items.length) return;
    const key = selection;
    // Retain the exact token and payload after ambiguous failures, even across reloads.
    const payload = draft.pending || {
      submission_token: window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      order_type: key === 'takeaway' ? 'takeaway' : 'dine_in', table_id: key === 'takeaway' ? null : key,
      customer_name: draft.name.trim(), phone: draft.phone.trim(),
      items: draft.items.map(item => ({ item_id: item.item_id, quantity: item.quantity, instructions: item.instructions.trim() })),
    };
    sendLock.current = true; setSending(true);
    setDrafts(old => ({ ...old, [key]: { ...old[key], pending: payload } }));
    try {
      const result = await api.post('/api/counter/orders', payload);
      setOrders(old => [result.data, ...old.filter(order => order.order_id !== result.data.order_id)]);
      setDrafts(old => ({ ...old, [key]: emptyDraft() }));
      toast.success(`${label}: sent to kitchen`); setView('orders'); setCartOpen(false);
    } catch (err) {
      const status = err.response?.status;
      if (status && status >= 400 && status < 500 && status !== 408) {
        setDrafts(old => ({ ...old, [key]: { ...old[key], pending: null } }));
      }
      toast.error(err.response?.data?.detail || 'Confirmation not received. Retry this submission to check safely.');
    } finally { sendLock.current = false; setSending(false); }
  };
  const requestBill = async () => {
    if (!canRequest || requestLock.current) return;
    requestLock.current = true; setRequesting(true);
    try {
      await api.post(`/api/orders/${tableOrders[0].order_id}/request-bill`, {});
      toast.success('Bill requested from billing counter'); await refresh();
    } catch (err) { toast.error(err.response?.data?.detail || 'Could not request bill'); }
    finally { requestLock.current = false; setRequesting(false); }
  };

  const cart = <div className="flex min-h-0 flex-col">
    <div className="border-b p-4"><h2 className="text-lg font-semibold">{label}</h2><p className="text-sm text-gray-500">Unsent items ({count})</p></div>
    <div className="space-y-3 p-4">
      <Input aria-label="Customer name" placeholder="Customer name (optional)" value={draft.name} disabled={!selection || locked} onChange={event => editDraft({ name: event.target.value })} />
      <Input aria-label="Customer phone" type="tel" placeholder="Phone (optional)" value={draft.phone} disabled={!selection || locked} onChange={event => editDraft({ phone: event.target.value })} />
      {draft.pending && <p role="status" className="text-sm text-amber-800">Awaiting confirmation. Retry the same order before making changes.</p>}
      {!count && <div className="py-6 text-center text-gray-500"><ShoppingBag className="mx-auto mb-2 h-6 w-6" />No unsent items</div>}
      {draft.items.map(item => <div key={item.item_id} className="border-b pb-3">
        <div className="flex justify-between gap-2"><span className="min-w-0 break-words font-medium">{item.name}</span><span className="shrink-0">{money(item.price * item.quantity)}</span></div>
        <div className="my-2 flex items-center gap-2">
          <Button size="icon" variant="outline" className="h-11 w-11" title={`Remove one ${item.name}`} aria-label={`Remove one ${item.name}`} disabled={locked} onClick={() => quantity(item.item_id, -1)}><Minus className="h-4 w-4" /></Button>
          <span className="w-8 text-center">{item.quantity}</span>
          <Button size="icon" variant="outline" className="h-11 w-11" title={`Add one ${item.name}`} aria-label={`Increase ${item.name}`} disabled={locked} onClick={() => quantity(item.item_id, 1)}><Plus className="h-4 w-4" /></Button>
          <Button size="icon" variant="ghost" title={`Delete ${item.name}`} aria-label={`Delete ${item.name}`} disabled={locked} onClick={() => editDraft({ items: draft.items.filter(entry => entry.item_id !== item.item_id) })}><Trash2 className="h-4 w-4 text-red-600" /></Button>
        </div>
        <Input aria-label={`Instructions for ${item.name}`} placeholder="Item instructions" value={item.instructions} disabled={locked} onChange={event => editDraft({ items: draft.items.map(entry => entry.item_id === item.item_id ? { ...entry, instructions: event.target.value } : entry) })} />
      </div>)}
    </div>
    <div className="sticky bottom-0 mt-auto border-t bg-white p-4">
      <div className="mb-3 flex justify-between font-semibold"><span>Unsent total</span><span>{money(total)}</span></div>
      <Button className="h-12 w-full rounded-lg" onClick={send} disabled={sending || !selection || !count}><Send className="mr-2 h-4 w-4" />{sending ? 'Sending...' : draft.pending ? 'Retry submission' : 'Send to Kitchen'}</Button>
    </div>
  </div>;
  return <div className="min-h-screen bg-gray-50 text-gray-900" style={{ letterSpacing: 0 }}>
    <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b bg-white px-4 py-3">
      <div className="flex min-w-0 items-center gap-3"><UtensilsCrossed className="h-6 w-6 shrink-0 text-primary" /><div className="min-w-0"><h1 className="text-xl font-semibold">Waiter</h1><p className="truncate text-xs text-gray-500">{user?.restaurant_name} · {user?.name}</p></div></div>
      <div className="flex shrink-0 gap-2"><Button size="icon" variant="outline" title="Refresh orders" aria-label="Refresh orders" onClick={refresh}><RefreshCw className="h-4 w-4" /></Button><Button size="icon" variant="outline" title="Logout" aria-label="Logout" onClick={async () => { sessionStorage.removeItem(storageKey); await logout(); navigate('/login'); }}><LogOut className="h-4 w-4" /></Button></div>
    </header>
    {error && <div role="alert" className="bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    {!connected && <p role="status" className="border-b bg-amber-50 px-4 py-2 text-xs text-amber-900">Live updates disconnected. Checking orders every 30 seconds.</p>}
    <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px]">
      <main className="min-w-0 p-3 pb-28 sm:p-5 lg:pb-5">
        <div className="mb-4 flex flex-wrap gap-2" aria-label="Tables">
          {tables.map(table => <Button key={table.table_id} aria-pressed={selection === table.table_id} variant={selection === table.table_id ? 'default' : 'outline'} className="min-h-12 rounded-lg" disabled={sending} onClick={() => setSelection(table.table_id)}>
            Table {table.table_number}{orders.some(order => unpaid(order) && order.table_id === table.table_id) ? ' · Active' : ''}{drafts[table.table_id]?.items?.length ? ' · Draft' : ''}
            {orders.some(order => unpaid(order) && order.table_id === table.table_id && order.status === 'prepared') && <span aria-hidden="true" className="h-2 w-2 rounded-full bg-emerald-600" title="Ready to serve" />}
          </Button>)}
          <Button variant={selection === 'takeaway' ? 'default' : 'outline'} className="min-h-12 rounded-lg" disabled={sending} onClick={() => setSelection('takeaway')}>Takeaway</Button>
        </div>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">{label}</h2><div className="flex gap-1" role="tablist" aria-label="Order view">
          <Button role="tab" aria-selected={view === 'menu'} variant={view === 'menu' ? 'default' : 'outline'} onClick={() => setView('menu')}>Menu</Button>
          <Button role="tab" aria-selected={view === 'orders'} variant={view === 'orders' ? 'default' : 'outline'} onClick={() => setView('orders')}>Orders{readyCount ? ` · ${readyCount} ready` : ''}</Button>
        </div></div>
        {loading ? <p role="status">Loading menu...</p> : view === 'menu' ? <>
          <Input aria-label="Search items" placeholder="Search items" value={search} onChange={event => setSearch(event.target.value)} className="mb-3 h-12 bg-white" />
          <div className="mb-3 flex gap-2 overflow-x-auto pb-2" aria-label="Categories">
            <Button variant={category === 'all' ? 'default' : 'outline'} onClick={() => setCategory('all')}>All</Button>
            {categories.map(entry => <Button key={entry.category_id} className="shrink-0" variant={category === entry.category_id ? 'default' : 'outline'} onClick={() => setCategory(entry.category_id)}>{entry.name}</Button>)}
          </div>
          <div className="mb-4 flex flex-wrap gap-2" aria-label="Diet filters">{Object.entries(DIET_TYPES).map(([key, config]) => <Button key={key} aria-pressed={diet === key} variant="outline" className={diet === key ? config.activeClass : ''} onClick={() => setDiet(diet === key ? 'all' : key)}><span className={`mr-2 h-2 w-2 rounded-full ${config.dotClass}`} />{config.label}</Button>)}</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">{visibleItems.map(item => <OrderMenuItem key={item.item_id} item={item} quantity={draft.items.find(entry => entry.item_id === item.item_id)?.quantity || 0} onAdd={add} disabled={locked} />)}</div>
          {!visibleItems.length && <p className="py-10 text-center text-gray-500">No matching menu items</p>}
        </> : <section aria-label="Sent orders">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">Sent to kitchen</h3><Button variant="outline" disabled={!canRequest || requesting} onClick={requestBill}>{requesting ? 'Requesting...' : billRequested ? 'Bill requested' : 'Request Bill'}</Button></div>
          {!tableOrders.length && <p className="py-8 text-center text-gray-500">No unpaid orders for this selection</p>}
          {tableOrders.map(order => <article key={order.order_id} className="mb-3 rounded-lg border bg-white p-4">
            <div className="mb-3 flex flex-wrap justify-between gap-2"><span className="text-sm text-gray-500">{order.table_label || label}</span><span className={`text-sm font-semibold ${order.status === 'prepared' ? 'text-emerald-700' : 'text-gray-600'}`}>{statusLabel[order.status] || order.status}</span></div>
            {(order.items || []).filter(item => item.quantity > (item.cancelled_quantity || 0)).map((item, index) => <div key={`${item.item_id}-${index}`} className="mb-2"><p className="break-words">{item.quantity - (item.cancelled_quantity || 0)} × {item.name}</p>{item.instructions && <p className="text-sm text-gray-500">{item.instructions}</p>}</div>)}
            <p className="mt-3 text-sm text-gray-500">{order.is_add_on ? 'Add-on · ' : ''}{money(order.total)}</p>
          </article>)}
        </section>}
      </main>
      <aside className="hidden min-w-0 border-l bg-white lg:block"><div className="sticky top-20 max-h-[calc(100dvh-5rem)] overflow-y-auto">{cart}</div></aside>
    </div>
    <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-white p-3 lg:hidden"><Button className="h-12 w-full rounded-lg" onClick={() => setCartOpen(true)}><ShoppingBag className="mr-2 h-5 w-5" />{label} · {count} unsent · {money(total)}</Button></div>
    <Dialog open={cartOpen} onOpenChange={setCartOpen}><DialogContent className="max-h-[90dvh] overflow-y-auto p-0"><DialogHeader className="px-4 pt-4"><DialogTitle>Review Order</DialogTitle></DialogHeader>{cart}</DialogContent></Dialog>
  </div>;
}
