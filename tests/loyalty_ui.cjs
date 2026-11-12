// Run against the local frontend with all API responses mocked.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      let paymentPayload;
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        let data = [];
        if (url.pathname === '/api/auth/me') data = { role: 'billing', name: 'QA Staff', restaurant_id: 'test', restaurant_name: 'Test Restaurant' };
        if (url.pathname === '/api/restaurant/profile') data = { name: 'Test Restaurant', tax_enabled: false };
        if (url.pathname === '/api/analytics/dashboard') data = {};
        if (url.pathname === '/api/orders') data = [{ order_id: 'ORDER-TEST', table_id: 'table-1', table_number: 1, table_label: 'Table 1',
          customer_name: 'Test Customer', order_type: 'dine_in', status: 'prepared', payment_status: 'pending', total: 500,
          created_at: new Date().toISOString(), items: [{ item_id: 'item-1', name: 'Test Meal', price: 500, quantity: 1 }] }];
        if (url.pathname === '/api/loyalty/customer') data = { phone: '919876543210', balance: 240, can_redeem: true,
          total_entries: 1, history: [{ payment_id: 'OLD', bill_id: 'BILL-OLD', kind: 'payment', earned: 40, redeemed: 0, balance: 240, created_at: '2026-11-10T12:00:00Z' }] };
        if (url.pathname === '/api/payments' && route.request().method() === 'POST') {
          paymentPayload = route.request().postDataJSON(); data = { total: 300, loyalty_earned: 24, loyalty_balance: 64 };
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
      });
      await page.route('**/socket.io/**', route => route.abort());
      await page.goto('http://localhost:3000/billing');
      const counterButton = page.getByRole('button', { name: 'Take Counter Order', exact: true });
      const coinsButton = page.getByRole('button', { name: 'Dineflo Coins', exact: true });
      await counterButton.waitFor();
      const counterBox = await counterButton.boundingBox();
      const coinsBox = await coinsButton.boundingBox();
      assert.ok(coinsBox.y >= counterBox.y + counterBox.height);
      assert.ok(Math.abs(coinsBox.x - counterBox.x) < 1);
      assert.ok(Math.abs(coinsBox.width - counterBox.width) < 1);
      await page.getByRole('button', { name: 'Dineflo Coins', exact: true }).click();
      let dialog = page.getByRole('dialog');
      await dialog.getByLabel('Customer mobile number').fill('9876543210');
      await dialog.getByRole('button', { name: 'Check coin balance' }).click();
      await dialog.getByText('240 coins', { exact: true }).waitFor();
      await dialog.locator('summary').click();
      await dialog.getByText('BILL-OLD', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('radio', { name: 'Cash', exact: true }).click();
      await page.getByRole('button', { name: 'Complete Payment', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Customer mobile number').fill('9876543210');
      assert.equal(await dialog.getByRole('button', { name: 'Confirm Payment', exact: true }).isDisabled(), true);
      await dialog.getByRole('button', { name: 'Check coin balance' }).click();
      await dialog.getByText('240 coins', { exact: true }).waitFor();
      await dialog.getByLabel('Coins to redeem', { exact: false }).fill('200');
      await dialog.getByText('24 coins earned on this payment', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `/tmp/dineflo-loyalty-${width}.png` });
      await dialog.getByRole('button', { name: 'Confirm Payment', exact: true }).click();
      await page.getByText('Bill completed successfully.', { exact: true }).waitFor();
      assert.equal(paymentPayload.loyalty_phone, '919876543210');
      assert.equal(paymentPayload.loyalty_redeem, 200);
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: balance, history, redemption, payment payload, no overflow or runtime errors`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
