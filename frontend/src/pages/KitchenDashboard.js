import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { toast } from 'sonner';
import api from '../lib/api';
import { useSocket } from '../contexts/SocketContext';
import { useAuth } from '../contexts/AuthContext';
import { BellRing, ChefHat, Clock, LogOut, Sparkles, UtensilsCrossed } from 'lucide-react';

const statusTone = {
  pending: {
    label: 'New Order',
    badge: 'bg-slate-100 text-slate-700',
    border: 'border-slate-200',
    button: 'bg-primary hover:bg-[#C54E2C]',
  },
  accepted: {
    label: 'Preparing',
    badge: 'bg-blue-100 text-blue-700',
    border: 'border-blue-200',
    button: 'bg-warning hover:bg-[#E09616]',
  },
  prepared: {
    label: 'Prepared',
    badge: 'bg-emerald-100 text-emerald-700',
    border: 'border-emerald-200',
    button: '',
  },
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

  const KitchenDashboard = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { socket, joinRoom } = useSocket();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);  
 

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
      playKitchenAlert();
      if (newOrder.is_add_on) {
        toast.warning(`Add-on order for ${newOrder.table_label || newOrder.table_id}`, {
          description: 'Previous table ticket is still in progress.',
        });
      } else {
        toast.success(`New order from ${newOrder.table_label || newOrder.table_id}`);
      }
    });

    socket.on('kitchen_notification', (notification) => {
      playKitchenAlert();
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
  }, [socket]);

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
const enableSound = () => {
    playKitchenAlert();
    toast.success('Kitchen notification sound enabled');
  };
  const groupedTables = useMemo(() => {
    const activeOrders = orders.filter((order) => !['served', 'cancelled'].includes(order.status));
    const tableGroups = activeOrders.reduce((groups, order) => {
      const key = order.table_id;
      if (!groups[key]) {
        groups[key] = {
          table_id: order.table_id,
          table_label: order.table_label || `Table ${order.table_id}`,
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
      .filter((order) => ['pending', 'accepted'].includes(order.status))
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    return queueOrders.reduce((tokens, order, index) => {
      tokens[order.order_id] = index + 1;
      return tokens;
    }, {});
  }, [orders]);
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#F3F4F6' }}>
        <Clock className="h-10 w-10 animate-pulse text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: '#F3F4F6' }}>
      <div className="bg-white border-b border-border sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <ChefHat className="w-8 h-8 text-primary" />
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Kitchen Dashboard</h1>
              <p className="text-sm text-muted-foreground">Welcome, {user?.name}</p>
              {user?.restaurant_name && (
                <p className="text-xs sm:text-sm text-muted-foreground truncate">{user.restaurant_name}</p>
              )}
            </div>
          </div>
          <Button
            onClick={handleLogout}
            variant="outline"
            className="rounded-full border-border"
            data-testid="logout-button"
          >
            <LogOut className="w-4 h-4 mr-2" />
            Logout
          </Button>
             <Button
            onClick={enableSound}
            className="rounded-full bg-primary hover:bg-[#C54E2C]"
          >
            <BellRing className="w-4 h-4 mr-2" />
            Enable Sound
          </Button>  
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="border-border rounded-2xl">
            <CardContent className="p-5 flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Tables In Queue</p>
                <p className="text-3xl font-bold">{groupedTables.length}</p>
              </div>
              <UtensilsCrossed className="h-8 w-8 text-primary" />
            </CardContent>
          </Card>
          <Card className="border-border rounded-2xl">
            <CardContent className="p-5 flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Preparing</p>
                <p className="text-3xl font-bold">{orders.filter((order) => order.status === 'accepted').length}</p>
              </div>
              <ChefHat className="h-8 w-8 text-warning" />
            </CardContent>
          </Card>
          <Card className="border-border rounded-2xl">
            <CardContent className="p-5 flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Add-on Alerts</p>
                <p className="text-3xl font-bold">{orders.filter((order) => order.is_add_on).length}</p>
              </div>
              <BellRing className="h-8 w-8 text-primary" />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          {groupedTables.map((group) => (
            <Card
              key={group.table_id}
              className={`border-border rounded-2xl ${group.tablePriority ? 'ring-2 ring-amber-300' : ''}`}
            >
              <CardHeader className="px-4 py-3">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <CardTitle className="text-xl">{group.table_label}</CardTitle>
                    <p className="text-sm text-muted-foreground">{group.orders.length} active ticket{group.orders.length > 1 ? 's' : ''}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge className="rounded-full bg-slate-100 text-slate-700">New {group.counts.pending || 0}</Badge>
                    <Badge className="rounded-full bg-blue-100 text-blue-700">Preparing {group.counts.accepted || 0}</Badge>
                    <Badge className="rounded-full bg-emerald-100 text-emerald-700">Prepared {group.counts.prepared || 0}</Badge>
                    {group.tablePriority && (
                      <Badge className="rounded-full bg-amber-100 text-amber-800">
                        <Sparkles className="mr-1 h-3 w-3" />
                        Add-on Priority
                      </Badge>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-2 px-4 pb-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"> 
                {group.orders.map((order) => {
                  const tone = statusTone[order.status] || statusTone.pending;
                  const queueToken = queueTokenMap[order.order_id];
                  const isPriorityTicket = queueToken === 1 && ['pending', 'accepted'].includes(order.status);
                  const ticketStateClass = isPriorityTicket
                    ? 'border-red-500 ring-2 ring-red-300 animate-pulse'
                    : order.status === 'prepared'
                      ? 'border-emerald-500 ring-1 ring-emerald-200'
                      : 'border-orange-400 ring-1 ring-orange-100';
                  const priorityAddOn = order.is_add_on && ['pending', 'accepted'].includes(order.status);
                  return (
                    <div
                      key={order.order_id}
                      className={`rounded-2xl border ${tone.border} bg-white p-4 space-y-4`}
                      data-testid={`order-card-${order.order_id}`}
                    >
                        <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                             <h3 className="text-base font-semibold">{order.order_id}</h3>
                             <div className={`rounded-full px-3 py-1 text-xs font-bold ${
                              isPriorityTicket
                                ? 'bg-red-100 text-red-700'
                                : order.status === 'prepared'
                                  ? 'bg-emerald-100 text-emerald-700'
                                  : 'bg-orange-100 text-orange-700'
                                 }`}>
	                              {order.status === 'prepared' ? 'DONE' : `TOKEN #${queueToken || '-'}`}
	                            </div>
                            <Badge className={`rounded-full ${tone.badge}`}>{tone.label}</Badge>
                            {order.is_add_on && (
                              <Badge className={`rounded-full ${priorityAddOn ? 'bg-amber-100 text-amber-800' : 'bg-orange-50 text-orange-700'}`}>
                                Add-on
                              </Badge>
                            )}
                          </div>
                          <h3 className="mt-1 truncate text-sm font-semibold">Order {order.order_id}</h3>    
                          <p className="mt-1 truncate text-xs text-muted-foreground">{order.customer_name}</p>
                          <p className="text-xs text-muted-foreground">{new Date(order.created_at).toLocaleString()}</p>
                          {order.add_on_to_order_id && (
                            <p className="text-xs text-amber-700">Linked to {order.add_on_to_order_id}</p>
                          )}
                        </div>
                        {priorityAddOn && (
                          <div className="shrink-0 rounded-full bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800">
                            Add-on
                          </div>
                        )}
                      </div>

                    
                        <div className="space-y-1.5 max-h-28 overflow-y-auto pr-1">
                        {order.items.map((item, index) => (
                          <div key={`${order.order_id}-${index}`} className="rounded-lg bg-accent px-2.5 py-1.5">
                             <p className="text-lg font-bold leading-tight text-foreground">{item.quantity}x {item.name}</p>
                            {item.instructions && (
                             <p className="mt-1 text-sm font-medium text-muted-foreground">{item.instructions}</p>
                            )}
                          </div>
                        ))}
                      </div>

                     <div className="flex gap-2">
                        {order.status === 'pending' && (
                          <Button
                            onClick={() => updateStatus(order.order_id, 'accepted')}
                             size="sm"
                            className={`flex-1 rounded-full ${tone.button}`}
                            data-testid={`accept-order-${order.order_id}`}
                          >
                            Accept
                          </Button>
                        )}
                        {order.status === 'accepted' && (
                          <Button
                            onClick={() => updateStatus(order.order_id, 'prepared')}
                             size="sm"
                            className={`flex-1 rounded-full ${tone.button}`}
                            data-testid={`mark-prepared-${order.order_id}`}
                          >
                            Mark Prepared
                          </Button>
                        )}
                        {order.status === 'prepared' && (
                          <div className="flex-1 rounded-full border border-emerald-200 px-3 py-1.5 text-center text-xs font-medium text-emerald-700">
                            Ready for billing
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ))}

          {groupedTables.length === 0 && (
            <Card className="border-border rounded-2xl">
              <CardContent className="p-10 text-center text-muted-foreground">
                No active kitchen tickets right now.
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
};

export default KitchenDashboard;
