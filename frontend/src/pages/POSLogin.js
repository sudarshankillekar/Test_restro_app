import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Loader2, Lock, Mail, Store } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { useAuth } from '../contexts/AuthContext';

const formatApiErrorDetail = (detail) => {
  if (detail == null) return 'Something went wrong. Please try again.';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((entry) => (entry && typeof entry.msg === 'string' ? entry.msg : JSON.stringify(entry)))
      .filter(Boolean)
      .join(' ');
  }
  if (detail && typeof detail.msg === 'string') return detail.msg;
  return String(detail);
};

const POSLogin = () => {
  const navigate = useNavigate();
  const { login, logout } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setLoading(true);

    try {
      const user = await login(email, password);
      if (user.role !== 'pos') {
        await logout();
        toast.error('This login is only for POS staff.');
        return;
      }
      toast.success('POS login successful.');
      navigate('/pos', { replace: true });
    } catch (error) {
      toast.error(formatApiErrorDetail(error.response?.data?.detail) || error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#f8f9fa] px-4 py-8">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,219,209,0.85),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(203,73,32,0.16),transparent_28%)]" />
      <Card className="relative z-10 w-full max-w-[430px] rounded-[28px] border border-[#e1bfb6]/60 bg-white/95 shadow-[0_24px_60px_rgba(169,49,7,0.14)]">
        <CardHeader className="space-y-3 px-7 pb-4 pt-8 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-[#a93107] text-white">
            <Store className="h-8 w-8" />
          </div>
          <CardTitle className="text-3xl font-black tracking-tight text-[#191c1d]">POS Login</CardTitle>
          <CardDescription className="text-base text-[#59413b]">Sign in to the billing terminal</CardDescription>
        </CardHeader>
        <CardContent className="px-7 pb-8">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="pos-email" className="text-sm font-bold text-[#59413b]">Email</Label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8d7169]" />
                <Input
                  id="pos-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="h-14 rounded-2xl border-[#e1bfb6] pl-11 text-base"
                  placeholder="pos@restaurant.com"
                  required
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="pos-password" className="text-sm font-bold text-[#59413b]">Password</Label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8d7169]" />
                <Input
                  id="pos-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-14 rounded-2xl border-[#e1bfb6] pl-11 pr-12 text-base"
                  placeholder="••••••••"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-[#8d7169]"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <Button
              type="submit"
              disabled={loading}
              className="h-14 w-full rounded-2xl bg-[#a93107] text-lg font-black text-white hover:bg-[#862200]"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Signing in...
                </>
              ) : 'Open POS'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};

export default POSLogin;
