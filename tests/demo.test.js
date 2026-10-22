import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMockOrderApi } from '../js/api/mockBackend.js';
import { memoryStorage } from '../js/lib/dom.js';

function api(seedDemo = true) {
  return createMockOrderApi(memoryStorage(), { seedDemo });
}

describe('demo mode', () => {
  it('seeds labelled sample students and a ready counter order', async () => {
    const store = api(true);
    const wallet = await store.signInStudent({ studentNumber: '20240002', pin: '1234' });
    assert.equal(wallet.fullName, 'Lerato Nkosi');
    const view = await store.getWallet();
    assert.match(view.demoLabel, /Sample demo data/);
    assert.equal(view.student.balanceCents, 3500);
    assert.ok(view.orders.length > 0);
    assert.ok(view.ledger.length > 0);
    const counter = await store.listReady();
    assert.ok(counter.orders.some((order) => order.status === 'ready'));
    const stock = await store.getStock('1234');
    assert.ok(stock.suggestions.some((row) => row.name === 'Salad mix'));
  });

  it('redeems a free meal and refuses an empty wallet', async () => {
    const store = api(true);
    await store.signInStudent({ studentNumber: '20240002', pin: '1234' });
    const slot = (await store.getPickupSlots()).find((item) => !item.full);
    assert.ok(slot);
    const order = await store.createOrder({
      customerName: 'Lerato Nkosi',
      phone: '0829876543',
      pickupTime: slot.iso,
      paymentMethod: 'wallet',
      items: [{ itemId: 'campus-burger', qty: 1 }],
    });
    assert.equal(order.totalCents, 0);
    assert.equal(order.loyaltyRedeemed, true);
    assert.equal(order.paymentStatus, 'paid');
    const after = await store.getWallet();
    assert.equal(after.student.balanceCents, 3500);
    assert.equal(after.student.loyaltyStamps, 0);

    const empty = api(true);
    await empty.signInStudent({ studentNumber: '20240003', pin: '1234' });
    const later = (await empty.getPickupSlots()).find((item) => !item.full);
    await assert.rejects(
      () => empty.createOrder({
        customerName: 'Amahle Dlamini',
        phone: '0761112233',
        pickupTime: later.iso,
        paymentMethod: 'wallet',
        items: [{ itemId: 'campus-burger', qty: 1 }],
      }),
      /Insufficient wallet balance/,
    );
  });

  it('skips WhatsApp when a manager runs the low-balance job', async () => {
    const store = api(true);
    const result = await store.runAutomations('1234', 'low-balance');
    const run = result.runs.find((row) => row.job === 'low-balance');
    assert.equal(run.status, 'skipped');
    assert.match(run.detail, /nothing was sent|Would|under/i);
  });

  it('keeps pay on collection when the method is omitted', async () => {
    const store = api(false);
    const slot = (await store.getPickupSlots())[0];
    const order = await store.createOrder({
      customerName: 'Thabo',
      phone: '0821234567',
      pickupTime: slot.iso,
      items: [{ itemId: 'chips', qty: 1 }],
    });
    assert.equal(order.payOnCollection, true);
    assert.equal(order.paymentMethod, 'cash');
  });
});
