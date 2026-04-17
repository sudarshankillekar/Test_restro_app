import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../components/ui/accordion';
import { toast } from 'sonner';
import api from '../lib/api';
import { normalizeImageUrl } from '../lib/utils';
import { ShoppingCart, Plus, Minus, Loader2, ChefHat, Sparkles } from 'lucide-react';

const CustomerMenu = () => {
  const { tableId } = useParams();
  const navigate = useNavigate();
  const [categories, setCategories] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [cart, setCart] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const sessionToken = localStorage.getItem('customer_session');
    const storedTableId = localStorage.getItem('customer_table_id');

    if (!sessionToken || storedTableId !== tableId) {
      toast.error('Please scan the QR code again to continue.');
      navigate(`/customer/${tableId}`, { replace: true });
      return;
    }

    fetchMenu();
  }, [navigate, tableId]);

  const fetchMenu = async () => {
    try {
      const sessionToken = localStorage.getItem('customer_session') || '';
      const [catRes, itemsRes] = await Promise.all([
        api.get('/api/menu/categories', {
          params: {
            customer_session_token: sessionToken,
            table_id: tableId,
          },
        }),
        api.get('/api/menu/items', {
          params: {
            customer_session_token: sessionToken,
            table_id: tableId,
          },
        }),
      ]);
      
      setCategories(catRes.data);
      setMenuItems(itemsRes.data.filter(item => item.available));
      setLoading(false);
    } catch (error) {
      toast.error('Failed to load menu');
      setLoading(false);
    }
  };

  const addToCart = (item) => {
    const existing = cart.find((c) => c.item_id === item.item_id);
    if (existing) {
      setCart(cart.map((c) => c.item_id === item.item_id ? { ...c, quantity: c.quantity + 1 } : c));
    } else {
      setCart([...cart, { ...item, quantity: 1, instructions: '' }]);
    }
    toast.success(`${item.name} added to cart`);
  };

  const updateQuantity = (item_id, delta) => {
    setCart(cart.map((c) => {
      if (c.item_id === item_id) {
        const newQty = c.quantity + delta;
        return newQty > 0 ? { ...c, quantity: newQty } : null;
      }
      return c;
    }).filter(Boolean));
  };

  const placeOrder = async () => {
    if (cart.length === 0) {
      toast.error('Cart is empty');
      return;
    }

    const sessionToken = localStorage.getItem('customer_session');
    if (!sessionToken) {
      toast.error('Session expired');
      navigate(`/customer/${tableId}`);
      return;
    }

    setSubmitting(true);
    try {
      const orderItems = cart.map((c) => ({
        item_id: c.item_id,
        quantity: c.quantity,
        instructions: c.instructions || '',
      }));

      const response = await api.post(`/api/orders`, {
        customer_session_token: sessionToken,
        items: orderItems,
      });

      toast.success('Order placed successfully!');
      navigate(`/customer/order/${response.data.order_id}`);
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to place order');
    } finally {
      setSubmitting(false);
    }
  };

  const accordionCategories = categories.map((category) => ({
    ...category,
    items: menuItems.filter((item) => item.category_id === category.category_id),
  })).filter((category) => category.items.length > 0);

  const cartTotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#F9F8F6' }}>
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-32" style={{ background: '#F9F8F6' }}>
      {/* Header */}
      <div className="bg-white border-b border-border sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4">
          <div className="flex items-center gap-3">
            <ChefHat className="w-8 h-8 text-primary" />
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Our Menu</h1>
              <p className="text-sm text-muted-foreground">Table {tableId}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Menu Content */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="mb-6 rounded-[28px] border border-border bg-white p-5 shadow-[0_10px_30px_rgba(0,0,0,0.05)]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.24em] text-muted-foreground">Food Ordering</p>
              <h2 className="text-2xl font-semibold tracking-tight">Browse by category</h2>
            </div>
            <div className="flex items-center gap-2 rounded-full bg-primary/10 px-4 py-2 text-sm font-medium text-primary">
              <Sparkles className="h-4 w-4" />
              Freshly prepared for your table
            </div>
          </div>
        </div>

        <Accordion
          type="multiple"
          defaultValue={accordionCategories.slice(0, 2).map((category) => category.category_id)}
          className="space-y-4"
        >
          {accordionCategories.map((category) => (
            <AccordionItem
              key={category.category_id}
              value={category.category_id}
              className="rounded-[28px] border border-border bg-white px-5 shadow-[0_10px_30px_rgba(0,0,0,0.04)]"
            >
              <AccordionTrigger className="py-5 no-underline hover:no-underline">
                <div className="flex min-w-0 flex-1 items-center justify-between gap-4 pr-4">
                  <div className="min-w-0">
                    <h3 className="text-left text-xl font-semibold tracking-tight">{category.name}</h3>
                    <p className="text-left text-sm text-muted-foreground">{category.items.length} items</p>
                  </div>
                  <Badge className="rounded-full bg-accent text-foreground">{category.items.length}</Badge>
                </div>
              </AccordionTrigger>
              <AccordionContent className="pb-5">
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {category.items.map((item) => (
                    <Card
                      key={item.item_id}
                      className="overflow-hidden rounded-[24px] border border-border bg-[#FCFBF8] h-full"
                      data-testid={`menu-item-${item.item_id}`}
                    >
                      {item.image && (
                        <div className="h-44 overflow-hidden">
                          <img
                            src={normalizeImageUrl(item.image)}
                            alt={item.name}
                            className="h-full w-full object-cover"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                            }}
                          />
                        </div>
                      )}
                      <div className="flex h-full flex-col gap-4 p-4">
                        <div className="min-w-0">
                          <h4 className="text-lg font-semibold break-words">{item.name}</h4>
                          {item.description && (
                            <p className="mt-1 text-sm text-muted-foreground break-words">{item.description}</p>
                          )}
                        </div>
                        <div className="mt-auto flex items-center justify-between gap-3">
                          <p className="text-2xl font-bold text-primary">₹{item.price}</p>
                          <Button
                            onClick={() => addToCart(item)}
                            className="rounded-full bg-primary hover:bg-[#C54E2C] text-white"
                            data-testid={`add-to-cart-${item.item_id}`}
                          >
                            <Plus className="mr-1 h-4 w-4" />
                            Add
                          </Button>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>

        {accordionCategories.length === 0 && (
          <Card className="rounded-[28px] border border-border bg-white p-8 text-center shadow-[0_10px_30px_rgba(0,0,0,0.04)]">
            <h3 className="text-xl font-semibold tracking-tight">Menu not available</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              No available menu items were found for this restaurant yet.
            </p>
          </Card>
        )}
      </div>

      {/* Sticky Cart */}
      {cart.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white/70 backdrop-blur-xl border-t border-border p-4 z-20">
          <div className="max-w-6xl mx-auto">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <ShoppingCart className="w-5 h-5 text-primary" />
                <span className="font-semibold">{cart.length} items</span>
              </div>
              <span className="text-2xl font-bold text-primary">₹{cartTotal.toFixed(2)}</span>
            </div>
            <div className="space-y-2 mb-4 max-h-32 overflow-y-auto">
              {cart.map((item) => (
                <div key={item.item_id} className="flex items-center justify-between bg-white rounded-xl p-2 border border-border">
                  <span className="text-sm font-medium">{item.name}</span>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 w-7 p-0 rounded-full"
                      onClick={() => updateQuantity(item.item_id, -1)}
                      data-testid={`decrease-qty-${item.item_id}`}
                    >
                      <Minus className="w-3 h-3" />
                    </Button>
                    <span className="w-6 text-center font-semibold">{item.quantity}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 w-7 p-0 rounded-full"
                      onClick={() => updateQuantity(item.item_id, 1)}
                      data-testid={`increase-qty-${item.item_id}`}
                    >
                      <Plus className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <Button
              onClick={placeOrder}
              disabled={submitting}
              className="w-full rounded-full bg-primary hover:bg-[#C54E2C] text-white text-lg py-6"
              data-testid="place-order-button"
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Placing Order...
                </>
              ) : (
                'Place Order'
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default CustomerMenu;
