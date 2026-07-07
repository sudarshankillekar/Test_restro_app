import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { toast } from 'sonner';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { Crown, LogOut, Building2, TrendingUp, DollarSign, CheckCircle, XCircle, Clock, AlertTriangle, Download, Settings } from 'lucide-react';

const DEFAULT_ACCESS_CONFIG = {
  pos_enabled: true,
  kitchen_enabled: true,
  kitchen_tv_enabled: true,
  billing_enabled: true,
  waiter_enabled: true,
  kitchen_billing_enabled: true,
  staff_management_enabled: true,
  table_management_enabled: true,
  max_tables: '',
  max_staff: '',
};

const ACCESS_FLAGS = [
  { key: 'pos_enabled', label: 'POS Only' },
  { key: 'kitchen_enabled', label: 'Kitchen Staff' },
  { key: 'kitchen_tv_enabled', label: 'Kitchen TV Display' },
  { key: 'billing_enabled', label: 'Billing Staff' },
  { key: 'waiter_enabled', label: 'Waiter' },
  { key: 'kitchen_billing_enabled', label: 'Kitchen & Billing' },
  { key: 'staff_management_enabled', label: 'Staff Management' },
  { key: 'table_management_enabled', label: 'Table Management' },
];

const normalizeAccessConfig = (config = {}) => ({
  ...DEFAULT_ACCESS_CONFIG,
  ...config,
  max_tables: config?.max_tables ?? '',
  max_staff: config?.max_staff ?? '',
});

const SuperAdminDashboard = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [activeTab, setActiveTab] = useState('overview');
  const [restaurants, setRestaurants] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedRestaurant, setSelectedRestaurant] = useState(null);
  const [accessDialogOpen, setAccessDialogOpen] = useState(false);
  const [accessForm, setAccessForm] = useState(DEFAULT_ACCESS_CONFIG);
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
    subscription_amount: ''
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
        {
          ...newRestaurant,
          plan: 'CUSTOM',
          subscription_amount: Number(newRestaurant.subscription_amount),
        }
      );
      toast.success('Restaurant created successfully');
      setNewRestaurant({ name: '', owner_name: '', owner_email: '', owner_password: '', subscription_amount: '' });
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

  const openAccessDialog = (restaurant) => {
    setSelectedRestaurant(restaurant);
    setAccessForm(normalizeAccessConfig(restaurant.access_config));
    setAccessDialogOpen(true);
  };

  const updateAccessFlag = (key, value) => {
    setAccessForm((current) => ({ ...current, [key]: value }));
  };

  const saveRestaurantAccess = async () => {
    if (!selectedRestaurant) return;
    const payload = {
      ...accessForm,
      max_tables: accessForm.max_tables === '' ? null : Number(accessForm.max_tables),
      max_staff: accessForm.max_staff === '' ? null : Number(accessForm.max_staff),
    };
    if ((payload.max_tables !== null && payload.max_tables < 0) || (payload.max_staff !== null && payload.max_staff < 0)) {
      toast.error('Limits cannot be negative.');
      return;
    }

    try {
      await api.put(`/api/super-admin/restaurants/${selectedRestaurant.restaurant_id}`, {
        access_config: payload,
      });
      toast.success('Access configuration updated');
      setAccessDialogOpen(false);
      setSelectedRestaurant(null);
      fetchRestaurants();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to update access configuration');
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

  const getSubscriptionAmount = (restaurant) => {
    if (Number(restaurant.subscription_amount || 0) > 0) {
      return Number(restaurant.subscription_amount);
    }

    switch ((restaurant.plan || '').toUpperCase()) {
      case 'BASIC':
        return 1999;
      case 'PRO':
        return 2599;
      case 'PREMIUM':
        return 3000;
      default:
        return 0;
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
                    <Label>Subscription Amount</Label>
                    <Input
                      type="number"
                      min="1"
                      step="0.01"
                      value={newRestaurant.subscription_amount}
                      onChange={(e) => setNewRestaurant({ ...newRestaurant, subscription_amount: e.target.value })}
                      className="rounded-full"
                      placeholder="Enter custom monthly amount"
                      data-testid="subscription-amount-input"
                    />
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
              {restaurants.map((restaurant) => {
                const accessConfig = normalizeAccessConfig(restaurant.access_config);
                const enabledRoleLabels = ACCESS_FLAGS
                  .filter((flag) => !['staff_management_enabled', 'table_management_enabled'].includes(flag.key))
                  .filter((flag) => accessConfig[flag.key])
                  .map((flag) => flag.label);
                return (
                <Card key={restaurant.restaurant_id} className="border-border rounded-2xl" data-testid={`restaurant-card-${restaurant.restaurant_id}`}>
                  <CardContent className="p-6">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <h3 className="text-xl font-bold">{restaurant.name}</h3>
                          <Badge className={`${getStatusColor(restaurant.status)} text-white rounded-md`}>
                            {restaurant.status}
                          </Badge>
                          <Badge className="rounded-md bg-primary text-white">
                            ₹{getSubscriptionAmount(restaurant).toLocaleString()} / month
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
                        <div className="mt-4 space-y-2 text-sm">
                          <p className="text-muted-foreground">Access</p>
                          <div className="flex flex-wrap gap-2">
                            {enabledRoleLabels.map((label) => (
                              <Badge key={label} variant="outline" className="rounded-md">
                                {label}
                              </Badge>
                            ))}
                            {enabledRoleLabels.length === 0 && (
                              <Badge variant="outline" className="rounded-md border-destructive text-destructive">
                                No staff roles enabled
                              </Badge>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                            <span>Tables: {accessConfig.max_tables === '' ? 'Unlimited' : accessConfig.max_tables}</span>
                            <span>Staff: {accessConfig.max_staff === '' ? 'Unlimited' : accessConfig.max_staff}</span>
                            <span>Table setup: {accessConfig.table_management_enabled ? 'Enabled' : 'Disabled'}</span>
                            <span>Staff setup: {accessConfig.staff_management_enabled ? 'Enabled' : 'Disabled'}</span>
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
                          onClick={() => openAccessDialog(restaurant)}
                          className="rounded-full"
                        >
                          <Settings className="w-4 h-4 mr-1" />
                          Access
                        </Button>
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
                );
              })}
            </div>
          </TabsContent>

          <Dialog open={accessDialogOpen} onOpenChange={setAccessDialogOpen}>
            <DialogContent className="max-w-2xl rounded-2xl">
              <DialogHeader>
                <DialogTitle>Configure Access{selectedRestaurant ? ` - ${selectedRestaurant.name}` : ''}</DialogTitle>
              </DialogHeader>
              <div className="space-y-5">
                <div>
                  <p className="mb-3 text-sm font-semibold text-muted-foreground">Allowed Features</p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {ACCESS_FLAGS.map((flag) => (
                      <label key={flag.key} className="flex items-center justify-between rounded-xl border border-border bg-white px-4 py-3 text-sm font-semibold">
                        <span>{flag.label}</span>
                        <input
                          type="checkbox"
                          checked={Boolean(accessForm[flag.key])}
                          onChange={(event) => updateAccessFlag(flag.key, event.target.checked)}
                          className="h-5 w-5"
                        />
                      </label>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Max Tables</Label>
                    <Input
                      type="number"
                      min="0"
                      value={accessForm.max_tables}
                      onChange={(event) => updateAccessFlag('max_tables', event.target.value)}
                      placeholder="Unlimited"
                      className="rounded-full"
                    />
                    <p className="text-xs text-muted-foreground">Leave empty for unlimited. Use 0 to block new tables.</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Max Staff</Label>
                    <Input
                      type="number"
                      min="0"
                      value={accessForm.max_staff}
                      onChange={(event) => updateAccessFlag('max_staff', event.target.value)}
                      placeholder="Unlimited"
                      className="rounded-full"
                    />
                    <p className="text-xs text-muted-foreground">Counts restaurant staff roles only, not the owner admin.</p>
                  </div>
                </div>

                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full"
                    onClick={() => setAccessDialogOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    className="rounded-full bg-primary hover:bg-[#C54E2C]"
                    onClick={saveRestaurantAccess}
                  >
                    Save Access
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </Tabs>
      </div>
    </div>
  );
};

export default SuperAdminDashboard;
