import React, { useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../lib/api';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

const AuthCallback = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { setUser } = useAuth();
  const hasProcessed = useRef(false);

  useEffect(() => {
    if (hasProcessed.current) return;
    hasProcessed.current = true;

    const processSession = async () => {
      try {
        const hash = location.hash.substring(1);
        const params = new URLSearchParams(hash);
        const sessionId = params.get('session_id');

        if (!sessionId) {
          toast.error('Invalid authentication response');
          navigate('/login');
          return;
        }

        const response = await api.post(
          `/api/auth/google/session`,
          { session_id: sessionId }
        );
        
        if (response.data.access_token) {
          localStorage.setItem('token', response.data.access_token);
        } else {
          localStorage.removeItem('token');
        }

        setUser(response.data);
        toast.success('Login successful!');
        
        // Redirect to admin dashboard
        navigate('/admin', { replace: true, state: { user: response.data } });
      } catch (error) {
        console.error('Auth error:', error);
        toast.error(error.response?.data?.detail || 'Authentication failed');
        navigate('/login');
      }
    };

    processSession();
  }, [location, navigate, setUser]);

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#F9F8F6' }}>
      <div className="text-center space-y-4">
        <Loader2 className="h-12 w-12 animate-spin text-primary mx-auto" />
        <p className="text-lg text-foreground">Completing authentication...</p>
      </div>
    </div>
  );
};

export default AuthCallback;
