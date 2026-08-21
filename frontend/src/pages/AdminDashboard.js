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
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../components/ui/accordion';
import { toast } from 'sonner';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { normalizeImageUrl } from '../lib/utils';
import DietIndicator, { DIET_TYPES } from '../components/DietIndicator';
import { BarChart3, ChefHat, FileSpreadsheet, LogOut, Plus, TrendingUp, ShoppingBag, QrCode, Trash2, Download, Settings, Upload, Pencil, UserCheck, Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';

const ADMIN_TAB_KEY = 'admin-dashboard-active-tab';
const DEFAULT_ACCESS_CONFIG = {
  pos_enabled: true,
  kitchen_enabled: true,
  kitchen_tv_enabled: true,
  billing_enabled: true,
  waiter_enabled: true,
  kitchen_billing_enabled: true,
  staff_management_enabled: true,
  table_management_enabled: true,
  max_tables: null,
  max_staff: null,
};
const STAFF_ROLE_OPTIONS = [
  { value: 'kitchen', label: 'Kitchen Staff', accessKey: 'kitchen_enabled' },
  { value: 'kitchen_tv', label: 'Kitchen TV Display', accessKey: 'kitchen_tv_enabled' },
  { value: 'billing', label: 'Billing Counter', accessKey: 'billing_enabled' },
  { value: 'kitchen_billing', label: 'Kitchen + Billing', accessKey: 'kitchen_billing_enabled' },
  { value: 'waiter', label: 'Waiter', accessKey: 'waiter_enabled' },
  { value: 'pos', label: 'POS Only', accessKey: 'pos_enabled' },
];
const MENU_DIET_OPTIONS = ['veg', 'non_veg', 'egg', 'vegan'];
const getCancelledQuantity = (item = {}) => Math.max(Number(item.cancelled_quantity || 0), 0);
const getBillableQuantity = (item = {}) => Math.max(Number(item.quantity || 0) - getCancelledQuantity(item), 0);
const isLossItem = (item = {}) => ['loss', 'no_matching_order_found'].includes(item.reallocation_status);
const formatReallocationTarget = (item = {}) => {
  if (!item.reallocated_to_order_id) return '';
  const tableLabel = item.reallocated_to_table_label || item.reallocated_to_table || '';
  return tableLabel ? `${tableLabel} (${item.reallocated_to_order_id})` : item.reallocated_to_order_id;
};

const normalizeAccessConfig = (config = {}) => ({
  ...DEFAULT_ACCESS_CONFIG,
  ...(config || {}),
});

const getErrorMessage = (error, fallback) => error.response?.data?.detail || fallback;

const getIndiaDateInputValue = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const shiftDateInputValue = (dateValue, days) => {
  const date = new Date(`${dateValue}T00:00:00+05:30`);
  date.setDate(date.getDate() + days);
  return getIndiaDateInputValue(date);
};

const getReportPresetRange = (period) => {
  const today = getIndiaDateInputValue();
  if (period === 'weekly') {
    return { start_date: shiftDateInputValue(today, -6), end_date: today };
  }
  if (period === 'monthly') {
    return { start_date: `${today.slice(0, 8)}01`, end_date: today };
  }
  return { start_date: today, end_date: today };
};

const formatReportValue = (report) => {
  if (!report) return '-';
  if (report.value_type === 'currency') {
    return `₹${Number(report.value || 0).toFixed(2)}`;
  }
  if (report.value_type === 'percent') {
    return `${Number(report.value || 0).toFixed(2)}%`;
  }
  if (report.value_type === 'decimal') {
    return Number(report.value || 0).toFixed(2);
  }
  return String(report.value ?? '-');
};

const AdminDashboard = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem(ADMIN_TAB_KEY) || 'analytics');
  
  // Analytics state
  const [analytics, setAnalytics] = useState(null);
  const [period, setPeriod] = useState('daily');
  const [exportFilters, setExportFilters] = useState({ start_date: '', end_date: '' });
  const [orderSearchId, setOrderSearchId] = useState('');
  const [searchedOrder, setSearchedOrder] = useState(null);
  const [reports, setReports] = useState(null);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportFilters, setReportFilters] = useState({
    period: 'daily',
    ...getReportPresetRange('daily'),
  });
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
    diet_type: 'veg',
  });
  const [categoryImportFile, setCategoryImportFile] = useState(null);
  const [itemImportFile, setItemImportFile] = useState(null);
  const [categoryImporting, setCategoryImporting] = useState(false);
  const [itemImporting, setItemImporting] = useState(false);
  const [openMenuCategories, setOpenMenuCategories] = useState([]);
  const [brokenMenuImages, setBrokenMenuImages] = useState({});
  const [editingMenuItem, setEditingMenuItem] = useState(null);
  const [editingMenuItemDraft, setEditingMenuItemDraft] = useState({
    name: '',
    price: '',
    description: '',
    image: '',
    diet_type: 'veg',
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
    google_review_url: '',
    customer_logo_url: '',
    tax_enabled: true,
    tax_percentage: 5,
    service_charge_enabled: false,
    service_charge_percentage: 0,
    parcel_charge_enabled: false,
    parcel_charge: 0,
    access_config: DEFAULT_ACCESS_CONFIG,
  });
  const [attendanceKioskLink, setAttendanceKioskLink] = useState('');
  const [attendanceKioskLoading, setAttendanceKioskLoading] = useState(false);

  useEffect(() => {
    if (activeTab === 'analytics') fetchAnalytics();
    if (activeTab === 'menu') fetchMenu();
    if (activeTab === 'tables') fetchTables();
    if (activeTab === 'staff') fetchStaff();
    if (activeTab === 'reports') fetchReports();
    if (['tables', 'staff', 'settings'].includes(activeTab)) fetchRestaurantProfile();
    if (activeTab === 'settings') fetchAttendanceKioskLink();
  }, [activeTab, period, reportFilters.period, reportFilters.start_date, reportFilters.end_date]);

  useEffect(() => {
    localStorage.setItem(ADMIN_TAB_KEY, activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (categories.length) {
      setOpenMenuCategories(categories.slice(0, 3).map((category) => category.category_id));
    }
  }, [categories]);

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

  const fetchReports = async () => {
    setReportsLoading(true);
    try {
      const response = await api.get('/api/reports/summary', {
        params: reportFilters,
        withCredentials: true,
      });
      setReports(response.data);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to load reports'));
    } finally {
      setReportsLoading(false);
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
      setNewItem({ name: '', category_id: '', price: '', description: '', image: '', diet_type: 'veg' });
      fetchMenu();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to create menu item'));
    }
  };

  const downloadExcel = async (endpoint, fallbackFilename) => {
    try {
      const response = await api.get(endpoint, {
        withCredentials: true,
        responseType: 'blob',
      });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      const disposition = response.headers['content-disposition'] || '';
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      link.href = url;
      link.download = filenameMatch?.[1] || fallbackFilename;
      link.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to download Excel file'));
    }
  };

  const importCategories = async () => {
    if (!categoryImportFile) {
      toast.error('Please choose a categories Excel file.');
      return;
    }

    const formData = new FormData();
    formData.append('file', categoryImportFile);

    setCategoryImporting(true);
    try {
      const response = await api.post('/api/menu/categories/import', formData, {
        withCredentials: true,
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success(`Categories imported. Created: ${response.data.created}, Updated: ${response.data.updated}`);
      setCategoryImportFile(null);
      fetchMenu();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to import categories'));
    } finally {
      setCategoryImporting(false);
    }
  };

  const importMenuItems = async () => {
    if (!itemImportFile) {
      toast.error('Please choose a menu items Excel file.');
      return;
    }

    const formData = new FormData();
    formData.append('file', itemImportFile);

    setItemImporting(true);
    try {
      const response = await api.post('/api/menu/items/import', formData, {
        withCredentials: true,
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success(`Menu items imported. Created: ${response.data.created}, Updated: ${response.data.updated}`);
      setItemImportFile(null);
      fetchMenu();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to import menu items'));
    } finally {
      setItemImporting(false);
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

  const startEditMenuItem = (item) => {
    setEditingMenuItem(item);
    setEditingMenuItemDraft({
      name: item.name || '',
      price: String(item.price ?? ''),
      description: item.description || '',
      image: item.image || '',
      diet_type: item.diet_type || 'veg',
    });
  };

  const saveMenuItemEdit = async () => {
    if (!editingMenuItem) return;
    if (!editingMenuItemDraft.name.trim()) {
      toast.error('Please enter an item name.');
      return;
    }
    if (!editingMenuItemDraft.price || Number(editingMenuItemDraft.price) <= 0) {
      toast.error('Please enter a valid item price.');
      return;
    }

    try {
      await api.put(`/api/menu/items/${editingMenuItem.item_id}`, {
        name: editingMenuItemDraft.name.trim(),
        price: parseFloat(editingMenuItemDraft.price),
        description: editingMenuItemDraft.description,
        image: editingMenuItemDraft.image,
        diet_type: editingMenuItemDraft.diet_type || 'veg',
      });
      toast.success('Menu item updated');
      setEditingMenuItem(null);
      fetchMenu();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to update menu item'));
    }
  };

  
  const createTable = async () => {
    const accessConfig = normalizeAccessConfig(restaurantProfile.access_config);
    if (!accessConfig.table_management_enabled) {
      toast.error('Table management is disabled by super admin.');
      return;
    }
    if (accessConfig.max_tables !== null && tables.length >= Number(accessConfig.max_tables)) {
      toast.error(`Table limit reached. Max tables allowed: ${accessConfig.max_tables}.`);
      return;
    }
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

  const exportReports = async (report = null) => {
    if (!reportFilters.start_date || !reportFilters.end_date) {
      toast.error('Please select both start and end dates.');
      return;
    }
    if (reportFilters.end_date < reportFilters.start_date) {
      toast.error('End date must be on or after start date.');
      return;
    }
    try {
      const response = await api.get('/api/reports/export', {
        params: {
          ...reportFilters,
          ...(report?.id ? { report_id: report.id } : {}),
        },
        withCredentials: true,
        responseType: 'blob',
      });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      const disposition = response.headers['content-disposition'] || '';
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      link.href = url;
      link.download = filenameMatch?.[1] || `reports-${report?.id || 'all'}-${reportFilters.start_date}-to-${reportFilters.end_date}.xlsx`;
      link.click();
      window.URL.revokeObjectURL(url);
      toast.success(`${report?.title || 'Reports'} export downloaded`);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to export reports'));
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
      const nextAccessConfig = normalizeAccessConfig(response.data.access_config);
      setRestaurantProfile({
        name: response.data.name || '',
        gst_number: response.data.gst_number || '',
        google_review_url: response.data.google_review_url || '',
        customer_logo_url: response.data.customer_logo_url || '',
        tax_enabled: response.data.tax_enabled ?? true,
        tax_percentage: response.data.tax_percentage ?? 5,
        service_charge_enabled: response.data.service_charge_enabled ?? false,
        service_charge_percentage: response.data.service_charge_percentage ?? 0,
        parcel_charge_enabled: response.data.parcel_charge_enabled ?? false,
        parcel_charge: response.data.parcel_charge ?? 0,
        access_config: nextAccessConfig,
      });
      setNewStaff((current) => {
        const selectedRoleEnabled = STAFF_ROLE_OPTIONS.some((role) => role.value === current.role && nextAccessConfig[role.accessKey]);
        if (selectedRoleEnabled) return current;
        const firstEnabledRole = STAFF_ROLE_OPTIONS.find((role) => nextAccessConfig[role.accessKey]);
        return { ...current, role: firstEnabledRole?.value || current.role };
      });
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to load restaurant settings'));
    }
  };

  const fetchAttendanceKioskLink = async () => {
    try {
      const response = await api.get('/api/attendance/kiosk-link', { withCredentials: true });
      setAttendanceKioskLink(response.data.url || '');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to load attendance kiosk link'));
    }
  };

  const copyAttendanceKioskLink = async () => {
    if (!attendanceKioskLink) return;
    try {
      await navigator.clipboard.writeText(attendanceKioskLink);
      toast.success('Attendance kiosk link copied');
    } catch (error) {
      toast.error('Copy failed. Select and copy the link manually.');
    }
  };

  const regenerateAttendanceKioskLink = async () => {
    try {
      setAttendanceKioskLoading(true);
      const response = await api.post('/api/attendance/kiosk-link/regenerate', {}, { withCredentials: true });
      setAttendanceKioskLink(response.data.url || '');
      toast.success('New attendance kiosk link generated');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to regenerate attendance kiosk link'));
    } finally {
      setAttendanceKioskLoading(false);
    }
  };

  const saveRestaurantProfile = async () => {
    try {
      const response = await api.put(
        `/api/restaurant/profile`,
        {
          gst_number: restaurantProfile.gst_number.trim(),
          google_review_url: restaurantProfile.google_review_url.trim(),
          customer_logo_url: restaurantProfile.customer_logo_url.trim(),
          tax_enabled: restaurantProfile.tax_enabled,
          tax_percentage: Number(restaurantProfile.tax_percentage) || 0,
          service_charge_enabled: restaurantProfile.service_charge_enabled,
          service_charge_percentage: Number(restaurantProfile.service_charge_percentage) || 0,
          parcel_charge_enabled: restaurantProfile.parcel_charge_enabled,
          parcel_charge: Number(restaurantProfile.parcel_charge) || 0,
        }
      );
      setRestaurantProfile({
        name: response.data.name || '',
        gst_number: response.data.gst_number || '',
        google_review_url: response.data.google_review_url || '',
        customer_logo_url: response.data.customer_logo_url || '',
        tax_enabled: response.data.tax_enabled ?? true,
        tax_percentage: response.data.tax_percentage ?? 5,
        service_charge_enabled: response.data.service_charge_enabled ?? false,
        service_charge_percentage: response.data.service_charge_percentage ?? 0,
        parcel_charge_enabled: response.data.parcel_charge_enabled ?? false,
        parcel_charge: response.data.parcel_charge ?? 0,
      });
      toast.success('Restaurant settings updated');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to update restaurant settings'));
    }
  };

  const createStaff = async () => {
    const accessConfig = normalizeAccessConfig(restaurantProfile.access_config);
    if (!accessConfig.staff_management_enabled) {
      toast.error('Staff management is disabled by super admin.');
      return;
    }
    const selectedRole = STAFF_ROLE_OPTIONS.find((role) => role.value === newStaff.role);
    if (selectedRole && !accessConfig[selectedRole.accessKey]) {
      toast.error(`${selectedRole.label} access is disabled by super admin.`);
      return;
    }
    if (accessConfig.max_staff !== null && staff.length >= Number(accessConfig.max_staff)) {
      toast.error(`Staff limit reached. Max staff allowed: ${accessConfig.max_staff}.`);
      return;
    }
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

   const searchOrder = async () => {
    if (!orderSearchId.trim()) {
      toast.error('Please enter an order ID to search.');
      return;
    }
    try {
      const response = await api.get(`/api/admin/orders/search`, {
        params: { order_id: orderSearchId.trim() },
        withCredentials: true,
      });
      setSearchedOrder(response.data);
      toast.success('Order found');
    } catch (error) {
      setSearchedOrder(null);
      toast.error(getErrorMessage(error, 'Failed to search order'));
    }
  };

  const deleteOrder = async () => {
    if (!searchedOrder) return;
    if (!window.confirm(`Delete order ${searchedOrder.order_id}?`)) return;
    try {
      await api.delete(`/api/admin/orders/${searchedOrder.order_id}`, {
        withCredentials: true,
      });
      toast.success('Order deleted');
      setSearchedOrder(null);
      setOrderSearchId('');
      fetchAnalytics();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to delete order'));
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

  const markMenuImageBroken = (itemId) => {
    setBrokenMenuImages((prev) => ({ ...prev, [itemId]: true }));
  };

  const categoryNameMap = categories.reduce((accumulator, category) => {
    accumulator[category.category_id] = category.name;
    return accumulator;
  }, {});

  const groupedMenuItems = categories.map((category) => ({
    ...category,
    items: menuItems.filter((item) => item.category_id === category.category_id),
  })).filter((category) => category.items.length > 0);

  const uncategorizedItems = menuItems.filter((item) => !categoryNameMap[item.category_id]);

  const downloadQR = (tableId) => {
    const canvas = document.getElementById(`qr-${tableId}`);
    const url = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `table-${tableId}-qr.png`;
    link.href = url;
    link.click();
  };

  const accessConfig = normalizeAccessConfig(restaurantProfile.access_config);
  const allowedStaffRoles = STAFF_ROLE_OPTIONS.filter((role) => accessConfig[role.accessKey]);
  const tableLimitReached = accessConfig.max_tables !== null && tables.length >= Number(accessConfig.max_tables);
  const staffLimitReached = accessConfig.max_staff !== null && staff.length >= Number(accessConfig.max_staff);

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
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => navigate('/admin/attendance')}
              variant="outline"
              className="rounded-full border-border"
            >
              <UserCheck className="w-4 h-4 mr-2" />
              Attendance
            </Button>
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
            <TabsTrigger value="reports" className="rounded-full" data-testid="tab-reports">
              <FileSpreadsheet className="w-4 h-4 mr-2" />
              Reports
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
               <Card className="border-border rounded-2xl">
              <CardHeader>
                <CardTitle>Search Order ID</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-col sm:flex-row gap-3">
                  <Input
                    value={orderSearchId}
                    onChange={(e) => setOrderSearchId(e.target.value.toUpperCase())}
                    placeholder="Enter order ID"
                    className="rounded-full"
                    data-testid="search-order-id-input"
                  />
                  <Button onClick={searchOrder} className="rounded-full bg-primary hover:bg-[#C54E2C]">
                    Search Order
                  </Button>
                </div>
                {searchedOrder && (
                  <div className="rounded-2xl border border-border bg-accent/60 p-4 space-y-3">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="font-semibold">{searchedOrder.order_id}</p>
                        <p className="text-sm text-muted-foreground">
                          {searchedOrder.table_label || `Table ${searchedOrder.table_id}`} • {searchedOrder.customer_name}
                        </p>
                      </div>
                      <div className="text-sm font-medium">
                        ₹{searchedOrder.payment?.total?.toFixed?.(2) || searchedOrder.total.toFixed(2)}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>Status: {searchedOrder.status}</span>
                      <span>Payment: {searchedOrder.payment_status}</span>
                      {searchedOrder.payment?.bill_id && <span>Bill: {searchedOrder.payment.bill_id}</span>}
                    </div>
                    <div className="space-y-2 rounded-xl bg-white p-3">
	                      {(searchedOrder.items || []).map((item, idx) => {
	                        const billableQuantity = getBillableQuantity(item);
	                        const cancelledQuantity = getCancelledQuantity(item);
	                        return (
	                          <div key={`${searchedOrder.order_id}-${idx}`} className="flex items-center justify-between gap-3 text-sm">
	                            <span className={`min-w-0 truncate ${billableQuantity <= 0 ? 'line-through text-muted-foreground' : ''}`}>
	                              {billableQuantity}x {item.name}
	                              {cancelledQuantity > 0 && (
	                                <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-xs font-bold text-red-600">
	                                  {cancelledQuantity} cancelled
	                                </span>
	                              )}
	                              {isLossItem(item) && (
	                                <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">
	                                  Loss
	                                </span>
	                              )}
	                              {item.reallocated_to_order_id && (
	                                <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-700">
	                                  Reallocated to {formatReallocationTarget(item)}
	                                </span>
	                              )}
	                            </span>
	                            <span className="font-medium">₹{(billableQuantity * item.price).toFixed(2)}</span>
	                          </div>
	                        );
	                      })}
                    </div>
                    <Button variant="destructive" className="rounded-full" onClick={deleteOrder}>
                      Delete Order
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
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
	                <Card className="border-border rounded-2xl">
	                  <CardHeader>
	                    <CardTitle className="text-sm text-muted-foreground">Cancellation Loss</CardTitle>
	                  </CardHeader>
	                  <CardContent>
	                    <p className="text-4xl font-bold font-mono text-rose-600">
	                      ₹{(analytics.cancellation_loss?.amount || 0).toFixed(2)}
	                    </p>
	                    <p className="mt-1 text-sm text-muted-foreground">
	                      {analytics.cancellation_loss?.quantity || 0} item{(analytics.cancellation_loss?.quantity || 0) === 1 ? '' : 's'} lost
	                    </p>
	                  </CardContent>
	                </Card>
	              </div>
	            )}

            {analytics && (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 sm:gap-6">
                <Card className="border-border rounded-2xl">
                  <CardHeader>
                    <CardTitle className="text-sm text-muted-foreground">Cash Collected</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold font-mono text-emerald-600">₹{(analytics.payment_summary?.cash || 0).toFixed(2)}</p>
                  </CardContent>
                </Card>
                <Card className="border-border rounded-2xl">
                  <CardHeader>
                    <CardTitle className="text-sm text-muted-foreground">UPI Collected</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold font-mono text-sky-600">₹{(analytics.payment_summary?.upi || 0).toFixed(2)}</p>
                  </CardContent>
                </Card>
                <Card className="border-border rounded-2xl">
                  <CardHeader>
                    <CardTitle className="text-sm text-muted-foreground">Card Collected</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold font-mono text-violet-600">₹{(analytics.payment_summary?.card || 0).toFixed(2)}</p>
                  </CardContent>
                </Card>
                <Card className="border-border rounded-2xl">
                  <CardHeader>
                    <CardTitle className="text-sm text-muted-foreground">Cash Adjustments</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className={`text-3xl font-bold font-mono ${(analytics.cash_adjustments?.total_adjustments || 0) >= 0 ? 'text-amber-600' : 'text-rose-600'}`}>
                      ₹{(analytics.cash_adjustments?.total_adjustments || 0).toFixed(2)}
                    </p>
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

            <Card className="border-border rounded-2xl">
              <CardHeader>
                <CardTitle>Deleted Bills Audit</CardTitle>
              </CardHeader>
              <CardContent>
                {analytics?.deleted_bills?.length ? (
                  <div className="space-y-3">
                    {analytics.deleted_bills.map((entry) => {
                      const payment = entry.payment || {};
                      const orderIds = entry.order_ids || [];
                      return (
                        <div key={entry.deleted_bill_id || `${entry.bill_id}-${entry.deleted_at}`} className="rounded-2xl border border-red-100 bg-red-50/60 p-4">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="font-semibold text-red-900">{entry.bill_id}</p>
                                <span className="rounded-full bg-white px-2 py-0.5 text-xs font-bold text-red-700">
                                  Deleted
                                </span>
                              </div>
                              <p className="mt-1 break-words text-sm text-red-900">{entry.reason}</p>
                              <p className="mt-2 text-xs text-muted-foreground">
                                {entry.deleted_by_name || 'Staff'} • {new Date(entry.deleted_at).toLocaleString()}
                              </p>
                              {orderIds.length > 0 && (
                                <p className="mt-1 break-words text-xs text-muted-foreground">
                                  Orders: {orderIds.join(', ')}
                                </p>
                              )}
                            </div>
                            <div className="shrink-0 text-left sm:text-right">
                              <p className="text-lg font-bold text-red-700">₹{Number(payment.total || 0).toFixed(2)}</p>
                              <p className="text-xs font-bold text-muted-foreground">{(payment.payment_method || 'N/A').toUpperCase()}</p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                    No deleted bills found for this period.
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-border rounded-2xl">
              <CardHeader>
                <CardTitle>Cash Adjustment Reasons</CardTitle>
              </CardHeader>
              <CardContent>
                {analytics?.cash_adjustments?.entries?.length ? (
                  <div className="space-y-3">
                    {analytics.cash_adjustments.entries.map((entry) => (
                      <div key={entry.adjustment_id} className="rounded-2xl border border-border bg-accent/60 p-4">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="font-semibold">{entry.reason}</p>
                            <p className="text-xs text-muted-foreground">
                              {entry.created_by_name || 'Staff'} • {new Date(entry.created_at).toLocaleString()}
                            </p>
                          </div>
                          <p className={`text-lg font-bold ${(entry.amount || 0) >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                            ₹{Number(entry.amount || 0).toFixed(2)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                    No cash adjustments found for this period.
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="menu" className="space-y-6">
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <Card className="border-border rounded-2xl">
                <CardHeader>
                  <CardTitle>Import / Export Categories</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label>Upload Categories Excel</Label>
                    <Input
                      type="file"
                      accept=".xlsx"
                      onChange={(e) => setCategoryImportFile(e.target.files?.[0] || null)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Excel columns: `Category Name`
                    </p>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <Button onClick={importCategories} disabled={categoryImporting} className="rounded-full bg-primary hover:bg-[#C54E2C]">
                      <Upload className="w-4 h-4 mr-2" />
                      {categoryImporting ? 'Importing...' : 'Import Categories'}
                    </Button>
                    <Button onClick={() => downloadExcel('/api/menu/categories/export', 'menu-categories.xlsx')} variant="outline" className="rounded-full">
                      <Download className="w-4 h-4 mr-2" />
                      Export Categories
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-border rounded-2xl">
                <CardHeader>
                  <CardTitle>Import / Export Menu Items</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label>Upload Menu Items Excel</Label>
                    <Input
                      type="file"
                      accept=".xlsx"
                      onChange={(e) => setItemImportFile(e.target.files?.[0] || null)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Excel columns: `Item Name`, `Category Name`, `Price`, `Description`, `Image URL`, `Available`
                    </p>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <Button onClick={importMenuItems} disabled={itemImporting} className="rounded-full bg-primary hover:bg-[#C54E2C]">
                      <Upload className="w-4 h-4 mr-2" />
                      {itemImporting ? 'Importing...' : 'Import Menu Items'}
                    </Button>
                    <Button onClick={() => downloadExcel('/api/menu/items/export', 'menu-items.xlsx')} variant="outline" className="rounded-full">
                      <Download className="w-4 h-4 mr-2" />
                      Export Menu Items
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>

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
	                    <Label>Section</Label>
	                    <Select value={newItem.diet_type} onValueChange={(val) => setNewItem({ ...newItem, diet_type: val })}>
	                      <SelectTrigger className="rounded-full" data-testid="item-diet-type-select">
	                        <SelectValue />
	                      </SelectTrigger>
	                      <SelectContent>
	                        {MENU_DIET_OPTIONS.map((dietType) => (
	                          <SelectItem key={dietType} value={dietType}>
	                            <span className="inline-flex items-center gap-2">
	                              <DietIndicator item={{ diet_type: dietType }} />
	                              {DIET_TYPES[dietType].label}
	                            </span>
	                          </SelectItem>
	                        ))}
	                      </SelectContent>
	                    </Select>
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

            <div className="space-y-4">
              <Accordion
                type="multiple"
                value={openMenuCategories}
                onValueChange={setOpenMenuCategories}
                className="space-y-4"
              >
                {groupedMenuItems.map((category) => (
                  <AccordionItem key={category.category_id} value={category.category_id} className="border-border rounded-2xl border bg-white px-5">
                    <AccordionTrigger className="py-5 text-left no-underline hover:no-underline">
                      <div className="flex min-w-0 flex-1 items-center justify-between gap-3 pr-4">
                        <div>
                          <p className="text-lg font-semibold">{category.name}</p>
                          <p className="text-sm text-muted-foreground">{category.items.length} items</p>
                        </div>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="pb-5">
                      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 auto-rows-fr">
                        {category.items.map((item) => {
                          const showImage = item.image && !brokenMenuImages[item.item_id];
                          return (
                            <Card key={item.item_id} className="border-border rounded-2xl h-full" data-testid={`menu-item-card-${item.item_id}`}>
                              {showImage && (
                                <div className="h-20 overflow-hidden rounded-t-2xl bg-accent/40">
                                  <img
                                    src={normalizeImageUrl(item.image)}
                                    alt={item.name}
                                    className="h-full w-full object-cover"
                                    onError={() => markMenuImageBroken(item.item_id)}
                                  />
                                </div>
                              )}
                              <CardContent className="p-4 space-y-3 h-full flex flex-col">
                                <div className="min-w-0">
                                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{category.name}</p>
	                                  <div className="flex items-start gap-2">
	                                    <DietIndicator item={item} className="mt-1.5" />
	                                    <h3 className="font-semibold text-lg break-words">{item.name}</h3>
	                                  </div>
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
                                       variant="outline"
                                      className="h-8 w-8 p-0 rounded-full"
                                      onClick={() => startEditMenuItem(item)}
                                      data-testid={`edit-item-${item.item_id}`}
                                    >
                                      <Pencil className="w-4 h-4" />
                                    </Button>
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
                          );
                        })}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>

              {uncategorizedItems.length > 0 && (
                <Card className="border-border rounded-2xl">
                  <CardHeader>
                    <CardTitle>Uncategorized Items</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 auto-rows-fr">
                      {uncategorizedItems.map((item) => (
                        <Card key={item.item_id} className="border-border rounded-2xl h-full">
                          <CardContent className="p-4 space-y-3 h-full flex flex-col">
                            <div className="min-w-0">
	                              <div className="flex items-start gap-2">
	                                <DietIndicator item={item} className="mt-1.5" />
	                                <h3 className="font-semibold text-lg break-words">{item.name}</h3>
	                              </div>
                              <p className="text-sm text-muted-foreground break-words min-h-10">{item.description || 'No description added'}</p>
                            </div>
                            <div className="flex items-center justify-between gap-3 mt-auto">
                              <p className="text-xl font-bold text-primary">₹{item.price}</p>
                              <div className="flex items-center gap-2">
                                <Switch
                                  checked={item.available}
                                  onCheckedChange={() => toggleItemAvailability(item.item_id, item.available)}
                                />
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  className="h-8 w-8 p-0 rounded-full"
                                  onClick={() => deleteMenuItem(item.item_id)}
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>

          <TabsContent value="tables" className="space-y-6">
            <Card className="border-border rounded-2xl">
              <CardHeader>
                <CardTitle>Add Table</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {!accessConfig.table_management_enabled && (
                  <p className="rounded-xl bg-yellow-50 px-3 py-2 text-sm font-medium text-yellow-800">
                    Table management is disabled by super admin.
                  </p>
                )}
                {accessConfig.table_management_enabled && accessConfig.max_tables !== null && (
                  <p className="text-sm text-muted-foreground">
                    Tables used: {tables.length}/{accessConfig.max_tables}
                  </p>
                )}
                <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  type="number"
                  placeholder="Table number"
                  value={newTableNumber}
                  onChange={(e) => setNewTableNumber(e.target.value)}
                  disabled={!accessConfig.table_management_enabled || tableLimitReached}
                  className="rounded-full"
                  data-testid="table-number-input"
                />
                <Button
                  onClick={createTable}
                  disabled={!accessConfig.table_management_enabled || tableLimitReached}
                  className="rounded-full bg-primary hover:bg-[#C54E2C]"
                  data-testid="add-table-button"
                >
                  <Plus className="w-4 h-4 mr-1" />
                  Add
                </Button>
                </div>
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
                        disabled={!accessConfig.table_management_enabled}
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
                {!accessConfig.staff_management_enabled && (
                  <p className="rounded-xl bg-yellow-50 px-3 py-2 text-sm font-medium text-yellow-800">
                    Staff management is disabled by super admin.
                  </p>
                )}
                {accessConfig.staff_management_enabled && accessConfig.max_staff !== null && (
                  <p className="text-sm text-muted-foreground">
                    Staff used: {staff.length}/{accessConfig.max_staff}
                  </p>
                )}
                {accessConfig.staff_management_enabled && allowedStaffRoles.length === 0 && (
                  <p className="rounded-xl bg-yellow-50 px-3 py-2 text-sm font-medium text-yellow-800">
                    No staff roles are enabled by super admin.
                  </p>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Name</Label>
                    <Input
                      value={newStaff.name}
                      onChange={(e) => setNewStaff({ ...newStaff, name: e.target.value })}
                      className="rounded-full"
                      disabled={!accessConfig.staff_management_enabled || staffLimitReached}
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
                      disabled={!accessConfig.staff_management_enabled || staffLimitReached}
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
                      disabled={!accessConfig.staff_management_enabled || staffLimitReached}
                      placeholder="••••••••"
                      data-testid="staff-password-input"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Role</Label>
                    <Select
                      value={newStaff.role}
                      onValueChange={(val) => setNewStaff({ ...newStaff, role: val })}
                      disabled={!accessConfig.staff_management_enabled || staffLimitReached || allowedStaffRoles.length === 0}
                    >
                      <SelectTrigger className="rounded-full" data-testid="staff-role-select">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {allowedStaffRoles.map((role) => (
                          <SelectItem key={role.value} value={role.value}>{role.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <Button
                  onClick={createStaff}
                  disabled={!accessConfig.staff_management_enabled || staffLimitReached || allowedStaffRoles.length === 0}
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
                         {member.role === 'kitchen'
                          ? 'Kitchen Staff'
                          : member.role === 'kitchen_tv'
                            ? 'Kitchen TV Display'
                            : member.role === 'billing'
                              ? 'Billing Counter'
                              : member.role === 'kitchen_billing'
                                ? 'Kitchen + Billing'
                                : member.role === 'pos'
                                  ? 'POS Only'
                                  : 'Waiter'}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={!accessConfig.staff_management_enabled}
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

          <TabsContent value="reports" className="space-y-6">
            <Card className="border-border rounded-2xl">
              <CardHeader>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <FileSpreadsheet className="h-5 w-5 text-primary" />
                      Reports
                    </CardTitle>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Must-have restaurant reports for the selected business period.
                    </p>
                  </div>
                  <Button onClick={() => exportReports()} variant="outline" className="rounded-full">
                    <Download className="w-4 h-4 mr-2" />
                    Export All
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
                  <div className="space-y-2">
                    <Label>Period</Label>
                    <Select
                      value={reportFilters.period}
                      onValueChange={(value) => setReportFilters((current) => ({
                        ...current,
                        period: value,
                        ...getReportPresetRange(value),
                      }))}
                    >
                      <SelectTrigger className="rounded-full" data-testid="reports-period-select">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="daily">Daily</SelectItem>
                        <SelectItem value="weekly">Weekly</SelectItem>
                        <SelectItem value="monthly">Monthly</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Start Date</Label>
                    <Input
                      type="date"
                      value={reportFilters.start_date}
                      onChange={(event) => setReportFilters((current) => ({ ...current, start_date: event.target.value }))}
                      className="rounded-full"
                      data-testid="reports-start-date-input"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>End Date</Label>
                    <Input
                      type="date"
                      value={reportFilters.end_date}
                      onChange={(event) => setReportFilters((current) => ({ ...current, end_date: event.target.value }))}
                      className="rounded-full"
                      data-testid="reports-end-date-input"
                    />
                  </div>
                  <div className="flex items-end">
                    <Button onClick={fetchReports} className="w-full rounded-full bg-primary hover:bg-[#C54E2C]">
                      <RefreshCw className="w-4 h-4 mr-2" />
                      Refresh Reports
                    </Button>
                  </div>
                </div>
                {reports && (
                  <p className="mt-4 text-sm text-muted-foreground">
                    Showing {reports.period} reports from {reports.start_date} to {reports.end_date}.
                  </p>
                )}
              </CardContent>
            </Card>

            {reportsLoading && (
              <Card className="border-border rounded-2xl">
                <CardContent className="flex items-center justify-center gap-2 p-10 text-muted-foreground">
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  Loading reports...
                </CardContent>
              </Card>
            )}

            {!reportsLoading && reports?.reports?.length > 0 && (
              <>
                <Accordion
                  type="multiple"
                  defaultValue={['Sales', 'Billing', 'Payments', 'Orders', 'Menu', 'Control', 'Tables', 'Customers']}
                  className="space-y-3"
                >
                  {['Sales', 'Billing', 'Payments', 'Orders', 'Menu', 'Control', 'Tables', 'Customers'].map((category) => {
                    const categoryReports = reports.reports.filter((report) => report.category === category);
                    if (!categoryReports.length) return null;
                    return (
                      <AccordionItem key={category} value={category} className="rounded-2xl border border-border bg-white px-4 shadow-sm">
                        <AccordionTrigger className="py-4 hover:no-underline">
                          <div className="flex w-full items-center justify-between gap-3 pr-3">
                            <div className="flex items-center gap-2">
                              <BarChart3 className="h-4 w-4 text-primary" />
                              <h3 className="text-lg font-bold">{category}</h3>
                            </div>
                            <span className="rounded-full bg-accent px-3 py-1 text-xs font-semibold text-muted-foreground">
                              {categoryReports.length} report{categoryReports.length === 1 ? '' : 's'}
                            </span>
                          </div>
                        </AccordionTrigger>
                        <AccordionContent>
                          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                            {categoryReports.map((report) => (
                              <Card key={report.id} className="border-border rounded-2xl">
                                <CardContent className="flex h-full flex-col p-5">
                                  <div className="flex-1">
                                    <p className="text-sm font-medium text-muted-foreground">{report.title}</p>
                                    <p className={`mt-2 break-words font-mono text-3xl font-bold ${report.value_type === 'currency' ? 'text-success' : 'text-foreground'}`}>
                                      {formatReportValue(report)}
                                    </p>
                                    {report.note && (
                                      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{report.note}</p>
                                    )}
                                  </div>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="mt-4 rounded-full"
                                    onClick={() => exportReports(report)}
                                    data-testid={`export-report-${report.id}`}
                                  >
                                    <Download className="mr-2 h-3.5 w-3.5" />
                                    Export
                                  </Button>
                                </CardContent>
                              </Card>
                            ))}
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    );
                  })}
                </Accordion>

                <Card className="border-border rounded-2xl">
                  <CardHeader>
                    <CardTitle>All {reports.reports.length} Reports</CardTitle>
                  </CardHeader>
                  <CardContent className="overflow-x-auto">
                    <table className="w-full min-w-[760px] text-left text-sm">
                      <thead className="border-y bg-accent text-xs uppercase text-muted-foreground">
                        <tr>
                          <th className="px-4 py-3">Category</th>
                          <th className="px-4 py-3">Report</th>
                          <th className="px-4 py-3">Value</th>
                          <th className="px-4 py-3">Notes</th>
                          <th className="px-4 py-3">Export</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reports.reports.map((report) => (
                          <tr key={`row-${report.id}`} className="border-b">
                            <td className="px-4 py-3 font-medium">{report.category}</td>
                            <td className="px-4 py-3">{report.title}</td>
                            <td className="px-4 py-3 font-mono font-bold">{formatReportValue(report)}</td>
                            <td className="px-4 py-3 text-muted-foreground">{report.note || '-'}</td>
                            <td className="px-4 py-3">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="rounded-full"
                                onClick={() => exportReports(report)}
                              >
                                <Download className="mr-2 h-3.5 w-3.5" />
                                Download
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>

                <Card className="border-border rounded-2xl">
                  <CardHeader>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <CardTitle>Customer Contact Captures</CardTitle>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Names and phone numbers collected from QR scans, counter orders, and waiter orders.
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className="rounded-full"
                        onClick={() => exportReports(reports.reports.find((report) => report.id === 'customer_contacts'))}
                      >
                        <Download className="mr-2 h-4 w-4" />
                        Export Contacts
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="overflow-x-auto">
                    {(reports.details?.customer_contacts || []).length > 0 ? (
                      <table className="w-full min-w-[900px] text-left text-sm">
                        <thead className="border-y bg-accent text-xs uppercase text-muted-foreground">
                          <tr>
                            <th className="px-4 py-3">Source</th>
                            <th className="px-4 py-3">Customer</th>
                            <th className="px-4 py-3">Phone</th>
                            <th className="px-4 py-3">Table</th>
                            <th className="px-4 py-3">Order</th>
                            <th className="px-4 py-3">Captured At</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(reports.details?.customer_contacts || []).slice(0, 10).map((contact, index) => (
                            <tr key={`${contact.source}-${contact.phone}-${contact.order_id}-${index}`} className="border-b">
                              <td className="px-4 py-3 font-medium">{contact.source}</td>
                              <td className="px-4 py-3">{contact.customer_name || '-'}</td>
                              <td className="px-4 py-3">{contact.phone || '-'}</td>
                              <td className="px-4 py-3">{contact.table || '-'}</td>
                              <td className="px-4 py-3 font-mono text-xs">{contact.order_id || '-'}</td>
                              <td className="px-4 py-3 text-muted-foreground">{contact.captured_at || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                        No customer names or phone numbers captured in this period.
                      </p>
                    )}
                    {(reports.details?.customer_contacts || []).length > 10 && (
                      <p className="mt-3 text-xs text-muted-foreground">
                        Showing latest 10 contacts here. Export Contacts downloads the full list.
                      </p>
                    )}
                  </CardContent>
                </Card>

                <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
                  <Card className="border-border rounded-2xl">
                    <CardHeader>
                      <CardTitle>Top Items</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {(reports.details?.top_items || []).slice(0, 5).map((item) => (
                        <div key={item.name} className="flex items-center justify-between rounded-xl bg-accent p-3">
                          <div className="min-w-0">
                            <p className="truncate font-semibold">{item.name}</p>
                            <p className="text-xs text-muted-foreground">{item.quantity} qty</p>
                          </div>
                          <p className="font-bold text-primary">₹{Number(item.revenue || 0).toFixed(2)}</p>
                        </div>
                      ))}
                      {(!reports.details?.top_items || reports.details.top_items.length === 0) && (
                        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No item sales yet.</p>
                      )}
                    </CardContent>
                  </Card>

                  <Card className="border-border rounded-2xl">
                    <CardHeader>
                      <CardTitle>Top Categories</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {(reports.details?.top_categories || []).slice(0, 5).map((category) => (
                        <div key={category.category} className="flex items-center justify-between rounded-xl bg-accent p-3">
                          <div className="min-w-0">
                            <p className="truncate font-semibold">{category.category}</p>
                            <p className="text-xs text-muted-foreground">{category.quantity} qty</p>
                          </div>
                          <p className="font-bold text-primary">₹{Number(category.revenue || 0).toFixed(2)}</p>
                        </div>
                      ))}
                      {(!reports.details?.top_categories || reports.details.top_categories.length === 0) && (
                        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No category sales yet.</p>
                      )}
                    </CardContent>
                  </Card>

                  <Card className="border-border rounded-2xl">
                    <CardHeader>
                      <CardTitle>Top Tables</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {(reports.details?.top_tables || []).slice(0, 5).map((table) => (
                        <div key={table.table} className="flex items-center justify-between rounded-xl bg-accent p-3">
                          <div className="min-w-0">
                            <p className="truncate font-semibold">{table.table}</p>
                            <p className="text-xs text-muted-foreground">{table.orders} order{table.orders === 1 ? '' : 's'}</p>
                          </div>
                          <p className="font-bold text-primary">₹{Number(table.revenue || 0).toFixed(2)}</p>
                        </div>
                      ))}
                      {(!reports.details?.top_tables || reports.details.top_tables.length === 0) && (
                        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No table sales yet.</p>
                      )}
                    </CardContent>
                  </Card>
                </div>
              </>
            )}
          </TabsContent>

          <TabsContent value="settings" className="space-y-6">
            <Card className="border-border rounded-2xl">
              <CardHeader>
                <CardTitle>Entrance Attendance Kiosk</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Open this link on the restaurant entrance tablet. It works without admin login and is tied only to this restaurant.
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={attendanceKioskLink}
                    readOnly
                    className="rounded-full bg-accent"
                    placeholder="Kiosk link will appear here"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full"
                    onClick={copyAttendanceKioskLink}
                    disabled={!attendanceKioskLink}
                  >
                    <Copy className="w-4 h-4 mr-2" />
                    Copy
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full"
                    onClick={() => attendanceKioskLink && window.open(attendanceKioskLink, '_blank', 'noopener,noreferrer')}
                    disabled={!attendanceKioskLink}
                  >
                    <ExternalLink className="w-4 h-4 mr-2" />
                    Open
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full"
                    onClick={regenerateAttendanceKioskLink}
                    disabled={attendanceKioskLoading}
                  >
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Regenerate
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Regenerate the link if the tablet is lost or the link was shared outside the restaurant.
                </p>
              </CardContent>
            </Card>

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
                  <div className="space-y-2 sm:col-span-2">
                      <Label>Customer Logo URL</Label>
                    <Input
                      value={restaurantProfile.customer_logo_url}
                      onChange={(e) => setRestaurantProfile((prev) => ({ ...prev, customer_logo_url: e.target.value }))}
                      className="rounded-full"
                      placeholder="Paste the customer-facing logo URL"
                      data-testid="restaurant-customer-logo-input"
                    />
                    <p className="text-xs text-muted-foreground">
                      This logo will be shown on the QR customer name and phone screen.
                    </p>
                  </div>
                  <div className="space-y-2 sm:col-span-2">   
                    <Label>Google Review Link</Label>
                    <Input
                      value={restaurantProfile.google_review_url}
                      onChange={(e) => setRestaurantProfile((prev) => ({ ...prev, google_review_url: e.target.value }))}
                      className="rounded-full"
                      placeholder="Paste your Google review link"
                      data-testid="restaurant-google-review-input"
                    />
                    <p className="text-xs text-muted-foreground">
                      Customers will see this link after billing is completed.
                    </p>
                  </div>
                  <div className="space-y-4 rounded-2xl border border-border p-4">
                    <div className="flex items-center justify-between gap-4">
                      <Label htmlFor="tax-enabled">Tax</Label>
                      <Switch
                        id="tax-enabled"
                        checked={restaurantProfile.tax_enabled}
                        onCheckedChange={(checked) => setRestaurantProfile((prev) => ({
                          ...prev,
                          tax_enabled: checked,
                          tax_percentage: checked && Number(prev.tax_percentage || 0) <= 0 ? 5 : prev.tax_percentage,
                        }))}
                        data-testid="restaurant-tax-toggle"
                      />
                    </div>
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={restaurantProfile.tax_percentage}
                      onChange={(e) => setRestaurantProfile((prev) => ({ ...prev, tax_percentage: e.target.value }))}
                      className="rounded-full"
                      disabled={!restaurantProfile.tax_enabled}
                      placeholder="Tax percentage"
                      data-testid="restaurant-tax-percentage-input"
                    />
                  </div>
                  <div className="space-y-4 rounded-2xl border border-border p-4">
                    <div className="flex items-center justify-between gap-4">
                      <Label htmlFor="service-charge-enabled">Service Charge</Label>
                      <Switch
                        id="service-charge-enabled"
                        checked={restaurantProfile.service_charge_enabled}
                        onCheckedChange={(checked) => setRestaurantProfile((prev) => ({
                          ...prev,
                          service_charge_enabled: checked,
                          service_charge_percentage: checked && Number(prev.service_charge_percentage || 0) <= 0 ? 10 : prev.service_charge_percentage,
                        }))}
                        data-testid="restaurant-service-charge-toggle"
                      />
                    </div>
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={restaurantProfile.service_charge_percentage}
                      onChange={(e) => setRestaurantProfile((prev) => ({ ...prev, service_charge_percentage: e.target.value }))}
                      className="rounded-full"
                      disabled={!restaurantProfile.service_charge_enabled}
                      placeholder="Service charge percentage"
                      data-testid="restaurant-service-charge-input"
                    />
                  </div>
                  <div className="space-y-4 rounded-2xl border border-border p-4 sm:col-span-2">
                    <div className="flex items-center justify-between gap-4">
                      <Label htmlFor="parcel-charge-enabled">Parcel Charge</Label>
                      <Switch
                        id="parcel-charge-enabled"
                        checked={restaurantProfile.parcel_charge_enabled}
                        onCheckedChange={(checked) => setRestaurantProfile((prev) => ({ ...prev, parcel_charge_enabled: checked }))}
                        data-testid="restaurant-parcel-charge-toggle"
                      />
                    </div>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={restaurantProfile.parcel_charge}
                      onChange={(e) => setRestaurantProfile((prev) => ({ ...prev, parcel_charge: e.target.value }))}
                      className="rounded-full"
                      disabled={!restaurantProfile.parcel_charge_enabled}
                      placeholder="Parcel charge amount"
                      data-testid="restaurant-parcel-charge-input"
                    />
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
        <Dialog open={Boolean(editingMenuItem)} onOpenChange={(open) => {
        if (!open) {
          setEditingMenuItem(null);
        }
      }}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>Edit Menu Item</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={editingMenuItemDraft.name}
                onChange={(e) => setEditingMenuItemDraft({ ...editingMenuItemDraft, name: e.target.value })}
                className="rounded-full"
              />
            </div>
            <div className="space-y-2">
              <Label>Price</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={editingMenuItemDraft.price}
                onChange={(e) => setEditingMenuItemDraft({ ...editingMenuItemDraft, price: e.target.value })}
	                className="rounded-full"
	              />
	            </div>
	            <div className="space-y-2">
	              <Label>Section</Label>
	              <Select
	                value={editingMenuItemDraft.diet_type}
	                onValueChange={(val) => setEditingMenuItemDraft({ ...editingMenuItemDraft, diet_type: val })}
	              >
	                <SelectTrigger className="rounded-full">
	                  <SelectValue />
	                </SelectTrigger>
	                <SelectContent>
	                  {MENU_DIET_OPTIONS.map((dietType) => (
	                    <SelectItem key={dietType} value={dietType}>
	                      <span className="inline-flex items-center gap-2">
	                        <DietIndicator item={{ diet_type: dietType }} />
	                        {DIET_TYPES[dietType].label}
	                      </span>
	                    </SelectItem>
	                  ))}
	                </SelectContent>
	              </Select>
	            </div>
	            <div className="space-y-2">
	              <Label>Image URL</Label>
              <Input
                value={editingMenuItemDraft.image}
                onChange={(e) => setEditingMenuItemDraft({ ...editingMenuItemDraft, image: e.target.value })}
                className="rounded-full"
              />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Input
                value={editingMenuItemDraft.description}
                onChange={(e) => setEditingMenuItemDraft({ ...editingMenuItemDraft, description: e.target.value })}
                className="rounded-full"
                placeholder="Optional"
              />
            </div>
            <Button
              onClick={saveMenuItemEdit}
              className="w-full rounded-full bg-primary hover:bg-[#C54E2C]"
            >
              Save Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>             
    </div>
  );
};

export default AdminDashboard;
