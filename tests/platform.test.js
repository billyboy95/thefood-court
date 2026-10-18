import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import { pkceS256, randomToken } from '../server/crypto.js';
import { createApp } from '../server/app.js';

function cookieClient(base) {
  const jar = new Map();
  const api = {
    token: '',
    async call(pathname, { method = 'GET', json, form, headers = {}, redirect } = {}) {
      const head = { ...headers };
      if (json !== undefined) {
        head['content-type'] = 'application/json';
      }
      if (form) head['content-type'] = 'application/x-www-form-urlencoded';
      if (api.token) head.authorization = `Bearer ${api.token}`;
      if (jar.size) head.cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
      const res = await fetch(base + pathname, {
        method,
        headers: head,
        redirect: redirect || 'follow',
        body: json !== undefined ? JSON.stringify(json) : form ? new URLSearchParams(form) : undefined,
      });
      for (const line of res.headers.getSetCookie?.() || []) {
        const pair = line.split(';')[0];
        const eq = pair.indexOf('=');
        const key = pair.slice(0, eq);
        const value = decodeURIComponent(pair.slice(eq + 1));
        jar.set(key, value);
        if (key === 'fc_access') api.token = value;
      }
      const text = await res.text();
      let data = text;
      try { data = text ? JSON.parse(text) : null; } catch { /* html */ }
      return { status: res.status, data, text, headers: res.headers };
    },
  };
  return api;
}

async function boot(env = {}) {
  const dbPath = path.join(os.tmpdir(), `fc-${randomToken(6)}.sqlite`);
  const app = createApp({ dbPath, env });
  const base = await app.listen(0);
  return { app, base, api: cookieClient(base), dbPath };
}

describe('EASTC food court platform', { concurrency: 1 }, () => {
  let ctx;
  before(async () => {
    ctx = await boot();
  });
  after(async () => {
    await ctx.app.close();
    fs.rmSync(ctx.dbPath, { force: true });
  });

  it('rejects unknown, duplicate and public signups, and lets a registry educator join', async () => {
    const bad = await ctx.api.call('/api/auth/student/register', { method: 'POST', json: { studentNumber: 'STU9999', pin: '1234', popiaAccepted: true } });
    assert.equal(bad.status, 403);
    const dupe = await ctx.api.call('/api/auth/student/register', { method: 'POST', json: { studentNumber: 'STU1001', pin: '1001', popiaAccepted: true } });
    assert.equal(dupe.status, 409);
    const fresh = await ctx.api.call('/api/auth/student/register', { method: 'POST', json: { studentNumber: 'STU1004', pin: '1004', popiaAccepted: true } });
    assert.equal(fresh.status, 201);
    const again = await ctx.api.call('/api/auth/student/register', { method: 'POST', json: { studentNumber: 'STU1004', pin: '1004', popiaAccepted: true } });
    assert.equal(again.status, 409);
    const noPopia = await ctx.api.call('/api/auth/educator/register', { method: 'POST', json: { staffNumber: 'EDU2002', pin: '2002', popiaAccepted: false } });
    assert.equal(noPopia.status, 400);
    const unknownStaff = await ctx.api.call('/api/auth/educator/register', { method: 'POST', json: { staffNumber: 'EDU9999', pin: '2002', popiaAccepted: true } });
    assert.equal(unknownStaff.status, 403);
    const edu = await ctx.api.call('/api/auth/educator/register', { method: 'POST', json: { staffNumber: 'EDU2002', pin: '2002', popiaAccepted: true } });
    assert.equal(edu.status, 201);
    assert.equal(edu.data.user.kind, 'educator');
    const eduDupe = await ctx.api.call('/api/auth/educator/register', { method: 'POST', json: { staffNumber: 'EDU2002', pin: '2222', popiaAccepted: true } });
    assert.equal(eduDupe.status, 409);
  });

  it('rate-limits orders for a student', async () => {
    const manager = cookieClient(ctx.base);
    const login = await manager.call('/api/auth/staff/login', { method: 'POST', json: { username: 'manager', pin: '5555' } });
    assert.equal(login.status, 200);
    const patched = await manager.call('/api/settings', { method: 'PATCH', json: { orderRatePer10Min: 2, unpaidCashCap: 9 } });
    assert.equal(patched.status, 200);
    const student = cookieClient(ctx.base);
    assert.equal((await student.call('/api/auth/member/login', { method: 'POST', json: { number: 'STU1005', pin: '1005' } })).status, 200);
    const menu = await student.call('/api/menu');
    const slot = menu.data.slots[0].iso;
    const place = () => student.call('/api/orders', { method: 'POST', json: { items: [{ itemId: 'juice', qty: 1 }], pickupTime: slot, method: 'cash', notes: 'rate' } });
    assert.equal((await place()).status, 201);
    assert.equal((await place()).status, 201);
    const blocked = await place();
    assert.equal(blocked.status, 429);
    await manager.call('/api/settings', { method: 'PATCH', json: { orderRatePer10Min: 8, unpaidCashCap: 2 } });
  });

  it('pays with a verified Yoco webhook, rejects a bad signature, and keeps failures out of the kitchen', async () => {
    const student = cookieClient(ctx.base);
    await student.call('/api/auth/member/login', { method: 'POST', json: { number: 'STU1002', pin: '1002' } });
    const menu = await student.call('/api/menu');
    const slot = menu.data.slots[0].iso;
    const created = await student.call('/api/orders', {
      method: 'POST',
      json: { items: [{ itemId: 'juice', qty: 1 }], pickupTime: slot, method: 'yoco_card', notes: 'no ice' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.order.paymentStatus, 'pending');
    assert.match(created.data.payment.checkoutUrl, /\/pay\/test\//);
    const bad = await ctx.api.call('/api/yoco/webhook', {
      method: 'POST',
      json: { type: 'payment.succeeded', data: { amount: 1, metadata: { intentId: created.data.payment.id } } },
      headers: { 'webhook-id': 'bad', 'webhook-timestamp': String(Math.floor(Date.now() / 1000)), 'webhook-signature': 'v1,nope' },
    });
    assert.equal(bad.status, 401);
    const failedOrder = await student.call('/api/orders', {
      method: 'POST',
      json: { items: [{ itemId: 'chips', qty: 1 }], pickupTime: slot, method: 'yoco_card' },
    });
    const failPay = await student.call(failedOrder.data.payment.checkoutUrl, { method: 'POST', form: { outcome: 'failed' }, redirect: 'manual' });
    assert.equal(failPay.status, 302);
    const failed = await student.call(`/api/orders/${failedOrder.data.order.id}`);
    assert.equal(failed.data.paymentStatus, 'failed');
    assert.equal(failed.data.fulfillment, 'failed');
    const okPay = await student.call(created.data.payment.checkoutUrl, { method: 'POST', form: { outcome: 'succeeded' }, redirect: 'manual' });
    assert.equal(okPay.status, 302);
    const paid = await student.call(`/api/orders/${created.data.order.id}`);
    assert.equal(paid.data.paymentStatus, 'paid');
    assert.equal(paid.data.fulfillment, 'paid');
    const cashier = cookieClient(ctx.base);
    await cashier.call('/api/auth/staff/login', { method: 'POST', json: { username: 'cashier1', pin: '1111' } });
    const queue = await cashier.call('/api/pos/queue');
    assert.ok(queue.data.orders.some((order) => order.id === created.data.order.id));
    const kitchen = cookieClient(ctx.base);
    await kitchen.call('/api/auth/staff/login', { method: 'POST', json: { username: 'kitchen1', pin: '3333' } });
    const board = await kitchen.call('/api/kitchen/orders');
    assert.ok(board.data.orders.some((order) => order.id === created.data.order.id));
    assert.equal(board.data.orders.some((order) => order.id === failedOrder.data.order.id), false);
    const outbox = await kitchen.call('/api/outbox');
    const mine = outbox.data.filter((row) => row.order_id === created.data.order.id);
    assert.ok(mine.some((row) => row.event === 'order_received' && row.audience === 'kitchen'));
    assert.ok(mine.some((row) => row.event === 'payment_received'));
    assert.equal(mine.every((row) => row.provider === 'mock'), true);
  });

  it('takes cash on the same order, counts it in cash-up, and expires unpaid cash', async () => {
    let now = new Date('2026-10-19T09:00:00+02:00');
    const dbPath = path.join(os.tmpdir(), `fc-cash-${randomToken(4)}.sqlite`);
    const app = createApp({ dbPath, now: () => now });
    const base = await app.listen(0);
    const student = cookieClient(base);
    const cashier = cookieClient(base);
    await student.call('/api/auth/member/login', { method: 'POST', json: { number: 'STU1003', pin: '1003' } });
    const menu = await student.call('/api/menu');
    const slot = menu.data.slots[0].iso;
    const order = await student.call('/api/orders', { method: 'POST', json: { items: [{ itemId: 'coffee-tea', qty: 1 }], pickupTime: slot, method: 'cash', notes: 'oat' } });
    assert.equal(order.data.order.paymentStatus, 'unpaid');
    assert.equal(order.data.order.fulfillment, 'cash_pending');
    await cashier.call('/api/auth/staff/login', { method: 'POST', json: { username: 'cashier1', pin: '1111' } });
    const before = await cashier.call('/api/pos/cashup');
    const hidden = await cookieClient(base);
    await hidden.call('/api/auth/staff/login', { method: 'POST', json: { username: 'kitchen1', pin: '3333' } });
    const board = await hidden.call('/api/kitchen/orders');
    assert.equal(board.data.orders.some((row) => row.id === order.data.order.id), false);
    const taken = await cashier.call(`/api/orders/${order.data.order.id}/cash`, { method: 'POST', json: { tenderedCents: 5000 } });
    assert.equal(taken.status, 200);
    assert.equal(taken.data.paymentStatus, 'paid');
    assert.equal(taken.data.changeCents, 5000 - order.data.order.totalCents);
    assert.equal(taken.data.fulfillment, 'paid');
    const after = await cashier.call('/api/pos/cashup');
    assert.equal(after.data.cashSalesCents - before.data.cashSalesCents, order.data.order.totalCents);
    const shown = await hidden.call('/api/kitchen/orders');
    assert.ok(shown.data.orders.some((row) => row.id === order.data.order.id));
    const late = await student.call('/api/orders', { method: 'POST', json: { items: [{ itemId: 'juice', qty: 1 }], pickupTime: slot, method: 'cash' } });
    now = new Date(now.getTime() + 21 * 60 * 1000);
    await cashier.call('/api/pos/queue');
    const expired = await student.call(`/api/orders/${late.data.order.id}`);
    assert.equal(expired.data.fulfillment, 'expired');
    const refuse = await cashier.call(`/api/orders/${late.data.order.id}/cash`, { method: 'POST', json: { tenderedCents: 5000 } });
    assert.equal(refuse.status, 410);
    await app.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('moves kitchen status, writes the outbox, and collects once with a rotating counter code', async () => {
    const student = cookieClient(ctx.base);
    const other = cookieClient(ctx.base);
    const kitchen = cookieClient(ctx.base);
    await student.call('/api/auth/member/login', { method: 'POST', json: { number: 'STU1003', pin: '1003' } });
    await other.call('/api/auth/member/login', { method: 'POST', json: { number: 'STU1005', pin: '1005' } });
    await kitchen.call('/api/auth/staff/login', { method: 'POST', json: { username: 'kitchen1', pin: '3333' } });
    const menu = await student.call('/api/menu');
    const created = await student.call('/api/orders', {
      method: 'POST',
      json: { items: [{ itemId: 'chips', qty: 1 }], pickupTime: menu.data.slots[0].iso, method: 'yoco_card' },
    });
    await student.call(created.data.payment.checkoutUrl, { method: 'POST', form: { outcome: 'succeeded' }, redirect: 'manual' });
    const unpaid = await student.call('/api/orders', {
      method: 'POST',
      json: { items: [{ itemId: 'juice', qty: 1 }], pickupTime: menu.data.slots[0].iso, method: 'cash' },
    });
    const qr = await kitchen.call('/api/kitchen/counter-qr');
    const unpaidCollect = await student.call('/api/collect/counter', { method: 'POST', json: { token: qr.data.token } });
    assert.equal(unpaidCollect.status, 404);
    assert.equal((await kitchen.call(`/api/orders/${created.data.order.id}/status`, { method: 'POST', json: { status: 'preparing' } })).status, 200);
    assert.equal((await kitchen.call(`/api/orders/${created.data.order.id}/status`, { method: 'POST', json: { status: 'ready' } })).status, 200);
    const messages = await kitchen.call(`/api/outbox?orderId=${created.data.order.id}`);
    assert.ok(messages.data.some((row) => row.event === 'status_preparing' && row.channel === 'whatsapp'));
    assert.ok(messages.data.some((row) => row.event === 'status_ready' && row.channel === 'whatsapp'));
    assert.ok(messages.data.some((row) => row.event === 'status_ready' && row.channel === 'sms'));
    const notes = await student.call('/api/notifications');
    assert.ok(notes.data.some((row) => /ready/i.test(row.body)));
    const wrong = await other.call('/api/collect/counter', { method: 'POST', json: { token: qr.data.token } });
    assert.equal(wrong.status, 404);
    const still = await student.call(`/api/orders/${created.data.order.id}`);
    assert.equal(still.data.fulfillment, 'ready');
    const got = await student.call('/api/collect/counter', { method: 'POST', json: { token: qr.data.token } });
    assert.equal(got.status, 200);
    assert.equal(got.data.fulfillment, 'collected');
    const replay = await student.call('/api/collect/counter', { method: 'POST', json: { token: qr.data.token } });
    assert.equal(replay.status, 404);
    const staffReplay = await kitchen.call('/api/collect/order', { method: 'POST', json: { token: still.data.orderQr } });
    assert.equal(staffReplay.status, 409);
    assert.equal((await student.call(`/api/orders/${unpaid.data.order.id}`)).data.fulfillment, 'cash_pending');
  });

  it('sells, refunds and voids on the POS and keeps an audit trail', async () => {
    const cashier = cookieClient(ctx.base);
    const kitchen = cookieClient(ctx.base);
    const manager = cookieClient(ctx.base);
    await cashier.call('/api/auth/staff/login', { method: 'POST', json: { username: 'cashier1', pin: '1111' } });
    await kitchen.call('/api/auth/staff/login', { method: 'POST', json: { username: 'kitchen1', pin: '3333' } });
    await manager.call('/api/auth/staff/login', { method: 'POST', json: { username: 'manager', pin: '5555' } });
    const before = await manager.call('/api/menu');
    const stockBefore = before.data.items.find((item) => item.id === 'juice').stockQty;
    const sale = await cashier.call('/api/pos/sales', { method: 'POST', json: { items: [{ itemId: 'juice', qty: 1 }], method: 'cash', tenderedCents: 5000, customerName: 'Walk-in' } });
    assert.equal(sale.status, 201);
    assert.equal(sale.data.order.paymentStatus, 'paid');
    const refundDenied = await kitchen.call(`/api/orders/${sale.data.order.id}/refund`, { method: 'POST', json: { reason: 'Kitchen should not refund' } });
    assert.equal(refundDenied.status, 403);
    const refunded = await cashier.call(`/api/orders/${sale.data.order.id}/refund`, { method: 'POST', json: { reason: 'Wrong drink' } });
    assert.equal(refunded.status, 200);
    assert.equal(refunded.data.fulfillment, 'refunded');
    const menuAfter = await manager.call('/api/menu');
    assert.equal(menuAfter.data.items.find((item) => item.id === 'juice').stockQty, stockBefore);
    const voidSale = await cashier.call('/api/pos/sales', { method: 'POST', json: { items: [{ itemId: 'chips', qty: 1 }], method: 'cash', tenderedCents: 4000 } });
    const voided = await cashier.call(`/api/orders/${voidSale.data.order.id}/void`, { method: 'POST', json: { reason: 'Rang up twice' } });
    assert.equal(voided.data.fulfillment, 'voided');
    const audit = await manager.call('/api/audit');
    assert.ok(audit.data.some((row) => row.action === 'refund'));
    assert.ok(audit.data.some((row) => row.action === 'void'));
  });

  it('hides financials from the cashier and kitchen, and shows them to finance', async () => {
    const cashier = cookieClient(ctx.base);
    const kitchen = cookieClient(ctx.base);
    const finance = cookieClient(ctx.base);
    await cashier.call('/api/auth/staff/login', { method: 'POST', json: { username: 'cashier1', pin: '1111' } });
    await kitchen.call('/api/auth/staff/login', { method: 'POST', json: { username: 'kitchen1', pin: '3333' } });
    await finance.call('/api/auth/staff/login', { method: 'POST', json: { username: 'finance', pin: '6666' } });
    assert.equal((await cashier.call('/api/reports/pnl')).status, 403);
    assert.equal((await kitchen.call('/api/reports/pnl')).status, 403);
    assert.equal((await kitchen.call('/api/reports/sales')).status, 403);
    const own = await cashier.call('/api/reports/sales');
    assert.equal(own.status, 200);
    assert.equal(own.data.tillId, 'till-1');
    const pnl = await finance.call('/api/reports/pnl?range=month');
    assert.equal(pnl.status, 200);
    assert.equal(pnl.data.profitCents, pnl.data.salesCents - pnl.data.cogsCents - pnl.data.expensesCents);
    assert.equal(pnl.data.trial.balanced, true);
    const csv = await finance.call('/api/reports/sales.csv?range=month');
    assert.match(csv.text, /order_number/);
    assert.match(csv.text, /cash|yoco/);
  });

  it('receives stock, approves expenses, and keeps the P&L accurate', async () => {
    const manager = cookieClient(ctx.base);
    const finance = cookieClient(ctx.base);
    await manager.call('/api/auth/staff/login', { method: 'POST', json: { username: 'manager', pin: '5555' } });
    await finance.call('/api/auth/staff/login', { method: 'POST', json: { username: 'finance', pin: '6666' } });
    const before = await finance.call('/api/reports/pnl?range=month');
    const stockBefore = (await manager.call('/api/menu')).data.items.find((item) => item.id === 'salad-box').stockQty;
    const supplier = await manager.call('/api/suppliers', { method: 'POST', json: { name: 'Campus Grocer', phone: '+27821112222' } });
    const po = await manager.call('/api/purchase-orders', {
      method: 'POST',
      json: { supplierId: supplier.data.id, lines: [{ itemId: 'salad-box', qty: 4, unitCostCents: 1500, description: 'Salad' }] },
    });
    assert.equal((await manager.call(`/api/purchase-orders/${po.data.id}/receive`, { method: 'POST', json: {} })).status, 200);
    const stockAfter = (await manager.call('/api/menu')).data.items.find((item) => item.id === 'salad-box').stockQty;
    assert.equal(stockAfter, stockBefore + 4);
    const expense = await finance.call('/api/expenses', { method: 'POST', json: { category: 'gas', amountCents: 2500, note: 'Cylinder', receiptBase64: Buffer.from('receipt').toString('base64') } });
    assert.equal((await finance.call(`/api/expenses/${expense.data.id}/decide`, { method: 'POST', json: { decision: 'approved' } })).status, 403);
    assert.equal((await manager.call(`/api/expenses/${expense.data.id}/decide`, { method: 'POST', json: { decision: 'approved' } })).status, 200);
    const cashier = cookieClient(ctx.base);
    await cashier.call('/api/auth/staff/login', { method: 'POST', json: { username: 'cashier2', pin: '2222' } });
    const sale = await cashier.call('/api/pos/sales', { method: 'POST', json: { items: [{ itemId: 'salad-box', qty: 1 }], method: 'cash', tenderedCents: 5000 } });
    assert.equal(sale.status, 201);
    const after = await finance.call('/api/reports/pnl?range=month');
    assert.equal(after.data.salesCents - before.data.salesCents, 4200);
    assert.equal(after.data.expensesCents - before.data.expensesCents, 2500);
    assert.equal(after.data.cogsCents - before.data.cogsCents, 1500);
    assert.equal(after.data.profitCents - before.data.profitCents, 4200 - 1500 - 2500);
    const price = await manager.call('/api/menu/salad-box', { method: 'PATCH', json: { priceCents: 4500 } });
    assert.equal(price.status, 200);
    const audit = await manager.call('/api/audit');
    assert.ok(audit.data.some((row) => row.action === 'price_change'));
    assert.equal((await cashier.call('/api/menu/salad-box', { method: 'PATCH', json: { priceCents: 100 } })).status, 403);
  });

  it('funds wallets, enforces the daily allowance, and records a payroll instruction', async () => {
    const parent = cookieClient(ctx.base);
    const student = cookieClient(ctx.base);
    await parent.call('/api/auth/parent/login', { method: 'POST', json: { username: 'parent.stu1001', pin: '1010' } });
    const topup = await parent.call('/api/wallet/topup', { method: 'POST', json: { amountCents: 20000, method: 'yoco_card' } });
    assert.equal(topup.status, 201);
    await parent.call(topup.data.checkoutUrl, { method: 'POST', form: { outcome: 'succeeded' }, redirect: 'manual' });
    const funded = await parent.call('/api/wallet');
    assert.equal(funded.data.balanceCents, 20000);
    assert.ok(funded.data.history.length >= 1);
    assert.equal(funded.data.dailyAllowance.enabled, true);
    assert.ok(funded.data.dailyAllowance.remainingTodayCents < 6900);
    await student.call('/api/auth/member/login', { method: 'POST', json: { number: 'STU1001', pin: '1001' } });
    const menu = await student.call('/api/menu');
    const tooMuch = await student.call('/api/orders', {
      method: 'POST',
      json: { items: [{ itemId: 'campus-burger', qty: 1 }], pickupTime: menu.data.slots[0].iso, method: 'wallet' },
    });
    assert.equal(tooMuch.status, 402);
    const ok = await student.call('/api/orders', {
      method: 'POST',
      json: { items: [{ itemId: 'juice', qty: 1 }], pickupTime: menu.data.slots[0].iso, method: 'wallet' },
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.order.paymentStatus, 'paid');
    const afterSpend = await student.call('/api/wallet');
    assert.equal(afterSpend.data.balanceCents, 18000);
    assert.equal(afterSpend.data.dailyAllowance.remainingTodayCents, funded.data.dailyAllowance.remainingTodayCents - 2000);
    const educator = cookieClient(ctx.base);
    await educator.call('/api/auth/member/login', { method: 'POST', json: { number: 'EDU2001', pin: '2001' } });
    const noConsent = await educator.call('/api/wallet/salary-allocation', { method: 'POST', json: { mode: 'amount', amountCents: 50000, paydayDay: 15, consent: false } });
    assert.equal(noConsent.status, 400);
    const saved = await educator.call('/api/wallet/salary-allocation', { method: 'POST', json: { mode: 'percent', percent: 10, paydayDay: 1, consent: true } });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.salaryAllocation.status, 'active');
    const instructions = await educator.call('/api/payroll/instructions');
    assert.ok(instructions.data.some((row) => row.adapter === 'placeholder' && row.status === 'queued'));
    const finance = cookieClient(ctx.base);
    await finance.call('/api/auth/staff/login', { method: 'POST', json: { username: 'finance', pin: '6666' } });
    const queued = instructions.data.find((row) => row.status === 'queued');
    const applied = await finance.call(`/api/payroll/instructions/${queued.id}/apply`, { method: 'POST', json: {} });
    assert.equal(applied.data.status, 'applied');
    const rich = await educator.call('/api/wallet');
    assert.equal(rich.data.balanceCents, 250000);
    const cancelled = await educator.call('/api/wallet/salary-allocation/cancel', { method: 'POST', json: {} });
    assert.equal(cancelled.data.salaryAllocation.status, 'cancelled');
    const cashier = cookieClient(ctx.base);
    await cashier.call('/api/auth/staff/login', { method: 'POST', json: { username: 'cashier1', pin: '1111' } });
    const cashTop = await cashier.call('/api/pos/wallet-topup', { method: 'POST', json: { memberNumber: 'EDU2001', amountCents: 3000, tenderedCents: 5000 } });
    assert.equal(cashTop.status, 200);
    assert.equal(cashTop.data.changeCents, 2000);
    assert.equal((await educator.call('/api/wallet')).data.balanceCents, 253000);
  });

  it('charges a one-time wallet tap and reconciles SoftPOS without reading a bank card', async () => {
    const student = cookieClient(ctx.base);
    const cashier = cookieClient(ctx.base);
    await student.call('/api/auth/member/login', { method: 'POST', json: { number: 'STU1002', pin: '1002' } });
    const topup = await student.call('/api/wallet/topup', { method: 'POST', json: { amountCents: 15000, method: 'yoco_eft' } });
    await student.call(topup.data.checkoutUrl, { method: 'POST', form: { outcome: 'eft' }, redirect: 'manual' });
    const tap = await student.call('/api/wallet/tap-token', { method: 'POST', json: {} });
    assert.match(tap.data.token, /^fwt1\./);
    await cashier.call('/api/auth/staff/login', { method: 'POST', json: { username: 'cashier1', pin: '1111' } });
    const charged = await cashier.call('/api/pos/wallet-tap', { method: 'POST', json: { token: tap.data.token, items: [{ itemId: 'coffee-tea', qty: 1 }] } });
    assert.equal(charged.status, 200);
    assert.equal(charged.data.order.paymentMethod, 'wallet');
    const replay = await cashier.call('/api/pos/wallet-tap', { method: 'POST', json: { token: tap.data.token, items: [{ itemId: 'coffee-tea', qty: 1 }] } });
    assert.equal(replay.status, 409);
    const soft = await cashier.call('/api/pos/sales', { method: 'POST', json: { items: [{ itemId: 'chips', qty: 1 }], method: 'softpos' } });
    assert.equal(soft.data.payment.browserCardRead, false);
    assert.match(soft.data.payment.note, /cannot read a contactless bank card/i);
    assert.match(soft.data.payment.softposDeepLink, /^yoco:\/\/softpos/);
    const rec = await cashier.call(`/api/payments/v1/intents/${soft.data.payment.id}/softpos-reference`, { method: 'POST', json: { yocoReference: 'yc_test_98431' } });
    assert.equal(rec.data.status, 'succeeded');
    assert.equal(rec.data.yocoReference, 'yc_test_98431');
  });

  it('keeps one identity across entities and refreshes a remembered session', async () => {
    const owner = cookieClient(ctx.base);
    const first = await owner.call('/api/auth/staff/login', { method: 'POST', json: { username: 'billy', pin: '0000', remember: true } });
    assert.equal(first.data.user.entity, 'food-court');
    assert.ok(first.data.deviceId);
    const refresh = first.headers.getSetCookie().find((line) => line.startsWith('fc_refresh='));
    const oldRefresh = decodeURIComponent(refresh.split(';')[0].split('=')[1]);
    const rotated = await owner.call('/api/auth/refresh', { method: 'POST', json: {} });
    assert.equal(rotated.status, 200);
    owner.token = '';
    const stale = await fetch(`${ctx.base}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `fc_refresh=${oldRefresh}` },
      body: '{}',
    });
    assert.equal(stale.status, 401);
    const switched = await owner.call('/api/auth/entity', { method: 'POST', json: { entityId: 'eastc-foundation' } });
    assert.equal(switched.status, 200);
    assert.equal(switched.data.user.entity, 'eastc-foundation');
    const donation = await owner.call('/api/payments/v1/intents', {
      method: 'POST',
      json: { entity: 'eastc-foundation', purpose: 'donation', method: 'yoco_card', amountCents: 5000 },
    });
    assert.equal(donation.status, 201);
    assert.equal(donation.data.entityId, 'eastc-foundation');
    const cashier = cookieClient(ctx.base);
    await cashier.call('/api/auth/staff/login', { method: 'POST', json: { username: 'cashier1', pin: '1111' } });
    assert.equal((await cashier.call('/api/auth/entity', { method: 'POST', json: { entityId: 'holdings' } })).status, 403);
    const verifier = randomToken();
    const start = await owner.call(`/oauth/authorize?client_id=eastc-crm&redirect_uri=${encodeURIComponent('http://localhost:5173/oauth/callback')}&code_challenge=${pkceS256(verifier)}&code_challenge_method=S256&state=demo`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const code = new URL(start.headers.get('location')).searchParams.get('code');
    const token = await owner.call('/oauth/token', {
      method: 'POST',
      form: { grant_type: 'authorization_code', code, client_id: 'eastc-crm', redirect_uri: 'http://localhost:5173/oauth/callback', code_verifier: verifier },
    });
    assert.equal(token.status, 200);
    assert.ok(token.data.access_token);
    const imported = await cookieClient(ctx.base);
    await imported.call('/api/auth/staff/login', { method: 'POST', json: { username: 'manager', pin: '5555' } });
    const csv = await imported.call('/api/students/import', { method: 'POST', json: { csv: 'student_number,full_name,phone\nSTU3001,New Student,0823001001' } });
    assert.equal(csv.data.added, 1);
  });
});
