import { getMenu, getMenuItem } from '../data/menu.js';
import { cartTotals } from '../lib/money.js';
import { makeOrderId, makeOrderNumber } from '../lib/ids.js';
import { normalizeSaPhone } from '../lib/phone.js';
import { getPickupSlots } from '../lib/hours.js';

const ORDERS_KEY = 'foodcourt.orders.v1';

function readOrders(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(ORDERS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeOrders(storage, orders) {
  storage.setItem(ORDERS_KEY, JSON.stringify(orders));
}

/**
 * In-browser kitchen queue. Swap this for createHttpOrderApi() in client.js.
 */
export function createMockOrderApi(storage) {
  return {
    async getMenu() {
      return getMenu();
    },

    async createOrder(input) {
      const name = String(input?.customerName ?? '').trim();
      if (name.length < 2) {
        throw new Error('Please enter your name.');
      }

      const phone = normalizeSaPhone(input?.phone);
      if (!phone) {
        throw new Error('Enter a valid South African phone number.');
      }

      const pickupTime = String(input?.pickupTime ?? '');
      const slots = getPickupSlots();
      const slot = slots.find((s) => s.iso === pickupTime);
      if (!slot) {
        throw new Error('Choose a pickup time from the list.');
      }

      const requested = Array.isArray(input?.items) ? input.items : [];
      const totals = cartTotals(requested, getMenuItem);
      if (!totals.itemCount) {
        throw new Error('Your cart is empty.');
      }

      const now = new Date();
      const order = {
        id: makeOrderId(now),
        orderNumber: makeOrderNumber(now),
        status: 'received',
        customerName: name,
        phone,
        pickupTime: slot.iso,
        pickupLabel: slot.label,
        notes: String(input?.notes ?? '').trim().slice(0, 240),
        items: totals.lines.map((line) => ({
          itemId: line.itemId,
          name: line.item.name,
          qty: line.qty,
          unitPriceCents: line.item.priceCents,
          lineTotalCents: line.lineTotal,
        })),
        itemCount: totals.itemCount,
        totalCents: totals.totalCents,
        payOnCollection: true,
        createdAt: now.toISOString(),
        source: 'mock',
      };

      const orders = readOrders(storage);
      orders.unshift(order);
      writeOrders(storage, orders.slice(0, 50));
      return order;
    },

    async getOrder(id) {
      return readOrders(storage).find((order) => order.id === id || order.orderNumber === id) ?? null;
    },
  };
}
