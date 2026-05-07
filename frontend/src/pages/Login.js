import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { toast } from 'sonner';
import { Eye, EyeOff, Loader2, Lock, Mail, ShieldCheck } from 'lucide-react';

const formatApiErrorDetail = (detail) => {
  if (detail == null) return 'Something went wrong. Please try again.';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail))
    return detail
      .map((e) => (e && typeof e.msg === 'string' ? e.msg : JSON.stringify(e)))
      .filter(Boolean)
      .join(' ');
  if (detail && typeof detail.msg === 'string') return detail.msg;
  return String(detail);
};

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      const user = await login(email, password);
      toast.success('Login successful!');
      
      // Redirect based on role
      if (user.role === 'super_admin') {
        navigate('/super-admin');
      } else if (user.role === 'admin') {
        navigate('/admin');
      } else if (user.role === 'kitchen') {
        navigate('/kitchen');
      } else if (user.role === 'billing') {
        navigate('/billing');
      } else if (user.role === 'waiter') {
        navigate('/waiter');
      }  
    } catch (error) {
      const errorMsg = formatApiErrorDetail(error.response?.data?.detail) || error.message;
      toast.error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = () => {
    // REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
    const redirectUrl = window.location.origin + '/admin';
    window.location.href = `https://auth.emergentagent.com/?redirect=${encodeURIComponent(redirectUrl)}`;
  };

  return (
           <div
      className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-8 sm:px-6"
      style={{
        background: 'radial-gradient(circle at top, rgba(255,244,228,0.95) 0%, rgba(255,251,245,1) 46%, rgba(255,248,239,1) 100%)',
      }}
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-24 top-0 h-[520px] w-[360px] rounded-br-[180px] rounded-tr-[180px] bg-gradient-to-b from-[#FFB561] via-[#F48C47] to-[#EB6238] opacity-90 blur-[1px]" />
        <div className="absolute left-[-5rem] top-[15rem] h-52 w-52 rounded-full border-[22px] border-[#FFD98A] opacity-75" />
        <div className="absolute left-[8rem] top-[18rem] h-28 w-28 rounded-full border-[16px] border-[#F7B14D] opacity-75" />
        <div className="absolute left-[6rem] top-[8rem] h-80 w-80 rounded-full bg-white/18 blur-sm" />
        <div className="absolute right-14 top-24 grid grid-cols-4 gap-3 opacity-30">
          {Array.from({ length: 12 }).map((_, index) => (
            <span key={index} className="h-1.5 w-1.5 rounded-full bg-[#F4B369]" />
          ))}
        </div>
        <div className="absolute left-16 bottom-24 grid grid-cols-1 gap-3 opacity-35">
          {Array.from({ length: 4 }).map((_, index) => (
            <span key={index} className="h-1.5 w-1.5 rounded-full bg-[#F6BE75]" />
          ))}
        </div>
      </div>

      <Card className="relative z-10 w-full max-w-[440px] rounded-[28px] border border-white/70 bg-white/90 shadow-[0_24px_60px_rgba(231,118,55,0.18)] backdrop-blur-sm">
        <CardHeader className="space-y-2 px-6 pb-4 pt-8 text-center sm:px-10">
          <div className="mb-2 flex justify-center">
            <img
              src="/dineflo-logo.svg"
              alt="Dineflo logo"
              className="h-24 w-auto object-contain sm:h-28"
            />          
          </div>
          <CardTitle className="text-3xl font-bold tracking-tight">Welcome to Dineflo</CardTitle>
          <CardDescription className="text-base">Sign in to access your dashboard</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 px-6 pb-8 sm:px-10">
          <form onSubmit={handleLogin} className="space-y-5">
            <div className="space-y-2">
               <Label htmlFor="email" data-testid="email-label" className="text-base font-semibold text-slate-700">Email</Label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  id="email"
                  type="email"
                  placeholder="admin@restaurant.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  data-testid="email-input"
                  className="h-14 rounded-full border-[#F1D6B5] bg-white pl-11 pr-4 text-base shadow-[0_4px_12px_rgba(0,0,0,0.03)] focus-visible:ring-primary/40"
                />
              </div>
            </div>
           
              <Label htmlFor="password" data-testid="password-label" className="text-base font-semibold text-slate-700">Password</Label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  data-testid="password-input"
                  className="h-14 rounded-full border-[#F1D6B5] bg-white pl-11 pr-12 text-base shadow-[0_4px_12px_rgba(0,0,0,0.03)] focus-visible:ring-primary/40"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 transition-colors hover:text-slate-600"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button> 
            </div>
            <Button
              type="submit"
              className="mt-2 h-14 w-full rounded-full bg-gradient-to-r from-[#E45B31] to-[#F2A645] text-lg font-semibold text-white shadow-[0_16px_30px_rgba(228,91,49,0.28)] transition-all duration-200 hover:from-[#D8522A] hover:to-[#EA9A32]"
              disabled={loading}
              data-testid="login-button"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                'Sign In'
              )}
            </Button>
          </form>

            <p className="mt-1 text-center text-sm text-slate-400">
            Need staff access? <span className="font-semibold text-primary">Contact your restaurant admin</span>
          </p>

           <div className="flex items-center gap-4 pt-1">
            <div className="h-px flex-1 bg-[#F1E2CE]" />
            <div className="flex items-center gap-2 text-sm font-medium text-slate-400">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Secure. Simple. Smart.
            </div>
            <div className="h-px flex-1 bg-[#F1E2CE]" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default Login;
