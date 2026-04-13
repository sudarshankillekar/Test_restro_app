import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { toast } from 'sonner';
import api from '../lib/api';
import { BACKEND_URL } from '../lib/config';
import { Building2, CheckCircle, Loader2 } from 'lucide-react';

const RestaurantRegistration = () => {
  const navigate = useNavigate();
  const [formData, setFormData] = useState({
    name: '',
    owner_name: '',
    owner_email: '',
    owner_password: '',
    plan: 'BASIC'
  });
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      await axios.post(`${BACKEND_URL}/api/restaurants/register`, formData);
      setSuccess(true);
      toast.success('Registration submitted! Awaiting approval.');
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6" style={{ background: '#F9F8F6' }}>
        <Card className="w-full max-w-md shadow-[0_2px_10px_rgba(0,0,0,0.05)] border-border rounded-2xl text-center">
          <CardHeader>
            <div className="flex justify-center mb-4">
              <div className="w-20 h-20 rounded-full bg-success/10 flex items-center justify-center">
                <CheckCircle className="w-10 h-10 text-success" />
              </div>
            </div>
            <CardTitle className="text-2xl">Registration Submitted!</CardTitle>
            <CardDescription className="text-base">
              Your restaurant registration is pending super admin approval. You'll be notified once approved.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => navigate('/login')}
              className="w-full rounded-full bg-primary hover:bg-[#C54E2C]"
            >
              Go to Login
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: '#F9F8F6' }}>
      <Card className="w-full max-w-2xl shadow-[0_2px_10px_rgba(0,0,0,0.05)] border-border rounded-2xl">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <Building2 className="w-8 h-8 text-primary" />
            </div>
          </div>
          <CardTitle className="text-3xl font-bold tracking-tight">Register Your Restaurant</CardTitle>
          <CardDescription className="text-base">Join our QR ordering platform</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 space-y-2">
                <Label htmlFor="name">Restaurant Name *</Label>
                <Input
                  id="name"
                  type="text"
                  placeholder="The Food Palace"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
                  className="rounded-full border-border"
                  data-testid="restaurant-name-input"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="owner_name">Owner Name *</Label>
                <Input
                  id="owner_name"
                  type="text"
                  placeholder="John Doe"
                  value={formData.owner_name}
                  onChange={(e) => setFormData({ ...formData, owner_name: e.target.value })}
                  required
                  className="rounded-full border-border"
                  data-testid="owner-name-input"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="owner_email">Owner Email *</Label>
                <Input
                  id="owner_email"
                  type="email"
                  placeholder="owner@restaurant.com"
                  value={formData.owner_email}
                  onChange={(e) => setFormData({ ...formData, owner_email: e.target.value })}
                  required
                  className="rounded-full border-border"
                  data-testid="owner-email-input"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="owner_password">Password *</Label>
                <Input
                  id="owner_password"
                  type="password"
                  placeholder="••••••••"
                  value={formData.owner_password}
                  onChange={(e) => setFormData({ ...formData, owner_password: e.target.value })}
                  required
                  className="rounded-full border-border"
                  data-testid="owner-password-input"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="plan">Subscription Plan *</Label>
                <Select value={formData.plan} onValueChange={(val) => setFormData({ ...formData, plan: val })}>
                  <SelectTrigger className="rounded-full border-border" data-testid="plan-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="BASIC">BASIC - ₹1999/month</SelectItem>
                    <SelectItem value="PRO">PRO - ₹2599/month</SelectItem>
                    <SelectItem value="PREMIUM">PREMIUM - ₹3000/month</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="bg-blue-50 rounded-xl p-4 border border-blue-200">
              <p className="text-sm text-blue-900">
                Your registration will be reviewed by our team. Once approved, you'll receive an email and can start using the platform.
              </p>
            </div>

            <Button
              type="submit"
              className="w-full rounded-full bg-primary hover:bg-[#C54E2C] text-white text-lg py-6"
              disabled={loading}
              data-testid="submit-registration-button"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Submitting...
                </>
              ) : (
                'Submit Registration'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};

export default RestaurantRegistration;
