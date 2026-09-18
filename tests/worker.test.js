import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getPickupSlots } from '../js/lib/hours.js';
import { handleRequest } from '../worker/src/index.js';
import { notifyKitchenWhatsApp } from '../worker/src/whatsapp.js';

function memoryKv() {
  const map = new Map();
  return {
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, String(value));
    },
    async delete(key) {
      map.delete(key);
    },
    async list({ prefix = '', cursor } = {}) {
      const names = [...map.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = names.slice(start, start + 100);
      const complete = start + slice.length >= names.length;
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: complete,
        cursor: complete ? undefined : String(start + slice.length),
      };
    },
  };
}

function env(overrides = {}) {
  return {
    ORDERS: memoryKv(),
    STAFF_PIN: '4242',
    ...overrides,
  };
}

function jsonRequest(url, { method = 'GET', body, pin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (pin) headers['X-Staff-Pin'] = pin;
  return new Request(url, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
}

async function placeOrder(testEnv, items = [{ itemId: 'campus-burger', qty: 1 }]) {
  const pickup = getPickupSlots()[0];
  const res = await handleRequest(
    jsonRequest('https://api.test/orders', {
      method: 'POST',
      body: {
        customerName: 'Thabo',
        phone: '0821234567',
        pickupTime: pickup.iso,
        notes: 'No chilli',
        items,
      },
    }),
    testEnv,
  );
  return { res, pickup, body: await res.json() };
}

describe('cloudflare worker API', () => {
  it('creates, fetches, lists, and advances a pay-at-counter order', async () => {
    const testEnv = env();
    const { res, body } = await placeOrder(testEnv);
    assert.equal(res.status, 201);
    assert.match(body.orderNumber, /^FC-/);
    assert.equal(body.payOnCollection, true);
    assert.equal(body.status, 'received');

    const got = await handleRequest(new Request(`https://api.test/orders/${body.id}`), testEnv);
    assert.equal(got.status, 200);
    assert.equal((await got.json()).orderNumber, body.orderNumber);

    const denied = await handleRequest(new Request('https://api.test/kitchen/orders'), testEnv);
    assert.equal(denied.status, 401);

    const listed = await handleRequest(
      jsonRequest('https://api.test/kitchen/orders', { pin: '4242' }),
      testEnv,
    );
    const payload = await listed.json();
    assert.equal(payload.orders.length, 1);
    assert.equal(payload.demo, false);

    const patched = await handleRequest(
      jsonRequest(`https://api.test/kitchen/orders/${body.id}`, {
        method: 'PATCH',
        pin: '4242',
        body: { status: 'preparing' },
      }),
      testEnv,
    );
    assert.equal((await patched.json()).status, 'preparing');
  });

  it('rejects day-gated items at createOrder', async () => {
    const wednesday = new Date('2026-09-16T10:00:00+02:00');
    const pickup = getPickupSlots(wednesday)[0];
    const res = await handleRequest(
      jsonRequest('https://api.test/orders', {
        method: 'POST',
        body: {
          customerName: 'Thabo',
          phone: '0821234567',
          pickupTime: pickup.iso,
          items: [{ itemId: 'full-brunch', qty: 1 }],
        },
      }),
      env(),
      { now: wednesday },
    );
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not available/i);
  });

  it('still saves the order when WhatsApp fails', async () => {
    const testEnv = env({
      KITCHEN_WHATSAPP: '27821234567',
      CALLMEBOT_APIKEY: 'test-key',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    try {
      const { res, body } = await placeOrder(testEnv);
      assert.equal(res.status, 201);
      assert.match(body.orderNumber, /^FC-/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('skips WhatsApp when secrets are missing', async () => {
    const result = await notifyKitchenWhatsApp(
      { KITCHEN_WHATSAPP: '', CALLMEBOT_APIKEY: '' },
      { orderNumber: 'FC-1', items: [], totalCents: 0, customerName: 'A', phone: '+27820000000' },
    );
    assert.equal(result.skipped, true);
    assert.equal(result.sent, false);
  });

  it('sends CallMeBot when configured', async () => {
    const calls = [];
    const result = await notifyKitchenWhatsApp(
      { KITCHEN_WHATSAPP: '+27821234567', CALLMEBOT_APIKEY: 'secret' },
      {
        orderNumber: 'FC-18123',
        pickupLabel: '12:15',
        customerName: 'Thabo',
        phone: '+27820000000',
        items: [{ qty: 1, name: 'Juice' }],
        totalCents: 2000,
      },
      {
        fetchImpl: async (url) => {
          calls.push(String(url));
          return new Response('ok', { status: 200 });
        },
      },
    );
    assert.equal(result.sent, true);
    assert.equal(result.provider, 'callmebot');
    assert.match(calls[0], /api\.callmebot\.com/);
    assert.match(calls[0], /27821234567/);
    assert.match(calls[0], /FC-18123/);
  });

  it('answers CORS preflight and health', async () => {
    const preflight = await handleRequest(
      new Request('https://api.test/orders', {
        method: 'OPTIONS',
        headers: { Origin: 'https://thefood-court.co.za' },
      }),
      env(),
    );
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://thefood-court.co.za');

    const health = await handleRequest(new Request('https://api.test/health'), env());
    assert.equal((await health.json()).ok, true);
  });
});
