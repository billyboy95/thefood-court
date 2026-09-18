import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMockOrderApi } from '../js/api/mockBackend.js';
import {
  applyStatus,
  buildOrder,
  formatKitchenWhatsApp,
  kitchenWhatsAppDigits,
  pinMatches,
} from '../js/api/orderService.js';
import { getMenuItem } from '../js/data/menu.js';
import { memoryStorage } from '../js/lib/dom.js';
import { getPickupSlots } from '../js/lib/hours.js';

describe('mock order API', () => {
  it('stores a pickup order and returns it by id', async () => {
    const api = createMockOrderApi(memoryStorage());
    const pickup = getPickupSlots()[0];
    assert.ok(pickup, 'expected at least one pickup slot');

    const order = await api.createOrder({
      customerName: 'Thabo',
      phone: '0821234567',
      pickupTime: pickup.iso,
      notes: 'No chilli',
      items: [
        { itemId: 'campus-burger', qty: 1 },
        { itemId: 'juice', qty: 2 },
      ],
    });

    assert.match(order.orderNumber, /^FC-/);
    assert.equal(order.status, 'received');
    assert.equal(order.totalCents, 6900 + 2000 * 2);
    assert.equal(order.phone, '+27821234567');
    assert.equal(order.payOnCollection, true);

    const loaded = await api.getOrder(order.id);
    assert.equal(loaded.orderNumber, order.orderNumber);
  });

  it('rejects an empty cart and a bad phone', async () => {
    const api = createMockOrderApi(memoryStorage());
    const pickup = getPickupSlots()[0];
    await assert.rejects(
      () =>
        api.createOrder({
          customerName: 'A',
          phone: '0821234567',
          pickupTime: pickup.iso,
          items: [{ itemId: 'campus-burger', qty: 1 }],
        }),
      /name/i,
    );
    await assert.rejects(
      () =>
        api.createOrder({
          customerName: 'Thabo',
          phone: 'nope',
          pickupTime: pickup.iso,
          items: [{ itemId: 'campus-burger', qty: 1 }],
        }),
      /phone/i,
    );
    await assert.rejects(
      () =>
        api.createOrder({
          customerName: 'Thabo',
          phone: '0821234567',
          pickupTime: pickup.iso,
          items: [],
        }),
      /empty/i,
    );
  });

  it('rejects Saturday-only brunch on a weekday pickup', async () => {
    const nowFn = () => new Date('2026-09-16T10:00:00+02:00');
    const api = createMockOrderApi(memoryStorage(), { nowFn });
    const pickup = getPickupSlots(nowFn())[0];
    assert.equal(pickup.dow, 3);
    await assert.rejects(
      () =>
        api.createOrder({
          customerName: 'Thabo',
          phone: '0821234567',
          pickupTime: pickup.iso,
          items: [{ itemId: 'full-brunch', qty: 1 }],
        }),
      /not available/i,
    );
  });

  it('allows Saturday brunch on Saturday', async () => {
    const nowFn = () => new Date('2026-09-19T10:00:00+02:00');
    const api = createMockOrderApi(memoryStorage(), { nowFn });
    const pickup = getPickupSlots(nowFn())[0];
    assert.equal(pickup.dow, 6);
    const order = await api.createOrder({
      customerName: 'Thabo',
      phone: '0821234567',
      pickupTime: pickup.iso,
      items: [{ itemId: 'full-brunch', qty: 1 }],
    });
    assert.equal(order.totalCents, 8900);
  });

  it('lists open kitchen orders and advances status with a PIN', async () => {
    const api = createMockOrderApi(memoryStorage(), { staffPin: '4242' });
    const pickup = getPickupSlots()[0];
    const order = await api.createOrder({
      customerName: 'Lerato',
      phone: '0821234567',
      pickupTime: pickup.iso,
      items: [{ itemId: 'chips', qty: 1 }],
    });

    await assert.rejects(() => api.listOpenOrders('0000'), /pin/i);

    const listed = await api.listOpenOrders('4242');
    assert.equal(listed.demo, true);
    assert.equal(listed.orders[0].id, order.id);

    const preparing = await api.updateOrderStatus(order.id, 'preparing', '4242');
    assert.equal(preparing.status, 'preparing');
    await api.updateOrderStatus(order.id, 'ready', '4242');
    await api.updateOrderStatus(order.id, 'collected', '4242');
    const after = await api.listOpenOrders('4242');
    assert.equal(after.orders.length, 0);
  });
});

describe('order service helpers', () => {
  it('formats a short kitchen WhatsApp and normalizes the till number', () => {
    const msg = formatKitchenWhatsApp({
      orderNumber: 'FC-18123',
      pickupLabel: '12:15',
      customerName: 'Thabo',
      phone: '+27821234567',
      notes: 'No chilli',
      items: [{ qty: 1, name: 'Campus burger & chips' }],
      totalCents: 6900,
    });
    assert.match(msg, /FC-18123/);
    assert.match(msg, /12:15/);
    assert.match(msg, /082 123 4567/);
    assert.match(msg, /Pay at counter/);
    assert.equal(kitchenWhatsAppDigits('+27821234567'), '27821234567');
    assert.equal(kitchenWhatsAppDigits('0821234567'), '27821234567');
  });

  it('only steps status forward one stage', () => {
    const order = { status: 'received', updatedAt: '' };
    assert.equal(applyStatus(order, 'preparing').status, 'preparing');
    assert.throws(() => applyStatus(order, 'ready'), /Received/i);
    assert.equal(pinMatches('1234', '1234'), true);
    assert.equal(pinMatches('1234', '0000'), false);
  });

  it('recomputes totals from the menu, not the client', () => {
    const pickup = getPickupSlots()[0];
    const order = buildOrder(
      {
        customerName: 'Thabo',
        phone: '0821234567',
        pickupTime: pickup.iso,
        items: [{ itemId: 'campus-burger', qty: 2, unitPriceCents: 1 }],
      },
      { getMenuItem },
    );
    assert.equal(order.totalCents, 6900 * 2);
    assert.equal(order.payOnCollection, true);
  });
});
