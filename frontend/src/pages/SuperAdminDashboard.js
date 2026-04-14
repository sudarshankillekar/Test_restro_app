import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import { toast } from 'sonner';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { Crown, LogOut, Building2, TrendingUp, DollarSign, CheckCircle, XCircle, Clock, AlertTriangle, Download } from 'lucide-react';

const SuperAdminDashboard = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [activeTab, setActiveTab] = useState('overview');
  const [restaurants, setRestaurants] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedRestaurant, setSelectedRestaurant] = useState(null);
  const [exportFilters, setExportFilters] = useState({
    restaurant_id: 'all',
    start_date: '',
    end_date: '',
  });
  
  // New restaurant form
  const [newRestaurant, setNewRestaurant] = useState({
    name: '',
    owner_name: '',
    owner_email: '',
    owner_password: '',
    plan: 'BASIC'
  });

  useEffect(() => {
    if (activeTab === 'overview') fetchAnalytics();
    if (activeTab === 'overview' || activeTab === 'restaurants') fetchRestaurants();
  }, [activeTab]);

  const fetchRestaurants = async () => {
    try {
      const response = await api.get(`/api/super-admin/restaurants`, {
        withCredentials: true,
      });
      setRestaurants(response.data);
      setLoading(false);
    } catch (error) {
      toast.error('Failed to load restaurants');
      setLoading(false);
    }
  };

  const fetchAnalytics = async () => {
    try {
      const response = await api.get(`/api/super-admin/analytics`, {
        withCredentials: true,
      });
      setAnalytics(response.data);
      setLoading(false);
    } catch (error) {
      toast.error('Failed to load analytics');
      setLoading(false);
    }
  };

  const createRestaurant = async () => {
    try {
      await api.post(
        `/api/super-admin/restaurants`,
        newRestaurant
      );
      toast.success('Restaurant created successfully');
      setNewRestaurant({ name: '', owner_name: '', owner_email: '', owner_password: '', plan: 'BASIC' });
      fetchRestaurants();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to create restaurant');
    }
  };

  const updateRestaurantStatus = async (restaurantId, status) => {
    try {
      await api.put(
        `/api/super-admin/restaurants/${restaurantId}`,
        { status }
      );
      toast.success(`Restaurant ${status.toLowerCase()}`);
      fetchRestaurants();
    } catch (error) {
      toast.error('Failed to update restaurant');
    }
  };

  const extendSubscription = async (restaurantId, days) => {
    try {
      await api.post(
        `/api/super-admin/restaurants/${restaurantId}/extend`,
        { days }
      );
      toast.success(`Subscription extended by ${days} days`);
      fetchRestaurants();
    } catch (error) {
      toast.error('Failed to extend subscription');
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const exportSales = async () => {
    try {
      const params = {
        start_date: exportFilters.start_date || undefined,
        end_date: exportFilters.end_date || undefined,
        restaurant_id: exportFilters.restaurant_id === 'all' ? undefined : exportFilters.restaurant_id,
      };
      const response = await api.get(`/api/analytics/export`, {
        params,
        withCredentials: true,
        responseType: 'blob',
      });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      const disposition = response.headers['content-disposition'] || '';
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      link.href = url;
      link.download = filenameMatch?.[1] || 'sales-export.xlsx';
      link.click();
      window.URL.revokeObjectURL(url);
      toast.success('Sales export downloaded');
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to export sales data');
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'ACTIVE': return 'bg-success';
      case 'SUSPENDED': return 'bg-warning';
      case 'EXPIRED': return 'bg-destructive';
      default: return 'bg-gray-500';
    }
  };

  const getPlanColor = (plan) => {
    switch (plan) {
      case 'BASIC': return 'bg-blue-500';
      case 'PRO': return 'bg-purple-500';
      case 'PREMIUM': return 'bg-primary';
      default: return 'bg-gray-500';
    }
  };

  return (
    <div className="min-h-screen" style={{ background: '#F3F4F6' }}>
      <div className="bg-white border-b border-border sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <Crown className="w-8 h-8 text-yellow-500" />
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Super Admin Dashboard</h1>
              <p className="text-sm text-muted-foreground">Platform Management</p>
            </div>
          </div>
          <Button
            onClick={handleLogout}
            variant="outline"
            className="rounded-full border-border"
            data-testid="logout-button"
          >
            <LogOut className="w-4 h-4 mr-2" />
            Logout
          </Button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-4 sm:p-6">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="bg-white rounded-2xl sm:rounded-full p-1 border border-border mb-6 grid grid-cols-2 sm:flex h-auto gap-1">
            <TabsTrigger value="overview" className="rounded-full" data-testid="tab-overview">
              <TrendingUp className="w-4 h-4 mr-2" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="restaurants" className="rounded-full" data-testid="tab-restaurants">
              <Building2 className="w-4 h-4 mr-2" />
              Restaurants
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            {analytics && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 sm:gap-6">
                  <Card className="border-border rounded-2xl">
                    <CardHeader>
                      <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
                        <Building2 className="w-4 h-4" />
                        Total Restaurants
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-4xl font-bold font-mono">{analytics.total_restaurants}</p>
                    </CardContent>
                  </Card>
                  <Card className="border-border rounded-2xl">
                    <CardHeader>
                      <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
                        <CheckCircle className="w-4 h-4" />
                        Active
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-4xl font-bold font-mono text-success">{analytics.active_restaurants}</p>
                    </CardContent>
                  </Card>
                  <Card className="border-border rounded-2xl">
                    <CardHeader>
                      <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
                        <DollarSign className="w-4 h-4" />
                        MRR
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-4xl font-bold font-mono text-primary">₹{analytics.mrr.toLocaleString()}</p>
                    </CardContent>
                  </Card>
                  <Card className="border-border rounded-2xl">
                    <CardHeader>
                      <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4" />
                        Pending Approval
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-4xl font-bold font-mono text-warning">{analytics.pending_approval}</p>
                    </CardContent>
                  </Card>
                </div>

                <Card className="border-border rounded-2xl">
                  <CardHeader>
                    <CardTitle>Plan Distribution</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div className="p-4 bg-blue-50 rounded-xl border border-blue-200">
                        <p className="text-sm text-muted-foreground">BASIC</p>
                        <p className="text-3xl font-bold">{analytics.plan_distribution.BASIC}</p>
                      </div>
                      <div className="p-4 bg-purple-50 rounded-xl border border-purple-200">
                        <p className="text-sm text-muted-foreground">PRO</p>
                        <p className="text-3xl font-bold">{analytics.plan_distribution.PRO}</p>
                      </div>
                      <div className="p-4 bg-orange-50 rounded-xl border border-orange-200">
                        <p className="text-sm text-muted-foreground">PREMIUM</p>
                        <p className="text-3xl font-bold">{analytics.plan_distribution.PREMIUM}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-border rounded-2xl">
                  <CardHeader>
                    <CardTitle>Export Sales</CardTitle>
                  </CardHeader>
                  <CardContent className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                    <Select
                      value={exportFilters.restaurant_id}
                      onValueChange={(value) => setExportFilters((prev) => ({ ...prev, restaurant_id: value }))}
                    >
                      <SelectTrigger className="rounded-full">
                        <SelectValue placeholder="All restaurants" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All restaurants</SelectItem>
                        {restaurants.map((restaurant) => (
                          <SelectItem key={restaurant.restaurant_id} value={restaurant.restaurant_id}>
                            {restaurant.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="date"
                      value={exportFilters.start_date}
                      onChange={(e) => setExportFilters((prev) => ({ ...prev, start_date: e.target.value }))}
                      className="rounded-full"
                    />
                    <Input
                      type="date"
                      value={exportFilters.end_date}
                      onChange={(e) => setExportFilters((prev) => ({ ...prev, end_date: e.target.value }))}
                      className="rounded-full"
                    />
                    <Button onClick={exportSales} variant="outline" className="rounded-full">
                      <Download className="w-4 h-4 mr-2" />
                      Export Excel
                    </Button>
                  </CardContent>
                </Card>
              </>
            )}
          </TabsContent>

          <TabsContent value="restaurants" className="space-y-6">
            <Card className="border-border rounded-2xl">
              <CardHeader>
                <CardTitle>Create New Restaurant</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Restaurant Name</Label>
                    <Input
                      value={newRestaurant.name}
                      onChange={(e) => setNewRestaurant({ ...newRestaurant, name: e.target.value })}
                      className="rounded-full"
                      placeholder="The Food Palace"
                      data-testid="restaurant-name-input"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Owner Name</Label>
                    <Input
                      value={newRestaurant.owner_name}
                      onChange={(e) => setNewRestaurant({ ...newRestaurant, owner_name: e.target.value })}
                      className="rounded-full"
                      placeholder="John Doe"
                      data-testid="owner-name-input"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Owner Email</Label>
                    <Input
                      type="email"
                      value={newRestaurant.owner_email}
                      onChange={(e) => setNewRestaurant({ ...newRestaurant, owner_email: e.target.value })}
                      className="rounded-full"
                      placeholder="owner@restaurant.com"
                      data-testid="owner-email-input"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Password</Label>
                    <Input
                      type="password"
                      value={newRestaurant.owner_password}
                      onChange={(e) => setNewRestaurant({ ...newRestaurant, owner_password: e.target.value })}
                      className="rounded-full"
                      placeholder="••••••••"
                      data-testid="owner-password-input"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Plan</Label>
                    <Select value={newRestaurant.plan} onValueChange={(val) => setNewRestaurant({ ...newRestaurant, plan: val })}>
                      <SelectTrigger className="rounded-full" data-testid="plan-select">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="BASIC">BASIC - ₹1999/mo</SelectItem>
                        <SelectItem value="PRO">PRO - ₹2599/mo</SelectItem>
                        <SelectItem value="PREMIUM">PREMIUM - ₹3000/mo</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <Button
                  onClick={createRestaurant}
                  className="w-full rounded-full bg-primary hover:bg-[#C54E2C]"
                  data-testid="create-restaurant-button"
                >
                  Create Restaurant
                </Button>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 gap-4">
              {restaurants.map((restaurant) => (
                <Card key={restaurant.restaurant_id} className="border-border rounded-2xl" data-testid={`restaurant-card-${restaurant.restaurant_id}`}>
                  <CardContent className="p-6">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <h3 className="text-xl font-bold">{restaurant.name}</h3>
                          <Badge className={`${getStatusColor(restaurant.status)} text-white rounded-md`}>
                            {restaurant.status}
                          </Badge>
                          <Badge className={`${getPlanColor(restaurant.plan)} text-white rounded-md`}>
                            {restaurant.plan}
                          </Badge>
                          {restaurant.approval_pending && (
                            <Badge className="bg-yellow-500 text-white rounded-md">
                              <Clock className="w-3 h-3 mr-1" />
                              Pending Approval
                            </Badge>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-4 text-sm">
                          <div>
                            <p className="text-muted-foreground">Owner</p>
                            <p className="font-medium">{restaurant.owner?.name || 'N/A'}</p>
                            <p className="text-muted-foreground text-xs">{restaurant.owner_email}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">Subscription</p>
                            <p className="font-medium">
                              {restaurant.subscriptionEnd ? new Date(restaurant.subscriptionEnd).toLocaleDateString() : 'Not set'}
                            </p>
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-col gap-2">
                        {restaurant.status === 'SUSPENDED' && restaurant.approval_pending && (
                          <Button
                            size="sm"
                            onClick={() => updateRestaurantStatus(restaurant.restaurant_id, 'ACTIVE')}
                            className="rounded-full bg-success hover:bg-[#3E6648]"
                            data-testid={`approve-${restaurant.restaurant_id}`}
                          >
                            <CheckCircle className="w-4 h-4 mr-1" />
                            Approve
                          </Button>
                        )}
                        {restaurant.status === 'ACTIVE' && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => updateRestaurantStatus(restaurant.restaurant_id, 'SUSPENDED')}
                            className="rounded-full border-warning text-warning"
                            data-testid={`suspend-${restaurant.restaurant_id}`}
                          >
                            <XCircle className="w-4 h-4 mr-1" />
                            Suspend
                          </Button>
                        )}
                        {restaurant.status === 'SUSPENDED' && !restaurant.approval_pending && (
                          <Button
                            size="sm"
                            onClick={() => updateRestaurantStatus(restaurant.restaurant_id, 'ACTIVE')}
                            className="rounded-full bg-success hover:bg-[#3E6648]"
                            data-testid={`activate-${restaurant.restaurant_id}`}
                          >
                            Activate
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => extendSubscription(restaurant.restaurant_id, 30)}
                          className="rounded-full"
                          data-testid={`extend-${restaurant.restaurant_id}`}
                        >
                          Extend +30d
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
};

export default SuperAdminDashboard;
