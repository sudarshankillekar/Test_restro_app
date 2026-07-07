import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { toast } from 'sonner';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';
import {
  CheckCircle2,
  ChefHat,
  Clock,
  LogOut,
  Printer,
  RefreshCw,
  Volume2,
  VolumeX,
} from 'lucide-react';

const statusTone = {
  pending: {
    label: 'New',
    title: 'text-emerald-700',
    badge: 'bg-emerald-100 text-emerald-800',
    border: 'border-l-emerald-600',
    bar: 'bg-emerald-600',
    action: 'bg-emerald-600 hover:bg-emerald-700',
  },
  accepted: {
    label: 'Preparing',
    title: 'text-orange-600',
    badge: 'bg-orange-100 text-orange-800',
    border: 'border-l-orange-500',
    bar: 'bg-orange-500',
    action: 'bg-orange-500 hover:bg-orange-600',
  },
  prepared: {
    label: 'Ready',
    title: 'text-blue-600',
    badge: 'bg-blue-100 text-blue-800',
    border: 'border-l-blue-600',
    bar: 'bg-blue-600',
    action: 'bg-blue-600 hover:bg-blue-700',
  },
};

const activeStatuses = ['pending', 'accepted', 'prepared'];

const escapeHtml = (value = '') => (
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
);

const getItemCount = (order) => (
  (order.items || []).reduce((total, item) => total + Number(item.quantity || 0), 0)
);

const getKitchenOrderLabel = (order) => {
  const label = order?.table_label || order?.table_id || '';
  return label.replace(/^Takeaway\s+Takeaway\b/i, 'Takeaway');
};

const formatOrderTime = (value) => {
  if (!value) return '';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const formatElapsed = (value, now) => {
  if (!value) return 'New';
  const startedAt = new Date(value).getTime();
  if (!Number.isFinite(startedAt)) return 'New';
  const minutes = Math.max(0, Math.floor((now - startedAt) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
};

const hasExplicitReadyState = (items = []) => (
  items.some((item) => Object.prototype.hasOwnProperty.call(item, 'ready'))
);

const isItemReady = (order, item) => {
  if (Object.prototype.hasOwnProperty.call(item, 'ready')) return Boolean(item.ready);
  return order.status === 'prepared';
};

const getReadyCount = (order) => {
  const items = order.items || [];
  const total = getItemCount(order);
  if (order.status === 'prepared' && !hasExplicitReadyState(items)) return total;
  return items.reduce((ready, item) => (
    ready + (isItemReady(order, item) ? Number(item.quantity || 0) : 0)
  ), 0);
};

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
      gain.gain.exponentialRampToValueAtTime(0.32, startTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(startTime);
      oscillator.stop(startTime + duration + 0.02);
    };

    const now = audioContext.currentTime;
    playTone(now, 880, 0.16);
    playTone(now + 0.22, 1175, 0.2);
    setTimeout(() => audioContext.close().catch(() => {}), 700);
  } catch (error) {
    // Browsers can block audio before the first user interaction.
  }
};

const OrderTVCard = memo(({
  order,
  queueToken,
  now,
  onPrint,
  onStatusChange,
  onToggleItemReady,
}) => {
  const tone = statusTone[order.status] || statusTone.pending;
  const items = order.items || [];
  const visibleItems = items.slice(0, 6);
  const remainingItems = Math.max(items.length - visibleItems.length, 0);
  const itemCount = getItemCount(order);
  const readyCount = getReadyCount(order);
  const progressPercent = itemCount ? Math.min((readyCount / itemCount) * 100, 100) : 0;
  const orderLabel = getKitchenOrderLabel(order);

  return (
    <article className={`flex h-[390px] min-[2560px]:h-[430px] flex-col rounded-2xl border border-slate-200 border-l-8 ${tone.border} bg-white p-5 shadow-sm`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className={`truncate text-[32px] font-black leading-none ${tone.title}`}>
            ORDER #{queueToken}
          </h2>
          <div className="mt-3 flex min-w-0 items-center gap-3 text-[18px] font-bold text-slate-600">
            <span className="truncate">{orderLabel || 'Counter'}</span>
            <span className="text-slate-300">/</span>
            <span>{formatOrderTime(order.created_at)}</span>
          </div>
        </div>
        <Badge className={`shrink-0 rounded-full px-3 py-1 text-[18px] font-black ${tone.badge}`}>
          {tone.label}
        </Badge>
      </div>

      <div className="mt-4 grid grid-cols-[minmax(0,1fr),120px] items-center gap-4">
        <div>
          <div className="flex items-baseline gap-2 text-[24px] font-black text-slate-950">
            <span className={tone.title}>{readyCount} / {itemCount}</span>
            <span className="text-[18px] font-bold text-slate-500">Ready</span>
          </div>
          <div className="mt-2 h-3 overflow-hidden rounded-full bg-slate-200">
            <div
              className={`h-full rounded-full ${tone.bar}`}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
        <div className="text-right text-[18px] font-black text-slate-600">
          <Clock className="mb-1 ml-auto h-5 w-5" />
          {formatElapsed(order.created_at, now)}
        </div>
      </div>

      <div className="mt-4 flex-1 overflow-hidden">
        <div className="mb-2 text-[18px] font-black text-slate-900">
          {itemCount} item{itemCount !== 1 ? 's' : ''}
        </div>
        <div className="space-y-1.5">
          {visibleItems.map((item, index) => {
            const ready = isItemReady(order, item);
            return (
              <label
                key={`${order.order_id}-${item.item_id || item.name}-${index}`}
                className={`flex h-8 cursor-pointer items-center gap-3 rounded-lg px-2 text-[20px] font-bold leading-none transition-colors ${
                  ready ? 'bg-emerald-50 text-slate-500' : 'text-slate-950 hover:bg-slate-50'
                }`}
              >
                <input
                  type="checkbox"
                  checked={ready}
                  onChange={() => onToggleItemReady(order.order_id, index, !ready)}
                  className="h-6 w-6 shrink-0 rounded-md border-slate-300 accent-emerald-600"
                />
                <span className="shrink-0 text-slate-600">{item.quantity}x</span>
                <span className={`truncate ${ready ? 'line-through opacity-70' : ''}`}>{item.name}</span>
              </label>
            );
          })}
        </div>
        {remainingItems > 0 && (
          <div className="mt-2 rounded-lg bg-slate-100 px-3 py-1.5 text-[18px] font-black text-slate-600">
            + {remainingItems} more item{remainingItems !== 1 ? 's' : ''}
          </div>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => onPrint(order)}
          className="h-14 rounded-xl border-slate-900 bg-white text-xl font-black text-slate-950 hover:bg-slate-50"
        >
          <Printer className="mr-2 h-5 w-5" />
          Print
        </Button>
        {order.status === 'pending' && (
          <Button
            type="button"
            onClick={() => onStatusChange(order.order_id, 'accepted')}
            className={`h-14 rounded-xl text-xl font-black text-white ${tone.action}`}
          >
            Accept
          </Button>
        )}
        {order.status === 'accepted' && (
          <Button
            type="button"
            onClick={() => onStatusChange(order.order_id, 'prepared')}
            className={`h-14 rounded-xl text-xl font-black text-white ${tone.action}`}
          >
            Mark Ready
          </Button>
        )}
        {order.status === 'prepared' && (
          <div className="flex h-14 items-center justify-center rounded-xl bg-blue-600 text-xl font-black text-white">
            <CheckCircle2 className="mr-2 h-6 w-6" />
            Completed
          </div>
        )}
      </div>
    </article>
  );
});

const KitchenTVDisplay = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { socket, joinRoom } = useSocket();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [now, setNow] = useState(Date.now());
  const statusSaveQueueRef = useRef({});
  const desiredStatusRef = useRef({});

  const fetchOrders = useCallback(async () => {
    try {
      const response = await api.get('/api/orders', { withCredentials: true });
      setOrders(response.data.filter((order) => activeStatuses.includes(order.status)));
      setLastUpdated(new Date());
    } catch (error) {
      toast.error('Failed to load kitchen TV orders');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (socket && user?.restaurant_id) {
      joinRoom(`restaurant_${user.restaurant_id}`);
    }
  }, [socket, user, joinRoom]);

  useEffect(() => {
    if (!socket) return undefined;

    const upsertOrder = (incomingOrder) => {
      setOrders((prev) => {
        if (!activeStatuses.includes(incomingOrder.status)) {
          return prev.filter((order) => order.order_id !== incomingOrder.order_id);
        }

        const existing = prev.some((order) => order.order_id === incomingOrder.order_id);
        if (existing) {
          return prev.map((order) => (
            order.order_id === incomingOrder.order_id ? incomingOrder : order
          ));
        }
        return [incomingOrder, ...prev];
      });
      setLastUpdated(new Date());
    };

    const handleNewOrder = (newOrder) => {
      upsertOrder(newOrder);
      if (soundEnabled) playKitchenAlert();
    };

    const handleKitchenNotification = (notification) => {
      if (soundEnabled) playKitchenAlert();
      toast.warning(notification.message);
    };

    const handleOrderDeleted = (payload) => {
      setOrders((prev) => prev.filter((order) => order.order_id !== payload.order_id));
      setLastUpdated(new Date());
    };

    socket.on('new_order', handleNewOrder);
    socket.on('kitchen_notification', handleKitchenNotification);
    socket.on('order_status_updated', upsertOrder);
    socket.on('order_deleted', handleOrderDeleted);

    return () => {
      socket.off('new_order', handleNewOrder);
      socket.off('kitchen_notification', handleKitchenNotification);
      socket.off('order_status_updated', upsertOrder);
      socket.off('order_deleted', handleOrderDeleted);
    };
  }, [socket, soundEnabled]);

  const activeOrders = useMemo(() => (
    orders
      .filter((order) => activeStatuses.includes(order.status))
      .sort((a, b) => {
        const statusRank = { pending: 0, accepted: 1, prepared: 2 };
        const rankDelta = (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3);
        if (rankDelta !== 0) return rankDelta;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      })
  ), [orders]);

  const queueTokenMap = useMemo(() => (
    [...activeOrders]
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .reduce((tokens, order, index) => {
        tokens[order.order_id] = index + 1;
        return tokens;
      }, {})
  ), [activeOrders]);

  const totals = useMemo(() => {
    const totalItems = activeOrders.reduce((total, order) => total + getItemCount(order), 0);
    const readyItems = activeOrders.reduce((total, order) => total + getReadyCount(order), 0);
    return {
      totalItems,
      readyItems,
      pending: activeOrders.filter((order) => order.status === 'pending').length,
      accepted: activeOrders.filter((order) => order.status === 'accepted').length,
      prepared: activeOrders.filter((order) => order.status === 'prepared').length,
    };
  }, [activeOrders]);

  const updateStatus = useCallback((orderId, status) => {
    const changedAt = new Date().toISOString();
    desiredStatusRef.current[orderId] = status;
    setOrders((prev) => prev.map((order) => {
      if (order.order_id !== orderId) return order;
      const nextItems = status === 'prepared'
        ? (order.items || []).map((item) => ({ ...item, ready: true, ready_updated_at: changedAt }))
        : order.items;
      return {
        ...order,
        status,
        items: nextItems,
        updated_at: changedAt,
        timestamps: {
          ...(order.timestamps || {}),
          [status]: changedAt,
        },
      };
    }));

    const saveRequest = (statusSaveQueueRef.current[orderId] || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const response = await api.put(`/api/orders/${orderId}/status`, {
          status,
          mark_items_ready: status === 'prepared',
        });
        if (desiredStatusRef.current[orderId] === status) {
          setOrders((prev) => prev.map((order) => (
            order.order_id === orderId ? response.data : order
          )));
          setLastUpdated(new Date());
        }
      })
      .catch((error) => {
        if (desiredStatusRef.current[orderId] === status) {
          toast.error(error.response?.data?.detail || 'Failed to update order');
          fetchOrders();
        }
      })
      .finally(() => {
        if (statusSaveQueueRef.current[orderId] === saveRequest) {
          delete statusSaveQueueRef.current[orderId];
          delete desiredStatusRef.current[orderId];
        }
      });

    statusSaveQueueRef.current[orderId] = saveRequest;
  }, [fetchOrders]);

  const toggleItemReady = useCallback((orderId, itemIndex, ready) => {
    const changedAt = new Date().toISOString();
    setOrders((prev) => prev.map((order) => {
      if (order.order_id !== orderId) return order;
      return {
        ...order,
        items: (order.items || []).map((item, index) => (
          index === itemIndex ? { ...item, ready, ready_updated_at: changedAt } : item
        )),
        updated_at: changedAt,
      };
    }));

    api.put(`/api/orders/${orderId}/items/${itemIndex}/ready`, { ready })
      .then((response) => {
        setOrders((prev) => prev.map((order) => (
          order.order_id === orderId ? response.data : order
        )));
        setLastUpdated(new Date());
      })
      .catch((error) => {
        toast.error(error.response?.data?.detail || 'Failed to update item');
        fetchOrders();
      });
  }, [fetchOrders]);

  const printOrder = useCallback((order) => {
    if (!order) return;
    const popup = window.open('', '_blank', 'width=900,height=720');
    if (!popup) {
      toast.error('Please allow popups to print.');
      return;
    }

    const itemsHtml = (order.items || []).map((item) => `
      <tr>
        <td>${escapeHtml(item.quantity)}x</td>
        <td>${escapeHtml(item.name)}${item.instructions ? `<div class="muted">${escapeHtml(item.instructions)}</div>` : ''}</td>
      </tr>
    `).join('');

    popup.document.write(`
      <html>
        <head>
          <title>${escapeHtml(order.order_id)}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 24px; color: #111827; }
            h1, p { margin: 0 0 10px; }
            table { width: 100%; border-collapse: collapse; margin-top: 18px; }
            td { border-bottom: 1px solid #ddd; padding: 10px; font-size: 18px; }
            td:first-child { width: 64px; font-weight: 700; }
            .muted { color: #555; font-size: 14px; margin-top: 4px; }
          </style>
        </head>
        <body>
          <h1>${escapeHtml(getKitchenOrderLabel(order) || 'Kitchen Order')}</h1>
          <p>${escapeHtml(order.order_id)} / ${escapeHtml(formatOrderTime(order.created_at))}</p>
          <table>${itemsHtml}</table>
          <script>window.onload = () => window.print();</script>
        </body>
      </html>
    `);
    popup.document.close();
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const toggleSound = () => {
    setSoundEnabled((current) => {
      const next = !current;
      if (next) playKitchenAlert();
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-700">
        <Clock className="mr-3 h-9 w-9 animate-pulse text-emerald-600" />
        <span className="text-2xl font-black">Loading kitchen TV...</span>
      </div>
    );
  }

  const overallProgress = totals.totalItems
    ? Math.min((totals.readyItems / totals.totalItems) * 100, 100)
    : 0;

  return (
    <div className="min-h-screen bg-[#F7FAFC] text-slate-950">
      <header className="border-b border-slate-200 bg-white px-8 py-6 shadow-sm">
        <div className="flex items-center justify-between gap-8">
          <div className="flex items-center gap-5">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-600 text-white shadow-sm">
              <ChefHat className="h-10 w-10" />
            </div>
            <div>
              <h1 className="text-[38px] font-black leading-none tracking-tight text-slate-950">Kitchen TV Display</h1>
              <p className="mt-2 text-xl font-bold text-slate-600">
                {user?.restaurant_name || user?.username || 'Kitchen'} / {activeOrders.length} active order{activeOrders.length !== 1 ? 's' : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <Button
              type="button"
              onClick={toggleSound}
              className={`h-14 rounded-xl px-6 text-xl font-black ${
                soundEnabled
                  ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
              aria-pressed={soundEnabled}
            >
              {soundEnabled ? <Volume2 className="mr-2 h-6 w-6" /> : <VolumeX className="mr-2 h-6 w-6" />}
              Sound {soundEnabled ? 'On' : 'Off'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleLogout}
              className="h-14 rounded-xl border-slate-300 bg-white px-6 text-xl font-black text-slate-950 hover:bg-slate-50"
            >
              <LogOut className="mr-2 h-6 w-6" />
              Logout
            </Button>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-[repeat(3,minmax(180px,1fr)),minmax(360px,1.8fr)] gap-5">
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
            <div className="flex items-center justify-between text-[26px] font-black text-emerald-700">
              <span>New</span>
              <span>{totals.pending}</span>
            </div>
            <div className="mt-4 h-2 rounded-full bg-emerald-600" />
          </div>
          <div className="rounded-2xl border border-orange-200 bg-white p-5">
            <div className="flex items-center justify-between text-[26px] font-black text-orange-600">
              <span>Preparing</span>
              <span>{totals.accepted}</span>
            </div>
            <div className="mt-4 h-2 rounded-full bg-orange-500" />
          </div>
          <div className="rounded-2xl border border-blue-200 bg-white p-5">
            <div className="flex items-center justify-between text-[26px] font-black text-blue-600">
              <span>Ready</span>
              <span>{totals.prepared}</span>
            </div>
            <div className="mt-4 h-2 rounded-full bg-blue-600" />
          </div>
          <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-5">
            <div className="flex items-center justify-between text-[28px] font-black text-slate-700">
              <span><span className="text-emerald-700">{totals.readyItems} / {totals.totalItems}</span> Ready</span>
              <span className="text-lg font-bold text-slate-500">
                Live{lastUpdated ? ` / ${lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''}
              </span>
            </div>
            <div className="mt-4 h-3 overflow-hidden rounded-full bg-slate-200">
              <div className="h-full rounded-full bg-emerald-600" style={{ width: `${overallProgress}%` }} />
            </div>
          </div>
        </div>
      </header>

      <main className="p-8">
        {activeOrders.length === 0 ? (
          <div className="flex min-h-[520px] items-center justify-center rounded-3xl border border-dashed border-slate-300 bg-white text-center">
            <div>
              <ChefHat className="mx-auto h-20 w-20 text-slate-300" />
              <p className="mt-6 text-[34px] font-black text-slate-900">No active kitchen orders</p>
              <p className="mt-2 text-xl font-bold text-slate-500">New orders will appear here automatically.</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-6 2xl:grid-cols-4 min-[2560px]:grid-cols-5 min-[3400px]:grid-cols-6">
            {activeOrders.map((order) => (
              <OrderTVCard
                key={order.order_id}
                order={order}
                queueToken={queueTokenMap[order.order_id] || '-'}
                now={now}
                onPrint={printOrder}
                onStatusChange={updateStatus}
                onToggleItemReady={toggleItemReady}
              />
            ))}
          </div>
        )}
      </main>

      <div className="fixed bottom-5 left-8 flex items-center gap-2 rounded-full bg-white px-4 py-2 text-base font-bold text-slate-600 shadow-sm">
        <RefreshCw className="h-5 w-5 text-emerald-600" />
        Socket.IO realtime
      </div>
    </div>
  );
};

export default KitchenTVDisplay;
