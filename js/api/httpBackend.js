/**
 * Real kitchen API shape — keep in sync with createMockOrderApi.
 * GET  {baseUrl}/menu
 * POST {baseUrl}/orders
 * GET  {baseUrl}/orders/:id
 */
export function createHttpOrderApi(baseUrl) {
  const root = String(baseUrl).replace(/\/$/, '');

  async function request(path, options) {
    const res = await fetch(`${root}${path}`, options);
    if (res.status === 404) return null;
    if (!res.ok) {
      let message = 'Something went wrong. Please try again.';
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

  return {
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
  };
}
