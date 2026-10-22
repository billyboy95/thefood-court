import { getLocalStorage } from '../lib/dom.js';

const SESSION_KEY = 'foodcourt.auth.v1';

/**
 * Live API. The anon key only unlocks reads the RLS policies allow and calls
 * to Edge Functions. Service-role and provider secrets stay on Supabase.
 */
export function createSupabaseOrderApi({ url, anonKey, storage = getLocalStorage() } = {}) {
  const root = `${String(url).replace(/\/$/, '')}/functions/v1/api`;

  function readSession() {
    try {
      return JSON.parse(storage.getItem(SESSION_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function writeSession(value) {
    if (!value) storage.removeItem(SESSION_KEY);
    else storage.setItem(SESSION_KEY, JSON.stringify(value));
  }

  async function request(path, { method = 'GET', body, pin, chef } = {}) {
    const headers = {
      apikey: anonKey,
      Authorization: `Bearer ${readSession()?.access_token || anonKey}`,
      'Content-Type': 'application/json',
    };
    if (pin) headers['X-Staff-Pin'] = String(pin);
    if (chef) headers['X-Chef-Pin'] = String(chef);
    const res = await fetch(`${root}${path}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) {
      let message = 'Something went wrong. Please try again.';
      if (res.status === 401) message = 'Wrong PIN.';
      try {
        const payload = await res.json();
        if (payload?.error) message = payload.error;
      } catch {
        /* keep the fallback */
      }
      throw new Error(message);
    }
    if (res.status === 204) return { ok: true };
    return res.json();
  }

  function remember(result) {
    if (result?.access_token) {
      writeSession({
        access_token: result.access_token,
        refresh_token: result.refresh_token || '',
      });
    }
    return result?.student || result;
  }

  return {
    mode: 'supabase',

    getMenu() {
      return request('/menu');
    },
    getBoard() {
      return request('/board');
    },
    getPickupSlots() {
      return request('/slots');
    },
    createOrder(input) {
      return request('/orders', { method: 'POST', body: input });
    },
    getOrder(id) {
      return request(`/orders/${encodeURIComponent(id)}`);
    },
    verifyStaffPin(pin) {
      return request('/kitchen/login', { method: 'POST', body: { pin }, pin });
    },
    listOpenOrders(pin) {
      return request('/kitchen/orders', { pin });
    },
    updateOrderStatus(id, status, pin) {
      return request(`/kitchen/orders/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        pin,
        body: { status },
      });
    },
    cancelOrder(id, pin) {
      return request(`/kitchen/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST', pin, body: {} });
    },
    setSoldOut(itemId, soldOut, pin) {
      return request('/kitchen/soldout', { method: 'POST', pin, body: { itemId, soldOut } });
    },
    setPortions(itemId, portions, pin) {
      return request('/kitchen/portions', { method: 'POST', pin, body: { itemId, portions } });
    },
    currentStudent() {
      return readSession()?.access_token ? request('/wallet').then((wallet) => wallet.student) : null;
    },
    signInStudent(input) {
      return request('/wallet/login', { method: 'POST', body: input }).then(remember);
    },
    registerStudent(input) {
      return request('/wallet/register', { method: 'POST', body: input }).then(remember);
    },
    requestEmailCode(input) {
      return request('/wallet/email-code', { method: 'POST', body: input });
    },
    verifyEmailCode(input) {
      return request('/wallet/verify-email', { method: 'POST', body: input }).then(remember);
    },
    signOutStudent() {
      writeSession(null);
      return Promise.resolve({ ok: true });
    },
    getWallet() {
      return request('/wallet');
    },
    rotatePayToken() {
      return request('/wallet/token', { method: 'POST', body: {} });
    },
    topUp(input) {
      return request('/wallet/topup', { method: 'POST', body: input });
    },
    setAutoTopup(input) {
      return request('/wallet/auto-topup', { method: 'POST', body: input });
    },
    linkNfc(input) {
      return request('/wallet/nfc', { method: 'POST', body: input, pin: input?.staffPin });
    },
    tillCharge(input) {
      return request('/till/charge', { method: 'POST', pin: input?.pin, body: input });
    },
    verifyChefPin(pin) {
      return request('/chef/login', { method: 'POST', chef: pin, body: { pin } });
    },
    publishSpecial(input) {
      return request('/chef/specials', { method: 'POST', chef: input?.pin, body: input });
    },
    getSpecials() {
      return request('/specials');
    },
    listReady() {
      return request('/counter');
    },
    getReport({ pin, from, to }) {
      const query = new URLSearchParams({ from: from || '', to: to || '' });
      return request(`/reports?${query}`, { pin });
    },
    getStock(pin) {
      return request('/stock', { pin });
    },
    receiveGoods(input) {
      return request('/stock/receive', { method: 'POST', pin: input.pin, body: input });
    },
    logWaste(input) {
      return request('/stock/waste', { method: 'POST', pin: input.pin, body: input });
    },
    saveStockTake(input) {
      return request('/stock/take', { method: 'POST', pin: input.pin, body: input });
    },
    getSettings(pin) {
      return request('/settings', { pin });
    },
    saveSettings(pin, patch) {
      return request('/settings', { method: 'PUT', pin, body: patch });
    },
    runAutomations(pin, job) {
      return request('/automations/run', { method: 'POST', pin, body: { job } });
    },
    rateOrder(input) {
      return request(`/orders/${encodeURIComponent(input.id)}/rating`, { method: 'POST', body: input });
    },
    getForecast(pin) {
      return request('/forecast', { pin });
    },
  };
}
