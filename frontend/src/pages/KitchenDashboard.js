import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { toast } from 'sonner';
import api from '../lib/api';
import { useSocket } from '../contexts/SocketContext';
import { useAuth } from '../contexts/AuthContext';
import {
  CheckCircle2,
  ChefHat,
  ChevronDown,
  ChevronRight,
  Clock,
  Hash,
  ListChecks,
  LogOut,
  Printer,
  Sparkles,
  Timer,
  UtensilsCrossed,
  Volume2,
  VolumeX,
} from 'lucide-react';

const statusTone = {
  pending: {
    label: 'New Order',
    badge: 'bg-emerald-100 text-emerald-800',
    border: 'border-emerald-500',
    button: 'bg-emerald-600 hover:bg-emerald-700',
  },
  accepted: {
    label: 'Preparing',
    badge: 'bg-orange-100 text-orange-800',
    border: 'border-orange-500',
    button: 'bg-orange-500 hover:bg-orange-600',
  },
  prepared: {
    label: 'Ready',
    badge: 'bg-slate-200 text-slate-700',
    border: 'border-slate-300',
    button: '',
  },
};

const getItemCount = (order) => (order.items || []).reduce((total, item) => total + Number(item.quantity || 0), 0);

const formatOrderTime = (value) => {
  if (!value) return '';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const getKitchenOrderLabel = (order) => {
  const label = order?.table_label || order?.table_id || '';
  return label.replace(/^Takeaway\s+Takeaway\b/i, 'Takeaway');
};

const getItemCategory = (item) => {
  const explicitCategory = item.category_name || item.category || item.categoryName;
  if (explicitCategory) return explicitCategory;

  const name = (item.name || '').toLowerCase();
  if (name.includes('pizza')) return 'Pizzas';
  if (name.includes('drink') || name.includes('juice') || name.includes('coffee') || name.includes('tea')) return 'Drinks';
  if (name.includes('fries') || name.includes('side') || name.includes('garlic') || name.includes('bread')) return 'Sides';
  if (name.includes('dessert') || name.includes('cake') || name.includes('ice')) return 'Desserts';
  return 'Items';
};

const groupItemsByCategory = (items = []) => (
  items.reduce((groups, item, index) => {
    const category = getItemCategory(item);
    if (!groups[category]) groups[category] = [];
    groups[category].push({ ...item, itemIndex: index });
    return groups;
  }, {})
);

const KitchenOrderCard = memo(({
  order,
  meta,
  selected,
  onSelect,
}) => {
  const tone = statusTone[order.status] || statusTone.pending;

  return (
    <button
      type="button"
      onClick={() => onSelect(order.order_id)}
      className={`w-full rounded-xl border p-3 text-left transition-colors duration-150 ${
        selected
          ? 'border-emerald-600 bg-emerald-50 shadow-[0_8px_18px_rgba(22,163,74,0.12)]'
          : `bg-white shadow-sm hover:bg-slate-50 ${tone.border}`
      }`}
      data-testid={`order-card-${order.order_id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 gap-3">
          <div className="w-16 shrink-0 border-r border-slate-200 pr-3">
            <p className={`text-2xl font-black ${order.status === 'accepted' ? 'text-orange-600' : order.status === 'prepared' ? 'text-slate-700' : 'text-emerald-700'}`}>
              #{meta.queueToken || '-'}
            </p>
            <h3 className="mt-2 truncate text-base font-black text-slate-950">{meta.label}</h3>
            <p className="mt-1 text-sm font-medium text-slate-500">{meta.time}</p>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={`rounded-full ${tone.badge}`}>{tone.label}</Badge>
              {order.is_add_on && (
                <Badge className="rounded-full bg-emerald-100 text-emerald-800">
                  <Sparkles className="mr-1 h-3 w-3" />
                  Add-on Order
                </Badge>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2 text-sm font-black text-slate-950">
              <Timer className="h-4 w-4" />
              {meta.itemCount} Items
            </div>
            <div className="mt-1 space-y-0.5">
              {meta.firstItems.map((item, index) => (
                <div key={`${order.order_id}-preview-${index}`} className="truncate text-sm font-medium text-slate-950">
                  • {item.quantity}x {item.name}
                </div>
              ))}
              {meta.remainingItems > 0 && (
                <p className={`text-sm font-black ${order.status === 'accepted' ? 'text-orange-600' : 'text-emerald-700'}`}>+ {meta.remainingItems} more item{meta.remainingItems !== 1 ? 's' : ''}</p>
              )}
              {order.add_on_to_order_id && (
                <p className="inline-flex rounded-lg bg-emerald-100 px-2 py-1 text-xs font-black text-emerald-800">
                  Added to Order {order.add_on_to_order_id}
                </p>
              )}
            </div>
          </div>
        </div>
        <div className="w-32 shrink-0">
          <div className="text-right text-base font-black">
            <span className={order.status === 'accepted' ? 'text-orange-600' : order.status === 'prepared' ? 'text-slate-700' : 'text-emerald-700'}>{meta.progress.ready}/{meta.progress.total}</span>
            <span className="text-slate-500"> Ready</span>
          </div>
          <div className="mt-2 flex gap-1">
            {Array.from({ length: 5 }).map((_, index) => (
              <span
                key={index}
                className={`h-2 flex-1 rounded-full ${
                  index < Math.round(meta.progressPercent / 20)
                    ? order.status === 'accepted'
                      ? 'bg-orange-500'
                      : 'bg-emerald-500'
                    : 'bg-slate-200'
                }`}
              />
            ))}
          </div>
        </div>
      </div>
    </button>
  );
});

  const playKitchenAlert = () => {
  if (typeof window === 'undefined') return;

  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;

    const audioContext = new AudioContext();
    const playTone = (startTime, frequency, duration) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, startTime);
      gain.gain.setValueAtTime(0.001, startTime);
      gain.gain.exponentialRampToValueAtTime(0.35, startTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(startTime);
      oscillator.stop(startTime + duration + 0.02);
    };

    const now = audioContext.currentTime;
    playTone(now, 880, 0.18);
    playTone(now + 0.24, 1175, 0.22);
    setTimeout(() => audioContext.close().catch(() => {}), 800);
  } catch (error) {
    // Some browsers block audio before the first user interaction.
  }
};

  const KitchenDashboard = ({ embedded = false }) => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { socket, joinRoom } = useSocket();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);  
  const [selectedOrderId, setSelectedOrderId] = useState(null);
  const [checkedItems, setCheckedItems] = useState({});
  const [collapsedCategories, setCollapsedCategories] = useState({});
  const [soundEnabled, setSoundEnabled] = useState(true);
 

  useEffect(() => {
    fetchOrders();
  }, []);

  useEffect(() => {
    if (socket && user?.restaurant_id) {
      joinRoom(`restaurant_${user.restaurant_id}`);
    }
  }, [socket, user, joinRoom]);

  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

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

    socket.on('new_order', (newOrder) => {
      upsertOrder(newOrder);
      if (soundEnabled) playKitchenAlert();
      if (newOrder.is_add_on) {
        toast.warning(`Add-on order for ${getKitchenOrderLabel(newOrder)}`, {
          description: 'Previous table ticket is still in progress.',
        });
      } else {
        toast.success(`New order from ${getKitchenOrderLabel(newOrder)}`);
      }
    });

    socket.on('kitchen_notification', (notification) => {
      if (soundEnabled) playKitchenAlert();
      toast.warning(notification.message);
      if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('Kitchen Alert', {
          body: notification.message,
        });
      }
    });

    socket.on('order_status_updated', upsertOrder);
    socket.on('order_deleted', (payload) => {
      setOrders((prev) => prev.filter((order) => order.order_id !== payload.order_id));
    });

    return () => {
      socket.off('new_order');
      socket.off('kitchen_notification');
      socket.off('order_status_updated', upsertOrder);
      socket.off('order_deleted');
    };
  }, [socket, soundEnabled]);

  const fetchOrders = async () => {
    try {
      const response = await api.get(`/api/orders`, {
        withCredentials: true,
      });
      setOrders(response.data.filter((order) => !['served', 'cancelled'].includes(order.status)));
    } catch (error) {
      toast.error('Failed to load orders');
    } finally {
      setLoading(false);
    }
  };

  const updateStatus = async (orderId, status) => {
    try {
     const response = await api.put(
        `/api/orders/${orderId}/status`,
        { status }
      );
      setOrders((prev) => prev.map((order) => (
      order.order_id === orderId ? response.data : order
      )));
      toast.success(`Order marked as ${status}`);
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to update status');
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };
const toggleSound = () => {
    setSoundEnabled((current) => {
      const next = !current;
      if (next) {
        playKitchenAlert();
        toast.success('Kitchen notification sound enabled');
      } else {
        toast.info('Kitchen notification sound muted');
      }
      return next;
    });
  };
  const activeOrders = useMemo(() => (
    orders
      .filter((order) => !['served', 'cancelled'].includes(order.status))
      .sort((a, b) => {
        const aPrepared = a.status === 'prepared';
        const bPrepared = b.status === 'prepared';
        if (aPrepared !== bPrepared) return aPrepared ? 1 : -1;
        const statusRank = { pending: 0, accepted: 1, prepared: 2 };
        const rankDelta = (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3);
        if (rankDelta !== 0) return rankDelta;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      })
  ), [orders]);

  useEffect(() => {
    if (!activeOrders.length) {
      setSelectedOrderId(null);
      return;
    }
    if (!selectedOrderId || !activeOrders.some((order) => order.order_id === selectedOrderId)) {
      setSelectedOrderId(activeOrders[0].order_id);
    }
  }, [activeOrders, selectedOrderId]);

  const selectedOrder = useMemo(() => (
    activeOrders.find((order) => order.order_id === selectedOrderId) || activeOrders[0] || null
  ), [activeOrders, selectedOrderId]);

  const getOrderProgress = useCallback((order) => {
    if (!order) return { ready: 0, total: 0 };
    const total = getItemCount(order);
    const checkedForOrder = checkedItems[order.order_id] || {};
    const ready = (order.items || []).reduce((count, item, index) => (
      count + (checkedForOrder[index] ? Number(item.quantity || 0) : 0)
    ), 0);
    return { ready, total };
  }, [checkedItems]);

  const handleSelectOrder = useCallback((orderId) => {
    setSelectedOrderId(orderId);
  }, []);

  const toggleItemChecked = (orderId, itemIndex) => {
    setCheckedItems((prev) => ({
      ...prev,
      [orderId]: {
        ...(prev[orderId] || {}),
        [itemIndex]: !(prev[orderId] || {})[itemIndex],
      },
    }));
  };

  const toggleCategory = (orderId, category) => {
    const key = `${orderId}-${category}`;
    setCollapsedCategories((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const printOrder = (order) => {
    if (!order) return;
    const popup = window.open('', '_blank', 'width=900,height=720');
    if (!popup) {
      toast.error('Please allow popups to print.');
      return;
    }
    const itemsHtml = (order.items || []).map((item) => `
      <tr>
        <td>${item.quantity}x</td>
        <td>${item.name}${item.instructions ? `<div class="muted">${item.instructions}</div>` : ''}</td>
      </tr>
    `).join('');

    popup.document.write(`
      <html>
        <head>
          <title>${order.order_id}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; color: #111; }
            h1, p { margin: 0 0 10px; }
            table { width: 100%; border-collapse: collapse; margin-top: 14px; }
            td { border-bottom: 1px solid #ddd; padding: 8px; font-size: 16px; }
            td:first-child { width: 52px; font-weight: 700; }
            .muted { color: #555; font-size: 13px; margin-top: 4px; }
          </style>
        </head>
        <body>
          <h1>${getKitchenOrderLabel(order)}</h1>
          <p>${order.order_id} • ${formatOrderTime(order.created_at)}</p>
          ${order.is_add_on ? `<p>Add-on Order${order.add_on_to_order_id ? ` • Added to ${order.add_on_to_order_id}` : ''}</p>` : ''}
          <table>${itemsHtml}</table>
          <script>window.onload = () => window.print();</script>
        </body>
      </html>
    `);
    popup.document.close();
  };

  const groupedTables = useMemo(() => {
    const activeOrders = orders.filter((order) => !['served', 'cancelled'].includes(order.status));
    const tableGroups = activeOrders.reduce((groups, order) => {
      const key = order.table_id;
      if (!groups[key]) {
        groups[key] = {
          table_id: order.table_id,
          table_label: getKitchenOrderLabel(order) || `Table ${order.table_id}`,
          orders: [],
        };
      }
      groups[key].orders.push(order);
      return groups;
    }, {});



    return Object.values(tableGroups)
      .map((group) => {
        const sortedOrders = [...group.orders].sort((a, b) => {
          const aIsPrepared = a.status === 'prepared';
          const bIsPrepared = b.status === 'prepared';
          if (aIsPrepared !== bIsPrepared) return aIsPrepared ? 1 : -1;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });
        const earliestQueueTime = sortedOrders
          .filter((order) => ['pending', 'accepted'].includes(order.status))
          .map((order) => new Date(order.created_at).getTime())[0] ?? Number.MAX_SAFE_INTEGER;
        const counts = sortedOrders.reduce((acc, order) => {
          acc[order.status] = (acc[order.status] || 0) + 1;
          return acc;
        }, {});
        return {
          ...group,
          orders: sortedOrders,
          counts,
          earliestQueueTime,
          tablePriority: sortedOrders.some((order) => order.is_add_on && ['pending', 'accepted'].includes(order.status)),
        };
      })
      .sort((a, b) => {
        if (a.earliestQueueTime !== b.earliestQueueTime) return a.earliestQueueTime - b.earliestQueueTime;
        const oldestA = Math.min(...a.orders.map((order) => new Date(order.created_at).getTime()));
        const oldestB = Math.min(...b.orders.map((order) => new Date(order.created_at).getTime()));
        return oldestA - oldestB;
      });
  }, [orders]);
    const queueTokenMap = useMemo(() => {
    const queueOrders = orders
      .filter((order) => !['served', 'cancelled'].includes(order.status))
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    return queueOrders.reduce((tokens, order, index) => {
      tokens[order.order_id] = index + 1;
      return tokens;
    }, {});
  }, [orders]);

  const orderMetaMap = useMemo(() => (
    activeOrders.reduce((metaMap, order) => {
      const progress = getOrderProgress(order);
      const firstItems = (order.items || []).slice(0, 2);
      metaMap[order.order_id] = {
        queueToken: queueTokenMap[order.order_id],
        label: getKitchenOrderLabel(order),
        time: formatOrderTime(order.created_at),
        itemCount: getItemCount(order),
        firstItems,
        remainingItems: Math.max((order.items || []).length - firstItems.length, 0),
        progress,
        progressPercent: progress.total ? Math.min((progress.ready / progress.total) * 100, 100) : 0,
      };
      return metaMap;
    }, {})
  ), [activeOrders, checkedItems, getOrderProgress, queueTokenMap]);
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#F3F4F6' }}>
        <Clock className="h-10 w-10 animate-pulse text-primary" />
      </div>
    );
  }

  const selectedProgress = selectedOrder ? getOrderProgress(selectedOrder) : { ready: 0, total: 0 };
  const selectedCategories = selectedOrder ? groupItemsByCategory(selectedOrder.items || []) : {};
  const selectedCategoryEntries = Object.entries(selectedCategories);
  const selectedTone = selectedOrder ? (statusTone[selectedOrder.status] || statusTone.pending) : statusTone.pending;

  return (
    <div className="min-h-screen bg-[#F7F9FC] text-slate-950">
      <div className="sticky top-0 z-10 border-b border-emerald-100 bg-gradient-to-r from-emerald-50 via-teal-50 to-sky-50 text-slate-950 shadow-sm">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-4 px-5 py-4 sm:px-7 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4 min-w-0">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-600 text-white shadow-sm shadow-emerald-200">
              <ChefHat className="h-7 w-7" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">Kitchen Dashboard</h1>
              <p className="truncate text-sm font-medium text-slate-600">
                {user?.restaurant_name || 'Kitchen'} • {activeOrders.length} active order{activeOrders.length !== 1 ? 's' : ''}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={toggleSound}
              className={`h-11 rounded-2xl px-4 font-black shadow-sm ${
                soundEnabled
                  ? 'bg-emerald-600 text-white shadow-emerald-200 hover:bg-emerald-700'
                  : 'bg-white text-slate-700 shadow-slate-200 hover:bg-slate-50'
              }`}
              aria-pressed={soundEnabled}
            >
              {soundEnabled ? <Volume2 className="mr-2 h-4 w-4" /> : <VolumeX className="mr-2 h-4 w-4" />}
              Sound {soundEnabled ? 'On' : 'Off'}
            </Button>
            {!embedded && (
              <Button
                onClick={handleLogout}
                variant="outline"
                className="h-11 rounded-2xl border-emerald-200 bg-white text-slate-950 hover:bg-emerald-50"
                data-testid="logout-button"
              >
                <LogOut className="mr-2 h-4 w-4" />
                Logout
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="mx-auto grid max-w-[1600px] gap-0 lg:grid-cols-[46%,54%]">
        <aside className="min-h-[calc(100vh-73px)] space-y-4 border-r border-slate-200 bg-white p-5 sm:p-7">
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-lg font-black text-emerald-700">New</span>
                <span className="rounded-full bg-emerald-700 px-3 py-1 text-sm font-black text-white">{orders.filter((order) => order.status === 'pending').length}</span>
              </div>
              <div className="mt-3 h-1 rounded-full bg-emerald-500" />
            </div>
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-lg font-black text-orange-600">Preparing</span>
                <span className="rounded-full bg-orange-500 px-3 py-1 text-sm font-black text-white">{orders.filter((order) => order.status === 'accepted').length}</span>
              </div>
              <div className="mt-3 h-1 rounded-full bg-orange-500" />
            </div>
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-lg font-black text-slate-950">Ready</span>
                <span className="rounded-full bg-slate-600 px-3 py-1 text-sm font-black text-white">{orders.filter((order) => order.status === 'prepared').length}</span>
              </div>
              <div className="mt-3 h-1 rounded-full bg-slate-300" />
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Order Queue</p>
              <h2 className="text-xl font-black text-slate-950">{groupedTables.length} table queue</h2>
            </div>
            <UtensilsCrossed className="h-6 w-6 text-slate-400" />
          </div>

          {activeOrders.length === 0 && (
            <Card className="rounded-2xl border-slate-200 bg-white shadow-sm">
              <CardContent className="p-8 text-center text-slate-500">
                No active kitchen tickets right now.
              </CardContent>
            </Card>
          )}

          <div className="grid gap-3">
            {activeOrders.map((order) => {
              return (
                <KitchenOrderCard
                  key={order.order_id}
                  order={order}
                  meta={orderMetaMap[order.order_id]}
                  selected={selectedOrderId === order.order_id}
                  onSelect={handleSelectOrder}
                />
              );
            })}
          </div>
        </aside>

        <main className="min-h-[calc(100vh-73px)] bg-white">
          {selectedOrder ? (
            <div className="flex min-h-[calc(100vh-73px)] flex-col">
              <div className="border-b border-slate-200 p-4 sm:p-5">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {selectedOrder.is_add_on && (
                        <Badge className="rounded-lg bg-emerald-100 px-3 py-1 text-sm font-black text-emerald-800">ADD-ON ORDER</Badge>
                      )}
                      <button type="button" className="ml-auto rounded-full text-slate-950 lg:hidden">×</button>
                    </div>
                    <div className="mt-2 grid gap-4 lg:grid-cols-[minmax(220px,330px),minmax(280px,520px)] lg:items-start">
                      <div className="min-w-0">
                        <div className="flex min-h-[62px] w-full items-center rounded-xl border border-emerald-200 bg-emerald-50 px-4 shadow-sm shadow-emerald-100">
                          <span className="truncate text-2xl font-black tracking-wide text-emerald-700 sm:text-3xl">
                            ORDER #{queueTokenMap[selectedOrder.order_id] || '-'}
                          </span>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-lg font-medium text-slate-500">
                          <span>{getKitchenOrderLabel(selectedOrder)}</span>
                          <span>•</span>
                          <span>{formatOrderTime(selectedOrder.created_at)}</span>
                        </div>
                      </div>
                      <div className="min-h-[62px] rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                        <p className="flex items-baseline gap-2 text-2xl font-black text-emerald-700 sm:text-3xl">
                          <span>{selectedProgress.ready}/{selectedProgress.total}</span>
                          <span className="text-xl font-bold text-slate-500 sm:text-2xl">Ready</span>
                        </p>
                        <div className="mt-2 flex gap-1">
                          {Array.from({ length: 6 }).map((_, index) => (
                            <span
                              key={index}
                              className={`h-2 flex-1 rounded-full ${index < Math.round((selectedProgress.total ? selectedProgress.ready / selectedProgress.total : 0) * 6) ? 'bg-emerald-500' : 'bg-slate-200'}`}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Badge className={`rounded-full ${selectedTone.badge}`}>{selectedTone.label}</Badge>
                      {selectedOrder.is_add_on && (
                        <Badge className="rounded-full bg-emerald-100 text-emerald-800">Add-on Order</Badge>
                      )}
                      <span className="flex items-center gap-1 text-sm font-bold text-slate-500"><Hash className="h-4 w-4" />{selectedOrder.order_id}</span>
                      <span className="flex items-center gap-1 text-sm font-bold text-slate-500"><ListChecks className="h-4 w-4" />{getItemCount(selectedOrder)} items</span>
                    </div>
                    {selectedOrder.add_on_to_order_id && (
                      <p className="mt-5 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-lg font-black text-emerald-800">
                        <Sparkles className="h-6 w-6" />
                        Added to Order {selectedOrder.add_on_to_order_id}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div className={`flex-1 p-4 pb-24 sm:p-5 sm:pb-24 ${selectedCategoryEntries.length > 2 ? 'grid auto-rows-start gap-3 xl:grid-cols-2' : 'space-y-3'}`}>
                {selectedCategoryEntries.map(([category, items]) => {
                  const collapseKey = `${selectedOrder.order_id}-${category}`;
                  const collapsed = collapsedCategories[collapseKey];
                  return (
                    <section key={category} className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                      <button
                        type="button"
                        onClick={() => toggleCategory(selectedOrder.order_id, category)}
                        className="flex w-full items-center justify-between border-b border-slate-100 px-4 py-2.5 text-left transition-colors hover:bg-slate-50"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                            <UtensilsCrossed className="h-4 w-4" />
                          </div>
                          <h3 className="text-base font-black uppercase tracking-wide text-slate-950">{category} <span className="text-slate-500">({items.length})</span></h3>
                        </div>
                        {collapsed ? <ChevronRight className="h-5 w-5 text-slate-950" /> : <ChevronDown className="h-5 w-5 text-slate-950" />}
                      </button>

                      {!collapsed && (
                        <div className="divide-y divide-slate-200">
                          {items.map((item) => {
                            const checked = Boolean((checkedItems[selectedOrder.order_id] || {})[item.itemIndex]);
                            return (
                              <label
                                key={`${selectedOrder.order_id}-${item.itemIndex}`}
                                className={`flex cursor-pointer items-start gap-3 px-4 py-2.5 transition-all duration-150 ${
                                  checked
                                    ? 'border-l-4 border-emerald-500 bg-emerald-50 text-emerald-900'
                                    : 'text-slate-950 hover:bg-slate-50'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleItemChecked(selectedOrder.order_id, item.itemIndex)}
                                  className="mt-0.5 h-6 w-6 rounded-lg border-slate-300 accent-emerald-600"
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-3">
                                    <span className="text-lg font-medium text-slate-950">{item.quantity}x</span>
                                    <p className={`text-lg font-medium leading-tight ${checked ? 'text-slate-600 line-through opacity-70' : 'text-slate-950'}`}>
                                      {item.name}
                                    </p>
                                  </div>
                                  {item.instructions && (
                                    <p className={`mt-1 text-sm font-bold ${checked ? 'text-slate-500 line-through' : 'text-orange-600'}`}>
                                      {item.instructions}
                                    </p>
                                  )}
                                </div>
                                {checked && <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-emerald-600" />}
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>

              <div className="sticky bottom-0 border-t border-slate-200 bg-white/95 p-4 shadow-[0_-8px_24px_rgba(15,23,42,0.08)] backdrop-blur sm:px-7">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => printOrder(selectedOrder)}
                    className="h-14 rounded-lg border-slate-950 bg-white text-xl font-black text-slate-950 hover:bg-slate-50"
                  >
                    <Printer className="mr-2 h-5 w-5" />
                    Print
                  </Button>
                  {selectedOrder.status === 'pending' && (
                    <Button
                      onClick={() => updateStatus(selectedOrder.order_id, 'accepted')}
                      className={`h-14 rounded-lg text-xl font-black ${selectedTone.button}`}
                      data-testid={`accept-order-${selectedOrder.order_id}`}
                    >
                      Accept
                    </Button>
                  )}
                  {selectedOrder.status === 'accepted' && (
                    <Button
                      onClick={() => updateStatus(selectedOrder.order_id, 'prepared')}
                      className={`h-14 rounded-lg text-xl font-black ${selectedTone.button}`}
                      data-testid={`mark-prepared-${selectedOrder.order_id}`}
                    >
                      Mark Prepared
                    </Button>
                  )}
                  {selectedOrder.status === 'prepared' && (
                    <div className="flex h-14 items-center justify-center rounded-lg border border-slate-200 bg-slate-100 text-xl font-black text-slate-600">
                      Ready for billing
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex min-h-[420px] items-center justify-center p-8 text-center text-slate-500">
              <div>
                <ChefHat className="mx-auto h-12 w-12 text-slate-400" />
                <p className="mt-4 text-lg font-bold">No selected order</p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export default KitchenDashboard;
