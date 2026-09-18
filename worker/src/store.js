const ORDER_PREFIX = 'o:';
const NUMBER_PREFIX = 'n:';

export async function saveOrder(kv, order) {
  await kv.put(`${ORDER_PREFIX}${order.id}`, JSON.stringify(order));
  await kv.put(`${NUMBER_PREFIX}${order.orderNumber}`, order.id);
}

export async function readOrder(kv, idOrNumber) {
  const direct = await kv.get(`${ORDER_PREFIX}${idOrNumber}`);
  if (direct) return JSON.parse(direct);
  const id = await kv.get(`${NUMBER_PREFIX}${idOrNumber}`);
  if (!id) return null;
  const raw = await kv.get(`${ORDER_PREFIX}${id}`);
  return raw ? JSON.parse(raw) : null;
}

export async function listAllOrders(kv) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: ORDER_PREFIX, cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const orders = [];
  for (const key of keys) {
    const raw = await kv.get(key.name);
    if (raw) {
      try {
        orders.push(JSON.parse(raw));
      } catch {
        /* skip corrupt */
      }
    }
  }
  return orders;
}
