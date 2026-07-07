import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { SocketProvider } from './contexts/SocketContext';
import { Toaster } from './components/ui/sonner';
import ProtectedRoute from './components/ProtectedRoute';

// Pages
import Login from './pages/Login';
import Register from './pages/Register';
import AuthCallback from './pages/AuthCallback';
import CustomerLanding from './pages/CustomerLanding';
import CustomerMenu from './pages/CustomerMenu';
import OrderTracking from './pages/OrderTracking';
import KitchenDashboard from './pages/KitchenDashboard';
import KitchenTVDisplay from './pages/KitchenTVDisplay';
import BillingDashboard from './pages/BillingDashboard';
import POSDashboard from './pages/POSDashboard';
import POSLogin from './pages/POSLogin';
import OperationsDashboard from './pages/OperationsDashboard';
import AdminDashboard from './pages/AdminDashboard';
import SuperAdminDashboard from './pages/SuperAdminDashboard';
import RestaurantRegistration from './pages/RestaurantRegistration';
import WaiterDashboard from './pages/WaiterPage';


function AppRouter() {
  const location = useLocation();
  
  // Check URL fragment (not query params) for session_id
  if (location.hash?.includes('session_id=')) {
    return <AuthCallback />;
  }
  
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/pos-login" element={<POSLogin />} />
      <Route path="/register" element={<Register />} />
      <Route path="/restaurant/register" element={<RestaurantRegistration />} />
      
      {/* Customer Routes */}
      <Route path="/customer/:tableId" element={<CustomerLanding />} />
      <Route path="/customer/:tableId/menu" element={<CustomerMenu />} />
      <Route path="/customer/order/:orderId" element={<OrderTracking />} />
      
      {/* Staff Routes */}
      <Route
        path="/kitchen"
        element={
          <ProtectedRoute allowedRoles={['kitchen', 'admin']}>
            <KitchenDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/kitchen-tv"
        element={
          <ProtectedRoute allowedRoles={['kitchen_tv', 'kitchen', 'admin', 'kitchen_billing']}>
            <KitchenTVDisplay />
          </ProtectedRoute>
        }
      />
      <Route
        path="/operations"
        element={
          <ProtectedRoute allowedRoles={['kitchen_billing']}>
            <OperationsDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/billing"
        element={
          <ProtectedRoute allowedRoles={['billing', 'admin']}>
            <BillingDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/pos"
        element={
          <ProtectedRoute allowedRoles={['pos']}>
            <POSDashboard />
          </ProtectedRoute>
        }
      />
      <Route
       path="/waiter"
        element={
          <ProtectedRoute allowedRoles={['waiter', 'admin']}>
            <WaiterDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin"
        element={
          <ProtectedRoute allowedRoles={['admin']}>
            <AdminDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/super-admin"
        element={
          <ProtectedRoute allowedRoles={['super_admin']}>
            <SuperAdminDashboard />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <SocketProvider>
          <AppRouter />
          <Toaster position="top-right" />
        </SocketProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
