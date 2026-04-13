import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { toast } from 'sonner';
import axios from 'axios';
import { BACKEND_URL } from '../lib/config';
import { ChefHat, Loader2 } from 'lucide-react';

const CustomerLanding = () => {
  const { tableId } = useParams();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);

  const handleStart = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      const response = await axios.post(`${BACKEND_URL}/api/customer/session`, {
        table_id: tableId,
        customer_name: name,
        phone: phone,
      });

      localStorage.setItem('customer_session', response.data.session_token);
      localStorage.setItem('table_id', response.data.table_id);
      localStorage.setItem('customer_name', name);
      localStorage.setItem('restaurant_id', response.data.restaurant_id);

      toast.success('Welcome! Browse our menu');
      navigate(`/customer/${tableId}/menu`);
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to start session');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: '#F9F8F6' }}>
      <Card className="w-full max-w-md shadow-[0_2px_10px_rgba(0,0,0,0.05)] border-border rounded-2xl">
        <CardHeader className="space-y-1 text-center">
          <div className="flex justify-center mb-4">
            <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
              <ChefHat className="w-10 h-10 text-primary" />
            </div>
          </div>
          <CardTitle className="text-4xl font-bold tracking-tight">Welcome!</CardTitle>
          <CardDescription className="text-base">Let's get you started with ordering</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleStart} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name" data-testid="customer-name-label">Your Name</Label>
              <Input
                id="name"
                type="text"
                placeholder="Enter your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                data-testid="customer-name-input"
                className="rounded-full border-border"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone" data-testid="customer-phone-label">Phone Number</Label>
              <Input
                id="phone"
                type="tel"
                placeholder="Enter your phone number"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
                data-testid="customer-phone-input"
                className="rounded-full border-border"
              />
            </div>
            <Button
              type="submit"
              className="w-full rounded-full bg-primary hover:bg-[#C54E2C] text-white transition-all duration-200 text-lg py-6"
              disabled={loading}
              data-testid="start-ordering-button"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Starting...
                </>
              ) : (
                'Start Ordering'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};

export default CustomerLanding;
