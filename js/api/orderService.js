import { getPickupSlots } from '../lib/hours.js';
import { makeOrderId, makeOrderNumber } from '../lib/ids.js';
import { cartTotals, formatZAR } from '../lib/money.js';
import { formatSaPhone, normalizeSaPhone } from '../lib/phone.js';

export const STATUS_FLOW = ['received', 'preparing', 'ready', 'collected'];

export const OPEN_STATUSES = ['received', 'preparing', 'ready'];

export const STATUS_LABELS = {
  received: 'Received',
  preparing: 'Preparing',
  ready: 'Ready',
  collected: 'Collected',
};

export const NEXT_ACTION = {
  received: { status: 'preparing', label: 'Start preparing' },
  preparing: { status: 'ready', label: 'Mark ready' },
  ready: { status: 'collected', label: 'Collected' },
};

export const DEFAULT_STAFF_PIN = '1234';
export const DEFAULT_CHEF_PIN = '2468';
export const PAYMENT_METHODS = ['wallet', 'card', 'cash'];

export function normalizePaymentMethod(value) {
  const method = String(value || '').trim().toLowerCase();
  if (!method || method === 'collection' || method === 'pay_on_collection' || method === 'counter') return 'cash';
  if (PAYMENT_METHODS.includes(method)) return method;
  throw new Error('Choose wallet, card, or pay on collection.');
}

/**
 * Validate checkout input and build a pay-at-counter order.
 * Recomputes totals from the menu. Rejects day-gated items for the pickup day.
 */
export function buildOrder(input, { getMenuItem, now = new Date(), source = 'mock', isSoldOut } = {}) {
  if (typeof getMenuItem !== 'function') {
    throw new Error('Menu is not available.');
  }

  const name = String(input?.customerName ?? '').trim();
  if (name.length < 2) {
    throw new Error('Please enter your name.');
  }
  if (name.length > 80) {
    throw new Error('Please use a shorter name.');
  }

  const phone = normalizeSaPhone(input?.phone);
  if (!phone) {
    throw new Error('Enter a valid South African phone number.');
  }

  const pickupTime = String(input?.pickupTime ?? '');
  const slots = getPickupSlots(now);
  const slot = slots.find((s) => s.iso === pickupTime);
  if (!slot) {
    throw new Error('Choose a pickup time from the list.');
  }

  const requested = Array.isArray(input?.items) ? input.items : [];
  if (!requested.length) {
    throw new Error('Your cart is empty.');
  }

  const paymentMethod = normalizePaymentMethod(input?.paymentMethod);

  for (const line of requested) {
    const item = getMenuItem(line.itemId);
    if (!item) {
      throw new Error('An item in this order is not on the board.');
    }
    if (item.availableDays?.length && !item.availableDays.includes(slot.dow)) {
      throw new Error(`${item.name} is not available for that pickup day.`);
    }
    if (typeof isSoldOut === 'function' && isSoldOut(item.id)) {
      throw new Error(`${item.name} is sold out.`);
    }
  }

  const totals = cartTotals(requested, getMenuItem);
  if (!totals.itemCount) {
    throw new Error('Your cart is empty.');
  }

  return {
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
    paymentMethod,
    paymentStatus: paymentMethod === 'cash' ? 'unpaid' : 'pending',
    payOnCollection: paymentMethod === 'cash',
    studentId: input?.studentId || null,
    loyaltyRedeemed: false,
    discountCents: 0,
    reminderSentAt: null,
    noShowActionTakenAt: null,
    cancelReason: null,
    demo: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    source,
  };
}

export function cancelOrderRecord(order, now = new Date(), { reason = 'kitchen', paymentStatus = 'refunded' } = {}) {
  if (!order) throw new Error('Order not found.');
  if (order.status === 'collected' || order.status === 'cancelled' || order.status === 'no_show') {
    throw new Error('This order can no longer be cancelled.');
  }
  return {
    ...order,
    status: 'cancelled',
    paymentStatus: order.paymentStatus === 'unpaid' && paymentStatus === 'refunded' ? 'unpaid' : paymentStatus,
    cancelReason: reason,
    updatedAt: now.toISOString(),
  };
}

export function applyStatus(order, nextStatus, now = new Date()) {
  const next = String(nextStatus ?? '');
  if (!STATUS_FLOW.includes(next)) {
    throw new Error('Unknown status.');
  }
  if (order.status === next) return { ...order, updatedAt: now.toISOString() };
  const from = STATUS_FLOW.indexOf(order.status);
  const to = STATUS_FLOW.indexOf(next);
  if (to !== from + 1) {
    throw new Error('Status can only move Received → Preparing → Ready → Collected.');
  }
  return { ...order, status: next, updatedAt: now.toISOString() };
}

export function isOpenStatus(status) {
  return OPEN_STATUSES.includes(status);
}

export function sortOpenOrders(orders) {
  return [...orders].filter((order) => isOpenStatus(order.status)).sort((a, b) => {
    const pickup = String(a.pickupTime).localeCompare(String(b.pickupTime));
    if (pickup) return pickup;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

export function staffPinConfigured(expected) {
  return Boolean(String(expected ?? '').trim());
}

export function pinMatches(given, expected) {
  const a = String(given ?? '');
  const b = String(expected ?? '');
  if (!b || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Short WhatsApp ping for the kitchen phone. */
export function formatKitchenWhatsApp(order) {
  const lines = [
    `Food Court pre-order ${order.orderNumber}`,
    `Pickup ${order.pickupLabel || order.pickupTime}`,
    `${order.customerName} · ${formatSaPhone(order.phone)}`,
    ...order.items.map((line) => `${line.qty}× ${line.name}`),
  ];
  if (order.notes) lines.push(`Notes: ${order.notes}`);
  lines.push(`Total ${formatZAR(order.totalCents)}`);
  if (order.paymentMethod === 'wallet') lines.push(order.totalCents === 0 ? 'Free meal · loyalty' : 'Paid from wallet');
  else if (order.paymentMethod === 'card') lines.push('Paid by card');
  else lines.push('Pay at counter');
  return lines.join('\n');
}

export function kitchenWhatsAppDigits(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.startsWith('27') && digits.length === 11) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `27${digits.slice(1)}`;
  return '';
}

export function whatsappProvidersConfigured(env = {}) {
  const phone = kitchenWhatsAppDigits(env.KITCHEN_WHATSAPP);
  const twilio = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM);
  const meta = Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);
  return { phone, twilio: twilio && Boolean(phone), meta: meta && Boolean(phone) };
}
