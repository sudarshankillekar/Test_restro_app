import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../lib/api';
import { BACKEND_URL } from '../lib/config';

const AuthContext = createContext(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const checkAuth = useCallback(async () => {
    // CRITICAL: If returning from OAuth callback, skip the /me check.
    // AuthCallback will exchange the session_id and establish the session first.
    if (window.location.hash?.includes('session_id=')) {
      setLoading(false);
      return;
    }

    try {
      const response = await api.get(`/api/auth/me`);
      setUser(response.data);
    } catch (error) {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

 const login = async (email, password) => {
  const response = await api.post(`/api/auth/login`, {
    email,
    password,
  });
  localStorage.setItem("token", response.data.access_token);
  return response.data;
};

const register = async (email, password, name, role) => {
  const response = await api.post(`/api/auth/register`, {
    email,
    password,
    name,
    role,
  });

  // 🔥 If backend returns token (recommended)
  if (response.data.access_token) {
    localStorage.setItem("token", response.data.access_token);
  }

  setUser(response.data);
  return response.data;
};

 const logout = async () => {
  try {
    await api.post(`/api/auth/logout`);
  } catch (err) {
    // optional: ignore error (backend logout may not be required)
  }

  // 🔥 IMPORTANT
  localStorage.removeItem("token");
  setUser(null);
};

  const value = {
    user,
    setUser,
    loading,
    login,
    register,
    logout,
    checkAuth,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
