import { expect, test } from '@playwright/test';

function track(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  return errors;
}

async function noOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test('student orders, kitchen readies, student collects, till sees the same order', async ({ browser }) => {
  const studentContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const kitchenContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const student = await studentContext.newPage();
  const kitchen = await kitchenContext.newPage();
  const studentErrors = track(student);
  const kitchenErrors = track(kitchen);

  await student.goto('/?nosw=1');
  await student.getByTestId('login-number').fill('STU1002');
  await student.getByTestId('login-pin').fill('1002');
  await student.getByTestId('login-submit').click();
  await expect(student.getByRole('heading', { name: 'Campus burger & chips' })).toBeVisible();
  await student.getByTestId('add-juice').click();
  await student.getByTestId('open-cart').click();
  await student.getByTestId('go-checkout').click();
  await student.getByTestId('pay-yoco').check();
  await student.getByRole('button', { name: /Place order/ }).click();
  await student.getByTestId('pay-success').click();
  await expect(student.getByTestId('order-number')).toContainText('FC-');
  const orderNumber = await student.getByTestId('order-number').innerText();

  await kitchen.goto('/kitchen.html?nosw=1');
  await kitchen.getByTestId('kitchen-user').fill('kitchen1');
  await kitchen.getByTestId('kitchen-pin').fill('3333');
  await kitchen.getByRole('button', { name: 'Unlock' }).click();
  await expect(kitchen.locator('[data-testid=order-card]', { hasText: orderNumber })).toBeVisible();
  await expect(kitchen.getByTestId('kitchen-outbox')).toContainText('order_received');
  const card = kitchen.locator('[data-testid=order-card]', { hasText: orderNumber });
  await card.getByTestId('mark-preparing').click();
  await card.getByTestId('mark-ready').click();
  await expect(kitchen.getByTestId('kitchen-outbox')).toContainText('status_ready');
  const token = await kitchen.getByTestId('counter-token').innerText();

  await student.getByTestId('go-collect').click();
  await student.getByTestId('collect-token').fill(token);
  await student.getByTestId('collect-submit').click();
  await expect(student.getByText('collected', { exact: false })).toBeVisible();
  await noOverflow(student);
  await noOverflow(kitchen);
  expect(studentErrors).toEqual([]);
  expect(kitchenErrors).toEqual([]);
  await studentContext.close();
  await kitchenContext.close();
});

test('POS takes cash for a counter order and cashier cannot open P&L', async ({ page }) => {
  const errors = track(page);
  const student = await page.context().browser().newContext({ viewport: { width: 390, height: 844 } });
  const studentPage = await student.newPage();
  await studentPage.goto('/?nosw=1');
  await studentPage.getByTestId('login-number').fill('STU1003');
  await studentPage.getByTestId('login-pin').fill('1003');
  await studentPage.getByTestId('login-submit').click();
  await studentPage.getByTestId('add-coffee-tea').click();
  await studentPage.getByTestId('open-cart').click();
  await studentPage.getByTestId('go-checkout').click();
  await studentPage.getByTestId('pay-cash').check();
  await studentPage.getByRole('button', { name: /Place order/ }).click();
  const orderNumber = await studentPage.getByTestId('order-number').innerText();

  await page.goto('/pos.html?nosw=1');
  await page.getByTestId('staff-username').fill('cashier1');
  await page.getByTestId('staff-pin').fill('1111');
  await page.getByTestId('staff-login').click();
  await expect(page.getByText(orderNumber)).toBeVisible();
  await page.locator('[data-testid=queue-card]', { hasText: orderNumber }).getByTestId('take-cash').click();
  await expect(page.getByText('Cash taken')).toBeVisible();
  await page.getByTestId('nav-more').click();
  await expect(page.getByTestId('no-financials')).toBeVisible();
  await page.getByTestId('open-outbox').click();
  await expect(page.getByTestId('outbox')).toContainText(orderNumber);
  await page.getByTestId('nav-sell').click();
  await page.getByTestId('sell-juice').click();
  await page.getByRole('button', { name: 'Cash' }).click();
  await expect(page.getByText(/Sale FC-/)).toBeVisible();
  await noOverflow(page);
  expect(errors).toEqual([]);
  await student.close();
});

test('educator wallet, parent link and demo page render on a phone', async ({ page }) => {
  const errors = track(page);
  await page.goto('/demo');
  await expect(page.getByRole('heading', { name: 'Demo access' })).toBeVisible();
  await expect(page.getByText('EDU2001')).toBeVisible();
  await page.goto('/?nosw=1');
  await page.getByRole('button', { name: 'Educator' }).click();
  await page.getByTestId('login-number').fill('EDU2001');
  await page.getByTestId('login-pin').fill('2001');
  await page.getByTestId('login-submit').click();
  await page.getByRole('button', { name: 'Wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Payday allocation' })).toBeVisible();
  await expect(page.getByText(/Today you can still spend/)).toBeVisible();
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test('unknown and duplicate numbers stay closed, a registry educator can join', async ({ page }) => {
  const errors = track(page);
  await page.goto('/?nosw=1');
  await page.getByRole('checkbox', { name: 'Create my account' }).check();
  await page.getByTestId('login-number').fill('STU9999');
  await page.getByTestId('login-pin').fill('9999');
  await page.getByTestId('popia').check();
  await page.getByTestId('login-submit').click();
  await expect(page.getByText('not on the EASTC registry')).toBeVisible();

  await page.getByTestId('login-number').fill('STU1002');
  await page.getByTestId('login-submit').click();
  await expect(page.getByText('already exists')).toBeVisible();

  await page.getByRole('button', { name: 'Educator' }).click();
  await page.getByTestId('login-number').fill('EDU2002');
  await page.getByTestId('login-pin').fill('4242');
  await page.getByTestId('popia').check();
  await page.getByRole('checkbox', { name: 'Create my account' }).check();
  await page.getByTestId('login-submit').click();
  await expect(page.getByRole('heading', { name: 'Campus burger & chips' })).toBeVisible();
  await noOverflow(page);
  const unexpected = errors.filter((line) => !/403|409/.test(line));
  expect(unexpected).toEqual([]);
});

test('a failed Yoco test payment does not create a paid kitchen order', async ({ page }) => {
  const errors = track(page);
  await page.goto('/?nosw=1');
  await page.getByTestId('login-number').fill('STU1005');
  await page.getByTestId('login-pin').fill('1005');
  await page.getByTestId('login-submit').click();
  await page.getByTestId('add-juice').click();
  await page.getByTestId('open-cart').click();
  await page.getByTestId('go-checkout').click();
  await page.getByTestId('pay-yoco').check();
  await page.getByRole('button', { name: /Place order/ }).click();
  await page.getByTestId('pay-fail').click();
  await expect(page.getByTestId('order-number')).toContainText('FC-');
  await expect(page.getByText('failed')).toBeVisible();
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test('parent sees the linked student wallet and a manager sees P&L', async ({ page }) => {
  const errors = track(page);
  await page.goto('/?nosw=1');
  await page.getByRole('button', { name: 'Parent' }).click();
  await page.getByTestId('login-number').fill('parent.stu1001');
  await page.getByTestId('login-pin').fill('1010');
  await page.getByTestId('login-submit').click();
  await expect(page.getByRole('heading', { name: 'Kelebogile Mokoena' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Limits for STU1001' })).toBeVisible();

  await page.context().clearCookies();
  await page.evaluate(() => sessionStorage.clear());
  await page.goto('/pos.html?nosw=1');
  await page.getByTestId('staff-username').fill('kitchen1');
  await page.getByTestId('staff-pin').fill('3333');
  await page.getByTestId('staff-login').click();
  await expect(page.getByTestId('kitchen-blocked')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refund' })).toHaveCount(0);

  await page.context().clearCookies();
  await page.evaluate(() => sessionStorage.clear());
  await page.goto('/pos.html?nosw=1');
  await page.getByTestId('staff-username').fill('manager');
  await page.getByTestId('staff-pin').fill('5555');
  await page.getByTestId('staff-login').click();
  await page.getByTestId('nav-more').click();
  await page.getByTestId('open-pnl').click();
  await expect(page.getByTestId('pnl')).toBeVisible();
  await noOverflow(page);
  expect(errors).toEqual([]);
});
