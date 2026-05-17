import React, { useState } from 'react';
import { ChefHat, LogOut, Receipt } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Button } from '../components/ui/button';
import { useAuth } from '../contexts/AuthContext';
import KitchenDashboard from './KitchenDashboard';
import BillingDashboard from './BillingDashboard';

const OPERATIONS_TAB_KEY = 'operations-dashboard-active-tab';

const OperationsDashboard = () => {
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem(OPERATIONS_TAB_KEY) || 'kitchen');
  const { logout } = useAuth();
  const navigate = useNavigate();

  const handleTabChange = (value) => {
    setActiveTab(value);
    localStorage.setItem(OPERATIONS_TAB_KEY, value);
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-[#F3F4F6]">
      <div className="sticky top-0 z-20 border-b border-border bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <Tabs value={activeTab} onValueChange={handleTabChange}>
            <TabsList className="grid h-auto w-full grid-cols-2 gap-1 rounded-2xl border border-border bg-white p-1 sm:w-[420px] sm:rounded-full">
              <TabsTrigger value="kitchen" className="rounded-full" data-testid="operations-kitchen-tab">
                <ChefHat className="mr-2 h-4 w-4" />
                Kitchen
              </TabsTrigger>
              <TabsTrigger value="billing" className="rounded-full" data-testid="operations-billing-tab">
                <Receipt className="mr-2 h-4 w-4" />
                Billing
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            onClick={handleLogout}
            variant="outline"
            className="rounded-full border-border bg-white"
            data-testid="operations-logout-button"
          >
            <LogOut className="mr-2 h-4 w-4" />
            Logout
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsContent value="kitchen" className="m-0">
          <KitchenDashboard embedded />
        </TabsContent>
        <TabsContent value="billing" className="m-0">
          <BillingDashboard embedded />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default OperationsDashboard;
