import { getMenu, getMenuItem } from '../../js/data/menu.js';
import {
  applyStatus,
  buildOrder,
  pinMatches,
  sortOpenOrders,
  staffPinConfigured,
} from '../../js/api/orderService.js';
import { listAllOrders, readOrder, saveOrder } from './store.js';
import { notifyKitchenWhatsApp, whatsappEnabled } from './whatsapp.js';

const ALLOWED_ORIGINS = new Set([
  'https://thefood-court.co.za',
  'https://www.thefood-court.co.za',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
]);

function allowOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (/^http:\/\/localhost:\d+$/.test(origin)) return origin;
  if (/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return origin;
  return 'https://thefood-court.co.za';
}

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': allowOrigin(request),
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Staff-Pin',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(request),
    },
  });
}

function error(request, message, status = 400) {
  return json(request, { error: message }, status);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function staffPinFrom(request, body) {
  return request.headers.get('X-Staff-Pin') || body?.pin || '';
}

function requireStaff(request, env, body) {
  if (!staffPinConfigured(env.STAFF_PIN)) {
    return error(request, 'STAFF_PIN is not set on the API. See README.', 503);
  }
  if (!pinMatches(staffPinFrom(request, body), env.STAFF_PIN)) {
    return error(request, 'Wrong PIN.', 401);
  }
  return null;
}

function pathname(request) {
  try {
    return new URL(request.url).pathname.replace(/\/$/, '') || '/';
  } catch {
    return '/';
  }
}

export async function handleRequest(request, env, ctx = {}) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  if (!env?.ORDERS) {
    return error(request, 'Orders store is not bound (ORDERS KV).', 500);
  }

  const path = pathname(request);
  const method = request.method.toUpperCase();

  if (method === 'GET' && (path === '/' || path === '/health')) {
    return json(request, { ok: true, service: 'thefood-court-api' });
  }

  if (method === 'GET' && path === '/menu') {
    return json(request, getMenu());
  }

  if (method === 'POST' && path === '/orders') {
    const input = await readJson(request);
    if (!input) return error(request, 'Invalid JSON.');
    const now = ctx.now instanceof Date ? ctx.now : new Date();
    let order;
    try {
      order = buildOrder(input, { getMenuItem, now, source: 'api' });
    } catch (err) {
      return error(request, err.message || 'Could not place this order.', 400);
    }
    await saveOrder(env.ORDERS, order);
    const notify = notifyKitchenWhatsApp(env, order).catch((err) => {
      console.error('kitchen WhatsApp failed', err);
    });
    if (typeof ctx.waitUntil === 'function') ctx.waitUntil(notify);
    else await notify;
    return json(request, order, 201);
  }

  const orderGet = path.match(/^\/orders\/([^/]+)$/);
  if (method === 'GET' && orderGet) {
    const order = await readOrder(env.ORDERS, decodeURIComponent(orderGet[1]));
    if (!order) return error(request, 'Order not found.', 404);
    return json(request, order);
  }

  if (method === 'POST' && path === '/kitchen/login') {
    const body = (await readJson(request)) || {};
    const denied = requireStaff(request, env, body);
    if (denied) return denied;
    return json(request, { ok: true, whatsapp: whatsappEnabled(env), demo: false });
  }

  if (method === 'GET' && path === '/kitchen/orders') {
    const denied = requireStaff(request, env, {});
    if (denied) return denied;
    const orders = sortOpenOrders(await listAllOrders(env.ORDERS));
    return json(request, { orders, whatsapp: whatsappEnabled(env), demo: false });
  }

  const kitchenPatch = path.match(/^\/kitchen\/orders\/([^/]+)$/);
  if (method === 'PATCH' && kitchenPatch) {
    const body = (await readJson(request)) || {};
    const denied = requireStaff(request, env, body);
    if (denied) return denied;
    const existing = await readOrder(env.ORDERS, decodeURIComponent(kitchenPatch[1]));
    if (!existing) return error(request, 'Order not found.', 404);
    let updated;
    try {
      const now = ctx.now instanceof Date ? ctx.now : new Date();
      updated = applyStatus(existing, body.status, now);
    } catch (err) {
      return error(request, err.message || 'Could not update status.', 400);
    }
    await saveOrder(env.ORDERS, updated);
    return json(request, updated);
  }

  return error(request, 'Not found.', 404);
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};
