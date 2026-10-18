import { expect, test } from '@playwright/test';
import fs from 'node:fs';

const dir = '/opt/cursor/artifacts/screenshots';

async function shot(page, name) {
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png` });
}

test('capture phone screens for the review', async ({ browser }) => {
  const studentContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const staffContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const student = await studentContext.newPage();
  const staff = await staffContext.newPage();

  await student.goto('/demo');
  await expect(student.getByRole('heading', { name: 'Demo access' })).toBeVisible();
  await shot(student, '01-demo-logins');

  const links = await student.locator('a').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')));
  for (const href of links) {
    const response = await student.request.get(href);
    expect(response.status(), href).toBeLessThan(400);
  }

  await student.goto('/?nosw=1');
  await student.getByTestId('login-number').fill('STU1002');
  await student.getByTestId('login-pin').fill('1002');
  await student.getByTestId('login-submit').click();
  await expect(student.getByRole('heading', { name: 'Campus burger & chips' })).toBeVisible();
  await shot(student, '02-student-menu');
  await student.getByTestId('add-juice').click();
  await student.getByTestId('open-cart').click();
  await student.getByTestId('go-checkout').click();
  await shot(student, '03-checkout');
  await student.getByRole('button', { name: /Place order/ }).click();
  await expect(student.getByTestId('pay-success')).toBeVisible();
  await shot(student, '04-yoco-test');
  await student.getByTestId('pay-success').click();
  await expect(student.getByTestId('order-number')).toContainText('FC-');
  await shot(student, '05-order-paid');

  await staff.goto('/kitchen.html?nosw=1');
  await staff.getByTestId('kitchen-user').fill('kitchen1');
  await staff.getByTestId('kitchen-pin').fill('3333');
  await staff.getByRole('button', { name: 'Unlock' }).click();
  await expect(staff.getByTestId('counter-token')).toBeVisible();
  await shot(staff, '06-kitchen-qr');

  await student.context().clearCookies();
  await student.evaluate(() => sessionStorage.clear());
  await student.goto('/?nosw=1');
  await student.getByRole('button', { name: 'Educator' }).click();
  await student.getByTestId('login-number').fill('EDU2001');
  await student.getByTestId('login-pin').fill('2001');
  await student.getByTestId('login-submit').click();
  await student.getByRole('button', { name: 'Wallet' }).click();
  await expect(student.getByRole('heading', { name: 'Payday allocation' })).toBeVisible();
  await shot(student, '07-educator-wallet');

  await staff.context().clearCookies();
  await staff.evaluate(() => sessionStorage.clear());
  await staff.goto('/pos.html?nosw=1');
  await staff.getByTestId('staff-username').fill('manager');
  await staff.getByTestId('staff-pin').fill('5555');
  await staff.getByTestId('staff-login').click();
  await staff.getByTestId('nav-more').click();
  await staff.getByTestId('open-pnl').click();
  await expect(staff.getByTestId('pnl')).toBeVisible();
  await expect(staff.getByTestId('pnl-sales')).toHaveText('Sales R20.00');
  await shot(staff, '08-manager-pnl');

  await studentContext.close();
  await staffContext.close();
});
