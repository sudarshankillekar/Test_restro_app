import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import { toast } from 'sonner';
import api from '../lib/api';
import { useSocket } from '../contexts/SocketContext';
import { useAuth } from '../contexts/AuthContext';
import { BACKEND_URL } from '../lib/config';
import { CreditCard, DollarSign, LogOut, Receipt, Wallet } from 'lucide-react';

const formatPaymentMethod = (method) => {
  if (!method) return 'N/A';
  return method.toUpperCase();
};

const BillingDashboard = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { socket, joinRoom } = useSocket();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTable, setSelectedTable] = useState(null);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [discount, setDiscount] = useState(0);
  const [restaurantProfile, setRestaurantProfile] = useState({
    name: '',
    gst_number: '',
  });

  useEffect(() => {
    fetchOrders();

    const loadRestaurantProfile = async () => {
      try {
        const response = await axios.get(`${BACKEND_URL}/api/restaurant/profile`, {
          withCredentials: true,
        });
        setRestaurantProfile({
          name: response.data.name || '',
          gst_number: response.data.gst_number || '',
        });
      } catch (error) {
        setRestaurantProfile({
          name: '',
          gst_number: '',
        });
      }
    };

    loadRestaurantProfile();
  }, []);

  useEffect(() => {
    if (socket && user?.restaurant_id) {
      joinRoom(`restaurant_${user.restaurant_id}`);
    }
  }, [socket, user, joinRoom]);

  useEffect(() => {
    if (!socket) return;

    const upsertOrder = (updatedOrder) => {
      setOrders((prev) => {
        const existing = prev.find((order) => order.order_id === updatedOrder.order_id);
        if (existing) {
          return prev.map((order) => order.order_id === updatedOrder.order_id ? updatedOrder : order);
        }
        return [updatedOrder, ...prev];
      });
    };

    socket.on('new_order', upsertOrder);
    socket.on('order_status_updated', upsertOrder);

    return () => {
      socket.off('new_order', upsertOrder);
      socket.off('order_status_updated', upsertOrder);
    };
  }, [socket]);

  const fetchOrders = async () => {
    try {
      const response = await axios.get(`${BACKEND_URL}/api/orders`, {
        withCredentials: true,
      });
      setOrders(response.data);
    } catch (error) {
      toast.error('Failed to load orders');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const preparedGroups = useMemo(() => {
    const preparedOrders = orders.filter((order) => order.payment_status !== 'completed' && order.status === 'prepared');
    const grouped = preparedOrders.reduce((acc, order) => {
      const key = order.table_id;
      if (!acc[key]) {
        acc[key] = {
          table_id: order.table_id,
          table_label: order.table_label || `Table ${order.table_id}`,
          customer_name: order.customer_name,
          orders: [],
        };
      }
      acc[key].orders.push(order);
      return acc;
    }, {});

    return Object.values(grouped).map((group) => ({
      ...group,
      orders: group.orders.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
    }));
  }, [orders]);

  const completedBills = useMemo(() => {
    const completedOrders = orders.filter((order) => order.payment_status === 'completed' || order.status === 'served');
    const grouped = completedOrders.reduce((acc, order) => {
      const billKey = order.payment?.bill_id || order.payment?.payment_id || order.order_id;
      if (!acc[billKey]) {
        acc[billKey] = {
          bill_id: billKey,
          table_label: order.table_label || `Table ${order.table_id}`,
          customer_name: order.customer_name,
          payment: order.payment,
          orders: [],
        };
      }
      acc[billKey].orders.push(order);
      if (order.payment) {
        acc[billKey].payment = order.payment;
      }
      return acc;
    }, {});

    return Object.values(grouped).sort((a, b) => {
      const timeA = new Date(a.payment?.created_at || a.orders[0]?.updated_at || 0).getTime();
      const timeB = new Date(b.payment?.created_at || b.orders[0]?.updated_at || 0).getTime();
      return timeB - timeA;
    });
  }, [orders]);

  const calculateBill = (group) => {
    const subtotal = group.orders.reduce((sum, order) => sum + order.total, 0);
    const tax = subtotal * 0.05;
    const discountAmount = parseFloat(discount) || 0;
    return {
      subtotal,
      tax,
      discount: discountAmount,
      total: subtotal + tax - discountAmount,
    };
  };

  const processPayment = async () => {
    if (!selectedTable) return;

    try {
      await axios.post(
        `${BACKEND_URL}/api/payments`,
        {
          order_ids: selectedTable.orders.map((order) => order.order_id),
          payment_method: paymentMethod,
          discount: parseFloat(discount) || 0,
        },
        { withCredentials: true }
      );

      toast.success('Bill completed successfully!');
      setSelectedTable(null);
      setDiscount(0);
      fetchOrders();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Payment failed');
    }
  };

  const printBill = (bill) => {
    const payment = bill.payment || {};
    const subtotal = payment.subtotal || bill.orders.reduce((sum, order) => sum + order.total, 0);
    const tax = payment.tax || subtotal * 0.05;
    const total = payment.total || subtotal + tax;
    const restaurantName = restaurantProfile.name || user?.restaurant_name || 'Restaurant';
    const gstNumber = restaurantProfile.gst_number?.trim();
    const popup = window.open('', '_blank', 'width=800,height=700');
    if (!popup) {
      toast.error('Please allow popups to print the bill.');
      return;
    }

    const itemsHtml = bill.orders.flatMap((order) => order.items).map((item) => `
      <tr>
        <td>${item.name}</td>
        <td>${item.quantity}</td>
        <td>Rs. ${(item.quantity * item.price).toFixed(2)}</td>
      </tr>
    `).join('');

    popup.document.write(`
      <html>
        <head>
          <title>${restaurantName} - ${bill.bill_id}</title>
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
          </style>
        </head>
        <body>
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
          <script>window.onload = () => window.print();</script>
        </body>
      </html>
    `);
    popup.document.close();
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#F3F4F6' }}>
        <Wallet className="h-10 w-10 animate-pulse text-primary" />
      </div>
    );
  }

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

      <div className="max-w-7xl mx-auto p-4 sm:p-6 grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-6">
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Ready To Bill ({preparedGroups.length})</h2>
          <div className="space-y-4">
            {preparedGroups.map((group) => {
              const previewBill = {
                subtotal: group.orders.reduce((sum, order) => sum + order.total, 0),
                tax: group.orders.reduce((sum, order) => sum + order.total, 0) * 0.05,
              };
              return (
                <Card
                  key={group.table_id}
                  className="border-border rounded-2xl shadow-[0_2px_10px_rgba(0,0,0,0.05)]"
                >
                  <CardHeader>
                    <div className="flex items-center justify-between gap-3">
                      <CardTitle className="text-lg">{group.table_label}</CardTitle>
                      <Badge className="bg-emerald-100 text-emerald-700 rounded-full">
                        {group.orders.length} order{group.orders.length > 1 ? 's' : ''}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">{group.customer_name}</p>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-3">
                      {group.orders.map((order) => (
                        <div key={order.order_id} className="rounded-xl bg-accent p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="font-medium">{order.order_id}</span>
                            {order.is_add_on && (
                              <Badge className="rounded-full bg-amber-100 text-amber-800">Add-on</Badge>
                            )}
                          </div>
                          {order.items.map((item, idx) => (
                            <div key={`${order.order_id}-${idx}`} className="flex justify-between text-sm">
                              <span>{item.quantity}x {item.name}</span>
                              <span>₹{(item.price * item.quantity).toFixed(2)}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                    <div className="border-t pt-2">
                      <div className="flex justify-between font-bold">
                        <span>Total</span>
                        <span className="text-primary">₹{(previewBill.subtotal + previewBill.tax).toFixed(2)}</span>
                      </div>
                    </div>
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button
                          onClick={() => setSelectedTable(group)}
                          className="w-full rounded-full bg-primary hover:bg-[#C54E2C]"
                        >
                          <Receipt className="w-4 h-4 mr-2" />
                          Create Table Bill
                        </Button>
                      </DialogTrigger>
                      {selectedTable?.table_id === group.table_id && (
                        <DialogContent className="rounded-2xl">
                          <DialogHeader>
                            <DialogTitle>Process Payment - {group.table_label}</DialogTitle>
                          </DialogHeader>
                          <div className="space-y-4 py-4">
                            <div className="space-y-2">
                              <div className="flex justify-between">
                                <span>Subtotal</span>
                                <span>₹{calculateBill(group).subtotal.toFixed(2)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span>Tax (5%)</span>
                                <span>₹{calculateBill(group).tax.toFixed(2)}</span>
                              </div>
                              <div className="flex justify-between items-center">
                                <Label htmlFor="discount">Discount</Label>
                                <Input
                                  id="discount"
                                  type="number"
                                  value={discount}
                                  onChange={(e) => setDiscount(e.target.value)}
                                  className="w-24 rounded-full"
                                  placeholder="0"
                                />
                              </div>
                              <div className="flex justify-between font-bold text-lg border-t pt-2">
                                <span>Total</span>
                                <span className="text-primary">₹{calculateBill(group).total.toFixed(2)}</span>
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
                            <Button
                              onClick={processPayment}
                              className="w-full rounded-full bg-success hover:bg-[#3E6648]"
                            >
                              <DollarSign className="w-4 h-4 mr-2" />
                              Complete Payment
                            </Button>
                          </div>
                        </DialogContent>
                      )}
                    </Dialog>
                  </CardContent>
                </Card>
              );
            })}
            {preparedGroups.length === 0 && (
              <Card className="border-border rounded-2xl">
                <CardContent className="p-10 text-center text-muted-foreground">
                  No prepared tables waiting for payment.
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Completed Bills ({completedBills.length})</h2>
          <div className="space-y-4">
            {completedBills.slice(0, 10).map((bill) => (
              <Card
                key={bill.bill_id}
                className="border-border rounded-2xl bg-gray-50"
              >
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">{bill.table_label}</CardTitle>
                    <Badge className="bg-primary rounded-full">Paid</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{bill.bill_id}</p>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-sm text-muted-foreground">{bill.customer_name}</span>
                    <span className="font-semibold">₹{(bill.payment?.total || 0).toFixed(2)}</span>
                  </div>
                  <div className="space-y-2">
                    {bill.orders.map((order) => (
                      <div key={order.order_id} className="rounded-xl bg-white p-3 border border-border">
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-medium">{order.order_id}</span>
                          {order.is_add_on && (
                            <Badge className="rounded-full bg-amber-100 text-amber-800">Add-on</Badge>
                          )}
                        </div>
                        {order.items.map((item, idx) => (
                          <p key={`${order.order_id}-${idx}`} className="text-sm text-muted-foreground">
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
                  <Button
                    onClick={() => printBill(bill)}
                    variant="outline"
                    className="w-full rounded-full"
                  >
                    <Receipt className="w-4 h-4 mr-2" />
                    Print Bill
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default BillingDashboard;
