import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { toast } from 'sonner';
import api from '../lib/api';
import { useSocket } from '../contexts/SocketContext';
import { CheckCircle, Clock, ChefHat, Package, Loader2 } from 'lucide-react';

const statusConfig = {
  pending: { color: 'bg-gray-500', icon: Clock, label: 'Pending' },
  accepted: { color: 'bg-warning', icon: ChefHat, label: 'Preparing' },
  prepared: { color: 'bg-success', icon: Package, label: 'Served' },
  served: { color: 'bg-primary', icon: CheckCircle, label: 'Served' },
  cancelled: { color: 'bg-destructive', icon: Clock, label: 'Cancelled' },
};

const OrderTracking = () => {
  const { orderId } = useParams();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const { socket, joinRoom } = useSocket();

  useEffect(() => {
    const fetchOrder = async () => {
      try {
        const response = await api.get(`/api/orders/${orderId}`, {
          params: {
            customer_session_token: localStorage.getItem('customer_session') || '',
          },
        });
        setOrder(response.data);
        setLoading(false);
      } catch (error) {
        toast.error('Failed to load order');
        setLoading(false);
      }
    };

    fetchOrder();
  }, [orderId]);

  useEffect(() => {
    if (!socket) return;
    joinRoom(`order_${orderId}`);

    const handleOrderUpdate = (updatedOrder) => {
      if (updatedOrder.order_id === orderId) {
        setOrder(updatedOrder);
        toast.success(`Order status: ${updatedOrder.status}`);
      }
    };

    socket.on('order_status_updated', handleOrderUpdate);

    return () => {
      socket.off('order_status_updated', handleOrderUpdate);
    };
  }, [socket, orderId, joinRoom]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#F9F8F6' }}>
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
      </div>
    );
  }

  if (!order) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#F9F8F6' }}>
        <p>Order not found</p>
      </div>
    );
  }

  const StatusIcon = statusConfig[order.status]?.icon || Clock;
  const tableSummary = order.table_order_summary;
  const activeTableOrders = tableSummary?.orders || [];
  const combinedTotal = tableSummary?.combined_total ?? order.total;

  return (
    <div className="min-h-screen p-6" style={{ background: '#F9F8F6' }}>
      <div className="max-w-2xl mx-auto space-y-6">
        <Card className="border-border rounded-2xl shadow-[0_2px_10px_rgba(0,0,0,0.05)]">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-2xl tracking-tight">Order #{order.order_id}</CardTitle>
              <Badge className={`${statusConfig[order.status]?.color} text-white rounded-md px-3 py-1`}>
                <StatusIcon className="w-4 h-4 mr-1" />
                {statusConfig[order.status]?.label}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{order.table_label || `Table ${order.table_id}`}</p>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <h3 className="font-semibold mb-3">Order Items</h3>
              <div className="space-y-2">
                {order.items.map((item, idx) => (
                  <div key={idx} className="flex justify-between items-center p-3 bg-accent rounded-xl">
                    <div>
                      <p className="font-medium">{item.name}</p>
                      <p className="text-sm text-muted-foreground">Quantity: {item.quantity}</p>
                      {item.instructions && (
                        <p className="text-xs text-muted-foreground italic">Note: {item.instructions}</p>
                      )}
                    </div>
                    <p className="font-semibold">₹{(item.price * item.quantity).toFixed(2)}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="border-t border-border pt-4">
              <div className="flex justify-between text-lg font-bold">
                <span>This Order</span>
                <span className="text-primary">₹{order.total.toFixed(2)}</span>
              </div>
              {activeTableOrders.length > 1 && (
                <div className="flex justify-between text-lg font-bold mt-3">
                  <span>Running Table Total</span>
                  <span className="text-primary">₹{combinedTotal.toFixed(2)}</span>
                </div>
              )}
            </div>

            <div className="bg-blue-50 rounded-xl p-4 border border-blue-200">
              <p className="text-sm text-blue-900">
                {order.status === 'pending' && 'Your order is being reviewed by the kitchen.'}
                {order.status === 'accepted' && 'Your delicious meal is being prepared!'}
                {order.status === 'prepared' && 'Your order is prepared and is now being served.'}
                {order.status === 'served' && 'Enjoy your meal!'}
                {order.status === 'cancelled' && 'This order has been cancelled.'}
              </p>
            </div>

            {activeTableOrders.length > 1 && (
              <div>
                <h3 className="font-semibold mb-3">All Active Orders For This Table</h3>
                <div className="space-y-3">
                  {activeTableOrders.map((tableOrder) => (
                    <div key={tableOrder.order_id} className="rounded-xl border border-border bg-white p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="font-semibold">{tableOrder.order_id}</p>
                          <p className="text-sm text-muted-foreground">{new Date(tableOrder.created_at).toLocaleString()}</p>
                        </div>
                        <div className="text-right">
                          <Badge className={`${statusConfig[tableOrder.status]?.color} text-white rounded-md px-3 py-1`}>
                            {statusConfig[tableOrder.status]?.label || tableOrder.status}
                          </Badge>
                          <p className="mt-2 font-semibold text-primary">₹{tableOrder.total.toFixed(2)}</p>
                        </div>
                      </div>
                      {tableOrder.is_add_on && (
                        <p className="mt-2 text-xs text-amber-700">Add-on order</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default OrderTracking;
