/**
 * Real kitchen API shape — keep in sync with createMockOrderApi.
 * GET    {baseUrl}/menu
 * POST   {baseUrl}/orders
 * GET    {baseUrl}/orders/:id
 * POST   {baseUrl}/kitchen/login
 * GET    {baseUrl}/kitchen/orders
 * PATCH  {baseUrl}/kitchen/orders/:id
 */
export function createHttpOrderApi(baseUrl) {
  const root = String(baseUrl).replace(/\/$/, '');

  async function request(path, options) {
    const res = await fetch(`${root}${path}`, options);
    const method = String(options?.method || 'GET').toUpperCase();
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) {
      let message = 'Something went wrong. Please try again.';
      if (res.status === 401) message = 'Wrong PIN.';
      try {
        const body = await res.json();
        if (body?.error) message = body.error;
      } catch {
        /* ignore */
      }
      throw new Error(message);
    }
    return res.json();
  }

  function staffHeaders(pin, json = false) {
    const headers = { 'X-Staff-Pin': String(pin ?? '') };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
  }

  return {
    mode: 'http',

    getMenu() {
      return request('/menu');
    },
    createOrder(input) {
      return request('/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
    },
    getOrder(id) {
      return request(`/orders/${encodeURIComponent(id)}`);
    },
    verifyStaffPin(pin) {
      return request('/kitchen/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
    },
    listOpenOrders(pin) {
      return request('/kitchen/orders', {
        headers: staffHeaders(pin),
      });
    },
    updateOrderStatus(id, status, pin) {
      return request(`/kitchen/orders/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: staffHeaders(pin, true),
        body: JSON.stringify({ status }),
      });
    },
  };
}
