const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    for (const width of (process.env.POS_ONLY ? [] : [1440, 768, 390])) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [], submissions = [];
      let fail = true, billRequests = 0;
      let orders = [{ order_id: 'OLD', table_id: 't1', table_label: 'Table 1', status: 'prepared', payment_status: 'pending', total: 100,
        items: [{ item_id: 'old', name: 'Already sent soup', quantity: 1 }] }];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        let data = [];
        if (path === '/api/auth/me') data = { user_id: 'waiter1', role: 'waiter', name: 'Test Waiter', restaurant_id: 'r1', restaurant_name: 'Test Kitchen' };
        if (path === '/api/tables') data = [{ table_id: 't1', table_number: 1 }, { table_id: 't2', table_number: 2 }];
        if (path === '/api/menu/categories') data = [{ category_id: 'c1', name: 'Meals' }];
        if (path === '/api/menu/items') data = [
          { item_id: 'veg', name: 'Paneer Tikka', price: 200, available: true, category_id: 'c1', diet_type: 'veg' },
          { item_id: 'chicken', name: 'Chicken Tikka', price: 250, available: true, category_id: 'c1', diet_type: 'non_veg' },
          { item_id: 'off', name: 'Unavailable Meal', price: 200, available: false, diet_type: 'egg' },
        ];
        if (path === '/api/orders') data = orders;
        if (path === '/api/counter/orders') {
          const payload = route.request().postDataJSON(); submissions.push(payload);
          if (fail) { fail = false; return route.abort(); }
          data = { ...payload, order_id: 'NEW', status: 'pending', payment_status: 'pending', table_label: 'Table 1' };
          orders = [...orders, data];
        }
        if (path.endsWith('/request-bill')) { billRequests++; orders = orders.map(o => ({ ...o, bill_requested: true })); data = {}; }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
      });
      await page.route('**/socket.io/**', route => route.abort());
      await page.goto('http://localhost:3000/waiter');
      await page.getByRole('button', { name: 'Table 1 · Active', exact: true }).click();
      await page.getByRole('button', { name: 'Veg', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'Add one Chicken Tikka', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Veg', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'Add one Unavailable Meal' }).isDisabled(), true);
      await page.getByRole('button', { name: 'Add one Paneer Tikka', exact: true }).click();
      await page.getByRole('button', { name: 'Table 2', exact: true }).click();
      await page.getByRole('button', { name: 'Add one Chicken Tikka', exact: true }).click();
      await page.getByRole('button', { name: 'Table 1 · Active · Draft', exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `/tmp/waiter-menu-${width}.png`, fullPage: true });
      if (width < 1024) await page.getByRole('button', { name: /Table 1 · 1 unsent/ }).click();
      const cart = width < 1024 ? page.getByRole('dialog') : page.locator('aside');
      await cart.getByLabel('Instructions for Paneer Tikka').fill('Less spicy');
      await cart.getByRole('button', { name: 'Send to Kitchen', exact: true }).click();
      await cart.getByRole('button', { name: 'Retry submission', exact: true }).waitFor();
      await cart.getByRole('button', { name: 'Retry submission', exact: true }).click();
      await page.getByText('Already sent soup', { exact: false }).waitFor();
      assert.equal(submissions.length, 2);
      assert.deepEqual(submissions[0], submissions[1]);
      assert.equal(submissions[1].items.length, 1);
      assert.equal(submissions[1].items[0].item_id, 'veg');
      assert.equal(submissions[1].items[0].instructions, 'Less spicy');
      assert.equal(await page.getByRole('button', { name: 'Request Bill', exact: true }).isDisabled(), true);
      orders = orders.map(order => ({ ...order, status: 'prepared' }));
      await page.getByRole('button', { name: 'Refresh orders' }).click();
      await page.getByRole('button', { name: 'Request Bill', exact: true }).click();
      await page.getByRole('button', { name: 'Bill requested', exact: true }).waitFor();
      assert.equal(billRequests, 1);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `/tmp/waiter-orders-${width}.png`, fullPage: true });
      console.log(`PASS ${width}: filters, table drafts, notes, retry payload, sent orders, bill requests, no overflow/errors`);
      await page.close();
    }
    const pos = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const posErrors = [];
    pos.on('pageerror', error => posErrors.push(error.message));
    await pos.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let data = [];
      if (path === '/api/auth/me') data = { role: 'pos', name: 'POS Test', restaurant_id: 'r1' };
      if (path === '/api/restaurant/profile') data = { name: 'Test Restaurant', tax_enabled: false };
      if (path === '/api/pos/summary') data = {};
      if (path === '/api/menu/items') data = [{ item_id: 'veg', name: 'Paneer Tikka', price: 200, available: true }];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
    await pos.route('**/socket.io/**', route => route.abort());
    await pos.goto('http://localhost:3000/pos');
    await pos.getByRole('button', { name: 'Add one Paneer Tikka', exact: true }).click();
    await pos.screenshot({ path: '/tmp/waiter-pos-regression.png' });
    await pos.locator('aside h2').filter({ hasText: 'Your Order (1)' }).waitFor();
    assert.deepEqual(posErrors, []);
    await pos.screenshot({ path: '/tmp/waiter-pos-regression.png' });
    await pos.close();
    console.log('PASS POS: shared menu adds to existing cart without runtime errors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
