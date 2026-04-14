import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import { Switch } from '../components/ui/switch';
import { toast } from 'sonner';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { normalizeImageUrl } from '../lib/utils';
import { ChefHat, LogOut, Plus, TrendingUp, DollarSign, ShoppingBag, QrCode, Trash2, Download, Settings } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';

const ADMIN_TAB_KEY = 'admin-dashboard-active-tab';

const getErrorMessage = (error, fallback) => error.response?.data?.detail || fallback;

const AdminDashboard = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem(ADMIN_TAB_KEY) || 'analytics');
  
  // Analytics state
  const [analytics, setAnalytics] = useState(null);
  const [period, setPeriod] = useState('daily');
  const [exportFilters, setExportFilters] = useState({ start_date: '', end_date: '' });
  
  // Menu state
  const [categories, setCategories] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [newCategory, setNewCategory] = useState('');
  const [newItem, setNewItem] = useState({
    name: '',
    category_id: '',
    price: '',
    description: '',
    image: '',
  });
  
  // Tables state
  const [tables, setTables] = useState([]);
  const [newTableNumber, setNewTableNumber] = useState('');
  const [selectedTable, setSelectedTable] = useState(null);
  
  // Staff state
  const [staff, setStaff] = useState([]);
  const [newStaff, setNewStaff] = useState({
    email: '',
    password: '',
    name: '',
    role: 'kitchen'
  });
  const [restaurantProfile, setRestaurantProfile] = useState({
    name: '',
    gst_number: '',
  });

  useEffect(() => {
    if (activeTab === 'analytics') fetchAnalytics();
    if (activeTab === 'menu') fetchMenu();
    if (activeTab === 'tables') fetchTables();
    if (activeTab === 'staff') fetchStaff();
    if (activeTab === 'settings') fetchRestaurantProfile();
  }, [activeTab, period]);

  useEffect(() => {
    localStorage.setItem(ADMIN_TAB_KEY, activeTab);
  }, [activeTab]);

  const fetchAnalytics = async () => {
    try {
      const response = await api.get(`/api/analytics/dashboard?period=${period}`, {
        withCredentials: true,
      });
      setAnalytics(response.data);
    } catch (error) {
      toast.error('Failed to load analytics');
    }
  };

  const fetchMenu = async () => {
    try {
      const [catRes, itemsRes] = await Promise.all([
        api.get(`/api/menu/categories`),
        api.get(`/api/menu/items`),
      ]);
      setCategories(catRes.data);
      setMenuItems(itemsRes.data);
    } catch (error) {
      toast.error('Failed to load menu');
    }
  };

  const fetchTables = async () => {
    try {
      const response = await api.get(`/api/tables`, {
        withCredentials: true,
      });
      setTables(response.data);
    } catch (error) {
      toast.error('Failed to load tables');
    }
  };

  const createCategory = async () => {
    if (!newCategory.trim()) {
      toast.error('Please enter a category name.');
      return;
    }

    try {
      await api.post(
        `/api/menu/categories`,
        { name: newCategory }
      );
      toast.success('Category created');
      setNewCategory('');
      fetchMenu();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to create category'));
    }
  };

  const createMenuItem = async () => {
    if (!newItem.name.trim()) {
      toast.error('Please enter an item name.');
      return;
    }
    if (!newItem.category_id) {
      toast.error('Please select a category.');
      return;
    }
    if (!newItem.price || Number(newItem.price) <= 0) {
      toast.error('Please enter a valid item price.');
      return;
    }
    try {
      await api.post(
        `/api/menu/items`,
        { ...newItem, price: parseFloat(newItem.price) }
      );
      toast.success('Menu item created');
      setNewItem({ name: '', category_id: '', price: '', description: '', image: '' });
      fetchMenu();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to create menu item'));
    }
  };

  const toggleItemAvailability = async (itemId, available) => {
    try {
      await api.put(
        `/api/menu/items/${itemId}`,
        { available: !available }
      );
      fetchMenu();
    } catch (error) {
      toast.error('Failed to update item');
    }
  };

  const deleteMenuItem = async (itemId) => {
    if (!window.confirm('Delete this item?')) return;
    try {
      await api.delete(`/api/menu/items/${itemId}`, {
        withCredentials: true,
      });
      toast.success('Item deleted');
      fetchMenu();
    } catch (error) {
      toast.error('Failed to delete item');
    }
  };

  const createTable = async () => {
    if (!newTableNumber.trim()) {
      toast.error('Please add one table number to create QR code.');
      return;
    }
    if (Number(newTableNumber) <= 0) {
      toast.error('Please enter a valid table number.');
      return;
    }
    if (tables.some((table) => table.table_number === Number(newTableNumber))) {
      toast.error(`Table number ${newTableNumber} already exists.`);
      return;
    }

    try {
      await api.post(
        `/api/tables`,
        { table_number: parseInt(newTableNumber) }
      );
      toast.success('Table created');
      setNewTableNumber('');
      fetchTables();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to create table'));
    }
  };

  const exportSales = async () => {
    try {
      const response = await api.get(`/api/analytics/export`, {
        params: exportFilters,
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
      toast.error(getErrorMessage(error, 'Failed to export sales data'));
    }
  };

  const deleteTable = async (tableId) => {
    if (!window.confirm('Delete this table and its QR code?')) return;
    try {
      await api.delete(`/api/tables/${tableId}`, {
        withCredentials: true,
      });
      toast.success('Table deleted');
      fetchTables();
    } catch (error) {
      toast.error('Failed to delete table');
    }
  };

  const fetchStaff = async () => {
    try {
      const response = await api.get(`/api/admin/staff`, {
        withCredentials: true,
      });
      setStaff(response.data);
    } catch (error) {
      toast.error('Failed to load staff');
    }
  };

  const fetchRestaurantProfile = async () => {
    try {
      const response = await api.get(`/api/restaurant/profile`, {
        withCredentials: true,
      });
      setRestaurantProfile({
        name: response.data.name || '',
        gst_number: response.data.gst_number || '',
      });
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to load restaurant settings'));
    }
  };

  const saveRestaurantProfile = async () => {
    try {
      const response = await api.put(
        `/api/restaurant/profile`,
        { gst_number: restaurantProfile.gst_number.trim() }
      );
      setRestaurantProfile({
        name: response.data.name || '',
        gst_number: response.data.gst_number || '',
      });
      toast.success('Restaurant settings updated');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to update restaurant settings'));
    }
  };

  const createStaff = async () => {
    try {
      await api.post(
        `/api/admin/staff`,
        newStaff
      );
      toast.success('Staff member created');
      setNewStaff({ email: '', password: '', name: '', role: 'kitchen' });
      fetchStaff();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to create staff');
    }
  };

  const deleteStaff = async (email) => {
    if (!window.confirm('Delete this staff member?')) return;
    try {
      await api.delete(`/api/admin/staff/${email}`, {
        withCredentials: true,
      });
      toast.success('Staff member deleted');
      fetchStaff();
    } catch (error) {
      toast.error('Failed to delete staff');
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const downloadQR = (tableId) => {
    const canvas = document.getElementById(`qr-${tableId}`);
    const url = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `table-${tableId}-qr.png`;
    link.href = url;
    link.click();
  };

  return (
    <div className="min-h-screen" style={{ background: '#F3F4F6' }}>
      <div className="bg-white border-b border-border sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <ChefHat className="w-8 h-8 text-primary" />
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Admin Dashboard</h1>
              <p className="text-sm text-muted-foreground">Welcome, {user?.name}</p>
              {user?.restaurant_name && (
                <p className="text-xs sm:text-sm text-muted-foreground truncate">{user.restaurant_name}</p>
              )}
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
          <TabsList className="bg-white rounded-2xl sm:rounded-full p-1 border border-border mb-6 grid grid-cols-2 sm:grid-cols-3 lg:flex h-auto gap-1">
            <TabsTrigger value="analytics" className="rounded-full" data-testid="tab-analytics">
              <TrendingUp className="w-4 h-4 mr-2" />
              Analytics
            </TabsTrigger>
            <TabsTrigger value="menu" className="rounded-full" data-testid="tab-menu">
              <ShoppingBag className="w-4 h-4 mr-2" />
              Menu
            </TabsTrigger>
            <TabsTrigger value="tables" className="rounded-full" data-testid="tab-tables">
              <QrCode className="w-4 h-4 mr-2" />
              Tables
            </TabsTrigger>
            <TabsTrigger value="staff" className="rounded-full" data-testid="tab-staff">
              <ChefHat className="w-4 h-4 mr-2" />
              Staff
            </TabsTrigger>
            <TabsTrigger value="settings" className="rounded-full" data-testid="tab-settings">
              <Settings className="w-4 h-4 mr-2" />
              Settings
            </TabsTrigger>
          </TabsList>

          <TabsContent value="analytics" className="space-y-6">
            <div className="flex flex-col sm:flex-row gap-4 items-stretch sm:items-center">
              <Select value={period} onValueChange={setPeriod}>
                <SelectTrigger className="w-40 rounded-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 w-full">
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
                <Button
                  onClick={exportSales}
                  variant="outline"
                  className="rounded-full"
                >
                  <Download className="w-4 h-4 mr-2" />
                  Export Excel
                </Button>
              </div>
            </div>

            {analytics && (
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 sm:gap-6">
                <Card className="border-border rounded-2xl">
                  <CardHeader>
                    <CardTitle className="text-sm text-muted-foreground">Total Orders</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-4xl font-bold font-mono">{analytics.total_orders}</p>
                  </CardContent>
                </Card>
                <Card className="border-border rounded-2xl">
                  <CardHeader>
                    <CardTitle className="text-sm text-muted-foreground">Revenue</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-4xl font-bold font-mono text-success">₹{analytics.total_revenue.toFixed(2)}</p>
                  </CardContent>
                </Card>
                <Card className="border-border rounded-2xl">
                  <CardHeader>
                    <CardTitle className="text-sm text-muted-foreground">Avg Order Value</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-4xl font-bold font-mono">₹{analytics.avg_order_value.toFixed(2)}</p>
                  </CardContent>
                </Card>
                <Card className="border-border rounded-2xl">
                  <CardHeader>
                    <CardTitle className="text-sm text-muted-foreground">Occupied Tables</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-4xl font-bold font-mono">{analytics.occupied_tables || 0}</p>
                  </CardContent>
                </Card>
                <Card className="border-border rounded-2xl">
                  <CardHeader>
                    <CardTitle className="text-sm text-muted-foreground">Empty Tables</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-4xl font-bold font-mono">{analytics.empty_tables || 0}</p>
                  </CardContent>
                </Card>
                <Card className="border-border rounded-2xl">
                  <CardHeader>
                    <CardTitle className="text-sm text-muted-foreground">Most Selling Item</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-xl font-bold">{analytics.best_seller?.name || 'No sales yet'}</p>
                    {analytics.best_seller && (
                      <p className="text-sm text-muted-foreground">{analytics.best_seller.quantity} qty sold</p>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}

            {analytics?.top_items && analytics.top_items.length > 0 && (
              <Card className="border-border rounded-2xl">
                <CardHeader>
                  <CardTitle>Top Selling Items</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {analytics.top_items.map((item, idx) => (
                        <div key={idx} className="flex items-center justify-between p-3 bg-accent rounded-xl">
                        <div>
                          <p className="font-semibold">{item.name}</p>
                          <p className="text-sm text-muted-foreground">{item.quantity} qty sold</p>
                        </div>
                        <p className="font-bold text-primary">₹{item.revenue.toFixed(2)}</p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {analytics?.recent_sales && analytics.recent_sales.length > 0 && (
              <Card className="border-border rounded-2xl">
                <CardHeader>
                  <CardTitle>Items Sold</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {analytics.recent_sales.map((sale, idx) => (
                      <div key={`${sale.order_id}-${idx}`} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between p-3 bg-accent rounded-xl">
                        <div className="min-w-0">
                          <p className="font-semibold">{sale.item_name}</p>
                          <p className="text-sm text-muted-foreground">
                            {sale.table_number ? `Table ${sale.table_number}` : sale.table_id} • {sale.quantity} qty
                          </p>
                        </div>
                        <p className="text-sm font-medium">
                          {new Date(sale.sold_at).toLocaleString()}
                        </p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="menu" className="space-y-6">
            <Card className="border-border rounded-2xl">
              <CardHeader>
                <CardTitle>Add Category</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col sm:flex-row gap-2">
                <Input
                  placeholder="Category name"
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  className="rounded-full"
                  data-testid="category-name-input"
                />
                <Button
                  onClick={createCategory}
                  className="rounded-full bg-primary hover:bg-[#C54E2C]"
                  data-testid="add-category-button"
                >
                  <Plus className="w-4 h-4 mr-1" />
                  Add
                </Button>
              </CardContent>
            </Card>

            <Card className="border-border rounded-2xl">
              <CardHeader>
                <CardTitle>Add Menu Item</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Name</Label>
                    <Input
                      value={newItem.name}
                      onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
                      className="rounded-full"
                      data-testid="item-name-input"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Category</Label>
                    <Select value={newItem.category_id} onValueChange={(val) => setNewItem({ ...newItem, category_id: val })}>
                      <SelectTrigger className="rounded-full" data-testid="item-category-select">
                        <SelectValue placeholder="Select category" />
                      </SelectTrigger>
                      <SelectContent>
                        {categories.map((cat) => (
                          <SelectItem key={cat.category_id} value={cat.category_id}>
                            {cat.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Price</Label>
                    <Input
                      type="number"
                      value={newItem.price}
                      onChange={(e) => setNewItem({ ...newItem, price: e.target.value })}
                      className="rounded-full"
                      data-testid="item-price-input"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Image URL</Label>
                    <Input
                      value={newItem.image}
                      onChange={(e) => setNewItem({ ...newItem, image: e.target.value })}
                      className="rounded-full"
                      data-testid="item-image-input"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Description</Label>
                  <Input
                    value={newItem.description}
                    onChange={(e) => setNewItem({ ...newItem, description: e.target.value })}
                    className="rounded-full"
                    placeholder="Optional"
                    data-testid="item-description-input"
                  />
                </div>
                <Button
                  onClick={createMenuItem}
                  className="w-full rounded-full bg-primary hover:bg-[#C54E2C]"
                  data-testid="add-item-button"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add Menu Item
                </Button>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 auto-rows-fr">
              {menuItems.map((item) => (
                <Card key={item.item_id} className="border-border rounded-2xl h-full" data-testid={`menu-item-card-${item.item_id}`}>
                  {item.image && (
                    <div className="h-32 overflow-hidden rounded-t-2xl">
                      <img
                        src={normalizeImageUrl(item.image)}
                        alt={item.name}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                    </div>
                  )}
                  <CardContent className="p-4 space-y-3 h-full flex flex-col">
                    <div className="min-w-0">
                      <h3 className="font-semibold text-lg break-words">{item.name}</h3>
                      <p className="text-sm text-muted-foreground break-words min-h-10">{item.description || 'No description added'}</p>
                    </div>
                    <div className="flex items-center justify-between gap-3 mt-auto">
                      <p className="text-xl font-bold text-primary">₹{item.price}</p>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={item.available}
                          onCheckedChange={() => toggleItemAvailability(item.item_id, item.available)}
                          data-testid={`toggle-available-${item.item_id}`}
                        />
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-8 w-8 p-0 rounded-full"
                          onClick={() => deleteMenuItem(item.item_id)}
                          data-testid={`delete-item-${item.item_id}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="tables" className="space-y-6">
            <Card className="border-border rounded-2xl">
              <CardHeader>
                <CardTitle>Add Table</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col sm:flex-row gap-2">
                <Input
                  type="number"
                  placeholder="Table number"
                  value={newTableNumber}
                  onChange={(e) => setNewTableNumber(e.target.value)}
                  className="rounded-full"
                  data-testid="table-number-input"
                />
                <Button
                  onClick={createTable}
                  className="rounded-full bg-primary hover:bg-[#C54E2C]"
                  data-testid="add-table-button"
                >
                  <Plus className="w-4 h-4 mr-1" />
                  Add
                </Button>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
              {tables.map((table) => (
                <Card key={table.table_id} className="border-border rounded-2xl" data-testid={`table-card-${table.table_id}`}>
                  <CardHeader>
                    <CardTitle>Table {table.table_number}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex justify-center p-4 bg-white rounded-xl">
                      <QRCodeCanvas
                        id={`qr-${table.table_id}`}
                        value={table.qr_code}
                        size={150}
                        level="H"
                      />
                    </div>
                    <div className="space-y-2">
                      <Button
                        onClick={() => downloadQR(table.table_id)}
                        variant="outline"
                        className="w-full rounded-full"
                        data-testid={`download-qr-${table.table_id}`}
                      >
                        <QrCode className="w-4 h-4 mr-2" />
                        Download QR
                      </Button>
                      <Button
                        onClick={() => deleteTable(table.table_id)}
                        variant="destructive"
                        className="w-full rounded-full"
                        data-testid={`delete-table-${table.table_id}`}
                      >
                        <Trash2 className="w-4 h-4 mr-2" />
                        Delete Table
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="staff" className="space-y-6">
            <Card className="border-border rounded-2xl">
              <CardHeader>
                <CardTitle>Add Staff Member</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Name</Label>
                    <Input
                      value={newStaff.name}
                      onChange={(e) => setNewStaff({ ...newStaff, name: e.target.value })}
                      className="rounded-full"
                      placeholder="John Doe"
                      data-testid="staff-name-input"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Email</Label>
                    <Input
                      type="email"
                      value={newStaff.email}
                      onChange={(e) => setNewStaff({ ...newStaff, email: e.target.value })}
                      className="rounded-full"
                      placeholder="staff@restaurant.com"
                      data-testid="staff-email-input"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Password</Label>
                    <Input
                      type="password"
                      value={newStaff.password}
                      onChange={(e) => setNewStaff({ ...newStaff, password: e.target.value })}
                      className="rounded-full"
                      placeholder="••••••••"
                      data-testid="staff-password-input"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Role</Label>
                    <Select value={newStaff.role} onValueChange={(val) => setNewStaff({ ...newStaff, role: val })}>
                      <SelectTrigger className="rounded-full" data-testid="staff-role-select">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="kitchen">Kitchen Staff</SelectItem>
                        <SelectItem value="billing">Billing Counter</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <Button
                  onClick={createStaff}
                  className="w-full rounded-full bg-primary hover:bg-[#C54E2C]"
                  data-testid="add-staff-button"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add Staff Member
                </Button>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
              {staff.map((member) => (
                <Card key={member.email} className="border-border rounded-2xl" data-testid={`staff-card-${member.email}`}>
                  <CardContent className="p-6 space-y-4">
                    <div>
                      <h3 className="font-semibold text-lg">{member.name}</h3>
                      <p className="text-sm text-muted-foreground">{member.email}</p>
                      <p className="text-xs text-muted-foreground mt-1 capitalize">
                        {member.role === 'kitchen' ? 'Kitchen Staff' : 'Billing Counter'}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="destructive"
                      className="w-full rounded-full"
                      onClick={() => deleteStaff(member.email)}
                      data-testid={`delete-staff-${member.email}`}
                    >
                      <Trash2 className="w-4 h-4 mr-1" />
                      Remove
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="settings" className="space-y-6">
            <Card className="border-border rounded-2xl">
              <CardHeader>
                <CardTitle>Restaurant Settings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Restaurant Name</Label>
                    <Input
                      value={restaurantProfile.name}
                      disabled
                      className="rounded-full bg-accent"
                    />
                    <p className="text-xs text-muted-foreground">
                      This name will be printed on the customer bill.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>GST Number</Label>
                    <Input
                      value={restaurantProfile.gst_number}
                      onChange={(e) => setRestaurantProfile((prev) => ({ ...prev, gst_number: e.target.value }))}
                      className="rounded-full"
                      placeholder="Optional GST number"
                      data-testid="restaurant-gst-input"
                    />
                    <p className="text-xs text-muted-foreground">
                      Optional. It will print on the bill only when provided.
                    </p>
                  </div>
                </div>
                <Button
                  onClick={saveRestaurantProfile}
                  className="rounded-full bg-primary hover:bg-[#C54E2C]"
                  data-testid="save-restaurant-settings"
                >
                  Save Settings
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
};

export default AdminDashboard;
