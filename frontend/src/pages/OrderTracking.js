import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { toast } from 'sonner';
import api from '../lib/api';
import { useSocket } from '../contexts/SocketContext';
import { CheckCircle, Clock, ChefHat, Download, Package, Loader2, Star } from 'lucide-react';


const statusConfig = {
  pending: { color: 'bg-gray-500', icon: Clock, label: 'Pending' },
  accepted: { color: 'bg-warning', icon: ChefHat, label: 'Preparing' },
  prepared: { color: 'bg-success', icon: Package, label: 'Served' },
  served: { color: 'bg-primary', icon: CheckCircle, label: 'Served' },
  cancelled: { color: 'bg-destructive', icon: Clock, label: 'Cancelled' },
};

const summarizeBillItems = (orders = []) => {
  const grouped = new Map();

  orders.forEach((orderItem) => {
    (orderItem.items || []).forEach((item) => {
      const key = `${item.item_id || item.name}-${item.price}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.quantity += item.quantity;
        existing.amount += item.quantity * item.price;
        return;
      }

      grouped.set(key, {
        name: item.name,
        quantity: item.quantity,
        amount: item.quantity * item.price,
      });
    });
  });

  return Array.from(grouped.values());
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
        api.get(`/api/orders/${orderId}`, {
          params: {
            customer_session_token: localStorage.getItem('customer_session') || '',
          },
        }).then((response) => {
          setOrder(response.data);
        }).catch(() => {
          setOrder((prev) => ({ ...prev, ...updatedOrder }));
        });
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
  const billSummary = order.bill_summary;
  const googleReviewUrl = billSummary?.google_review_url;
  const paidBillItems = billSummary?.payment ? summarizeBillItems(billSummary.orders) : [];
  const displayItems = billSummary?.payment
    ? paidBillItems.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      amount: item.amount,
    }))
    : order.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      instructions: item.instructions,
      amount: item.price * item.quantity,
    }));
  const downloadBill = () => {
    if (!billSummary?.payment) {
      toast.error('Bill is not available yet.');
      return;
    }

    const payment = billSummary.payment;
    const restaurantName = billSummary.restaurant_name || 'Restaurant';
    const gstNumber = billSummary.restaurant_gst_number?.trim();
    const summarizedItems = summarizeBillItems(billSummary.orders);
    const itemsHtml = summarizedItems.map((item) => `
      <tr>
        <td>${item.name}</td>
        <td>${item.quantity}</td>
        <td>Rs. ${item.amount.toFixed(2)}</td>
      </tr>
    `).join('');

    const billHtml = `
      <html>
        <head>
          <title>${restaurantName} - ${billSummary.bill_id}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
            h1, p { margin: 0 0 12px; }
            table { width: 100%; border-collapse: collapse; margin-top: 16px; }
            th, td { border-bottom: 1px solid #ddd; padding: 8px; text-align: left; }
            .header { border-bottom: 2px solid #111; padding-bottom: 12px; margin-bottom: 16px; }
            .totals { margin-top: 20px; width: 320px; margin-left: auto; }
            .totals div { display: flex; justify-content: space-between; margin-bottom: 8px; }
            .strong { font-weight: 700; }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>${restaurantName}</h1>
            <p>Bill ID: ${billSummary.bill_id}</p>
            ${gstNumber ? `<p>GST Number: ${gstNumber}</p>` : ''}
          </div>
          <p>${order.table_label || `Table ${order.table_id}`}</p>
          <p>Customer: ${order.customer_name}</p>
          <p>Payment Method: ${(payment.payment_method || 'N/A').toUpperCase()}</p>
          <p>Generated At: ${new Date(payment.created_at || Date.now()).toLocaleString()}</p>
          <table>
            <thead>
              <tr><th>Item</th><th>Qty</th><th>Amount</th></tr>
            </thead>
            <tbody>${itemsHtml}</tbody>
          </table>
          <div class="totals">
            <div><span>Subtotal</span><span>Rs. ${(payment.subtotal || 0).toFixed(2)}</span></div>
            <div><span>Tax (5%)</span><span>Rs. ${(payment.tax || 0).toFixed(2)}</span></div>
            <div><span>Discount</span><span>Rs. ${(payment.discount || 0).toFixed(2)}</span></div>
            <div class="strong"><span>Total</span><span>Rs. ${(payment.total || 0).toFixed(2)}</span></div>
          </div>
        </body>
      </html>
    `;

    const blob = new Blob([billHtml], { type: 'text/html;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${billSummary.bill_id || order.order_id}-bill.html`;
    link.click();
    window.URL.revokeObjectURL(url);
  };
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
               <h3 className="font-semibold mb-3">
                {billSummary?.payment ? 'Final Bill Items' : 'Order Items'}
              </h3>
              <div className="space-y-2">
                {displayItems.map((item, idx) => (
                  <div key={idx} className="flex justify-between items-center p-3 bg-accent rounded-xl">
                    <div>
                      <p className="font-medium">{item.name}</p>
                      <p className="text-sm text-muted-foreground">Quantity: {item.quantity}</p>
                      {item.instructions && (
                        <p className="text-xs text-muted-foreground italic">Note: {item.instructions}</p>
                      )}
                    </div>
                     <p className="font-semibold">₹{item.amount.toFixed(2)}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="border-t border-border pt-4">
               {billSummary?.payment ? (
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span>Subtotal</span>
                    <span>₹{(billSummary.payment.subtotal || 0).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Tax (5%)</span>
                    <span>₹{(billSummary.payment.tax || 0).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Discount</span>
                    <span>₹{(billSummary.payment.discount || 0).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between border-t border-border pt-2 text-lg font-bold">
                    <span>Final Bill Total</span>
                    <span className="text-primary">₹{(billSummary.payment.total || 0).toFixed(2)}</span>
                  </div>
                </div>
              ) : (
                <>
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
                </>
              )}
            </div>
               {billSummary?.payment && (
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={downloadBill}
                  className="w-full rounded-full bg-primary px-4 py-3 text-sm font-semibold text-white hover:bg-[#C54E2C]"
                >
                  <Download className="inline-block w-4 h-4 mr-2" />
                  Download Bill
                </button>

                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-center">
                  <div className="mx-auto mb-2 flex w-fit items-center gap-1 text-amber-500">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <Star key={star} className="h-5 w-5 fill-current" />
                    ))}
                  </div>
                  <h3 className="font-semibold text-amber-950">How was your experience?</h3>
                  <p className="mt-1 text-sm text-amber-900">
                    Your feedback helps us serve you better. Please leave us a Google review.
                  </p>
                  {googleReviewUrl ? (
                    <a
                      href={googleReviewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-3 inline-flex w-full items-center justify-center rounded-full bg-amber-500 px-4 py-3 text-sm font-semibold text-white hover:bg-amber-600"
                    >
                      Give Google Review
                    </a>
                  ) : (
                    <p className="mt-3 rounded-xl bg-white/70 px-3 py-2 text-xs text-amber-900">
                      Google review link is not configured yet.
                    </p>
                  )}
                </div>
              </div>
            )}
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
