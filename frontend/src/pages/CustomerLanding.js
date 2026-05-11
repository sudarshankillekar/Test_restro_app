import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Loader2, Phone, QrCode, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import api from '../lib/api';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { normalizeImageUrl } from '../lib/utils';

const CustomerLanding = () => {
  const { tableId } = useParams();
  const navigate = useNavigate();
  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
   const [branding, setBranding] = useState({
    restaurant_name: '',
    customer_logo_url: '',
  });

  useEffect(() => {
    const loadBranding = async () => {
      try {
        const response = await api.get(`/api/customer/table/${tableId}/branding`);
        setBranding({
          restaurant_name: response.data.restaurant_name || '',
          customer_logo_url: response.data.customer_logo_url || '',
        });
      } catch (error) {
        setBranding({ restaurant_name: '', customer_logo_url: '' });
      }
    };

    loadBranding();
  }, [tableId]);

  useEffect(() => {
    const verifyExistingSession = async () => {
      const existingToken = localStorage.getItem('customer_session');
      const existingTableId = localStorage.getItem('customer_table_id');

      if (!existingToken || existingTableId !== tableId) {
        setCheckingSession(false);
        return;
      }

      try {
        const response = await api.get(`/api/customer/session/${existingToken}`);
        localStorage.setItem('restaurant_id', response.data.restaurant_id || '');
        navigate(`/customer/${tableId}/menu`, { replace: true });
      } catch (error) {
        localStorage.removeItem('customer_session');
        localStorage.removeItem('customer_table_id');
        localStorage.removeItem('restaurant_id');
      } finally {
        setCheckingSession(false);
      }
    };

    verifyExistingSession();
  }, [navigate, tableId]);

  const handleStartOrdering = async (event) => {
    event.preventDefault();

    const normalizedName = customerName.trim();
    const normalizedPhone = phone.trim();

    if (!normalizedName) {
      toast.error('Please enter your name');
      return;
    }

    if (!normalizedPhone) {
      toast.error('Please enter your phone number');
      return;
    }

    setSubmitting(true);
    try {
      const response = await api.post('/api/customer/session', {
        table_id: tableId,
        customer_name: normalizedName,
        phone: normalizedPhone,
      });

      localStorage.setItem('customer_session', response.data.session_token);
      localStorage.setItem('customer_table_id', tableId);
      localStorage.setItem('restaurant_id', response.data.restaurant_id || '');

      toast.success('Welcome! Menu is ready.');
      navigate(`/customer/${tableId}/menu`);
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to start customer session');
    } finally {
      setSubmitting(false);
    }
  };

  if (checkingSession) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#F9F8F6' }}>
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 py-10 sm:px-6" style={{ background: '#F9F8F6' }}>
      <div className="mx-auto max-w-lg">
        <Card className="rounded-[32px] border-border shadow-[0_16px_48px_rgba(0,0,0,0.07)]">
          <CardHeader className="space-y-4 text-center">
                        {branding.customer_logo_url ? (
              <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-full border-2 border-primary/20 bg-white p-2 shadow-[0_10px_26px_rgba(0,0,0,0.06)]">
                <img
                  src={normalizeImageUrl(branding.customer_logo_url)}
                  alt={branding.restaurant_name || 'Restaurant logo'}
                  className="h-full w-full rounded-full object-contain"
                />
              </div>
            ) : (
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                <QrCode className="h-8 w-8 text-primary" />
              </div>
            )}

            <div className="space-y-1">
              <CardTitle className="text-2xl tracking-tight">
                 {'Welcome to '+ branding.restaurant_name || 'Start Your Order'}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                 Scan successful. Enter your details to open the menu.
              </p>
            </div>
          </CardHeader>
          <CardContent>
            <form className="space-y-5" onSubmit={handleStartOrdering}>
              <div className="space-y-2">
                <Label htmlFor="customer-name">Name</Label>
                <div className="relative">
                  <UserRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="customer-name"
                    value={customerName}
                    onChange={(event) => setCustomerName(event.target.value)}
                    placeholder="Enter your name"
                    className="rounded-full pl-10"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="customer-phone">Phone Number</Label>
                <div className="relative">
                  <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="customer-phone"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    inputMode="tel"
                    placeholder="Enter your phone number"
                    className="rounded-full pl-10"
                  />
                </div>
              </div>

              <Button
                type="submit"
                disabled={submitting}
                className="w-full rounded-full bg-primary py-6 text-base text-white hover:bg-[#C54E2C]"
              >
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Opening Menu...
                  </>
                ) : (
                  'Continue to Menu'
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default CustomerLanding;
