import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMockOrderApi } from '../js/api/mockBackend.js';
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
});
