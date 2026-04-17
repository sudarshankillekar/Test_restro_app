import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { toast } from 'sonner';
import api from '../lib/api';
import { Loader2, ChefHat, User, Phone } from 'lucide-react';

const CustomerLanding = () => {
  const { tableId } = useParams();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  // If a valid session already exists for this table, skip the form
  useEffect(() => {
    const checkExistingSession = async () => {
      const sessionToken = localStorage.getItem('customer_session');
      const storedTableId = localStorage.getItem('session_table_id');

      if (sessionToken && storedTableId === tableId) {
        try {
          await api.get(`/api/customer/session/${sessionToken}`);
          // Session is still valid — go straight to menu
          navigate(`/customer/${tableId}/menu`, { replace: true });
          return;
        } catch {
          // Session invalid/expired — clear and show form
          localStorage.removeItem('customer_session');
          localStorage.removeItem('restaurant_id');
          localStorage.removeItem('session_table_id');
        }
      }

      setCheckingSession(false);
    };

    checkExistingSession();
  }, [tableId, navigate]);

  const handlePhoneChange = (e) => {
    // Allow digits only, max 10 chars
    const val = e.target.value.replace(/\D/g, '').slice(0, 10);
    setPhone(val);
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error('Please enter your name');
      return;
    }
    if (phone.length < 10) {
      toast.error('Please enter a valid 10-digit phone number');
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.post('/api/customer/session', {
        table_id: tableId,
        customer_name: name.trim(),
        customer_phone: phone,
      });

      const { session_token, restaurant_id } = res.data;

      localStorage.setItem('customer_session', session_token);
      localStorage.setItem('session_table_id', tableId);
      if (restaurant_id) {
        localStorage.setItem('restaurant_id', restaurant_id);
      }

      toast.success(`Welcome, ${name.trim()}! 🎉`);
      navigate(`/customer/${tableId}/menu`);
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to start session. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSubmit();
  };

  if (checkingSession) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#F9F8F6' }}>
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: '#F9F8F6' }}
    >
      <div className="w-full max-w-sm">
        {/* Logo / Title */}
        <div className="flex flex-col items-center mb-8 gap-3">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
            <ChefHat className="w-9 h-9 text-primary" />
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold tracking-tight">Welcome!</h1>
            <p className="text-sm text-muted-foreground mt-1">Table {tableId} &middot; Please introduce yourself</p>
          </div>
        </div>

        {/* Form Card */}
        <Card className="rounded-[28px] border border-border bg-white p-6 shadow-[0_10px_30px_rgba(0,0,0,0.07)]">
          <div className="space-y-5">
            {/* Name Field */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground" htmlFor="customer-name">
                Your Name
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <input
                  id="customer-name"
                  type="text"
                  placeholder="e.g. Ravi Kumar"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={handleKeyDown}
                  autoFocus
                  className="w-full pl-10 pr-4 py-3 rounded-xl border border-border bg-[#F9F8F6] text-sm outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
                />
              </div>
            </div>

            {/* Phone Field */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground" htmlFor="customer-phone">
                Phone Number
              </label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <input
                  id="customer-phone"
                  type="tel"
                  inputMode="numeric"
                  placeholder="10-digit mobile number"
                  value={phone}
                  onChange={handlePhoneChange}
                  onKeyDown={handleKeyDown}
                  className="w-full pl-10 pr-4 py-3 rounded-xl border border-border bg-[#F9F8F6] text-sm outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
                />
              </div>
              <p className="text-xs text-muted-foreground pl-1">
                {phone.length}/10 digits
              </p>
            </div>

            {/* Submit */}
            <Button
              onClick={handleSubmit}
              disabled={submitting}
              className="w-full rounded-full bg-primary hover:bg-[#C54E2C] text-white text-base py-6 mt-2"
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Starting session...
                </>
              ) : (
                'View Menu'
              )}
            </Button>
          </div>
        </Card>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Your details are only used for this dining session.
        </p>
      </div>
    </div>
  );
};

export default CustomerLanding;
