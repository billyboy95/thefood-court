import { getMenu, getMenuItem } from '../data/menu.js';
import {
  applyStatus,
  buildOrder,
  DEFAULT_STAFF_PIN,
  pinMatches,
  sortOpenOrders,
} from './orderService.js';

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

function expectedPin(staffPin) {
  if (staffPin) return String(staffPin);
  if (typeof globalThis !== 'undefined' && globalThis.FOODCOURT_STAFF_PIN) {
    return String(globalThis.FOODCOURT_STAFF_PIN);
  }
  return DEFAULT_STAFF_PIN;
}

function assertPin(pin, staffPin) {
  if (!pinMatches(pin, expectedPin(staffPin))) {
    throw new Error('Wrong PIN.');
  }
}

function findOrder(orders, id) {
  return orders.find((order) => order.id === id || order.orderNumber === id) ?? null;
}

/**
 * In-browser kitchen queue. Swap this for createHttpOrderApi() in client.js.
 * WhatsApp is not sent from the browser — that lives on the Worker.
 */
export function createMockOrderApi(storage, { nowFn = () => new Date(), staffPin } = {}) {
  return {
    mode: 'mock',

    async getMenu() {
      return getMenu();
    },

    async createOrder(input) {
      const order = buildOrder(input, {
        getMenuItem,
        now: nowFn(),
        source: 'mock',
      });
      const orders = readOrders(storage);
      orders.unshift(order);
      writeOrders(storage, orders.slice(0, 80));
      return order;
    },

    async getOrder(id) {
      return findOrder(readOrders(storage), id);
    },

    async verifyStaffPin(pin) {
      assertPin(pin, staffPin);
      return { ok: true, whatsapp: false, demo: true };
    },

    async listOpenOrders(pin) {
      assertPin(pin, staffPin);
      return {
        orders: sortOpenOrders(readOrders(storage)),
        whatsapp: false,
        demo: true,
      };
    },

    async updateOrderStatus(id, status, pin) {
      assertPin(pin, staffPin);
      const orders = readOrders(storage);
      const index = orders.findIndex((order) => order.id === id || order.orderNumber === id);
      if (index < 0) return null;
      const updated = applyStatus(orders[index], status, nowFn());
      orders[index] = updated;
      writeOrders(storage, orders);
      return updated;
    },
  };
}
