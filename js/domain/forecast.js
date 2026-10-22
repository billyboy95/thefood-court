import { partsInTZ } from '../lib/hours.js';
import { sastDate } from './dates.js';

const SKIP = new Set(['cancelled', 'no_show']);

export function prepForecast({ menu = [], orders = [], now = new Date(), weeks = 8 } = {}) {
  const todayParts = partsInTZ(now);
  const today = sastDate(now);
  const rows = [];
  for (const item of menu) {
    const byDate = new Map();
    let preorders = 0;
    for (const order of orders) {
      if (SKIP.has(order.status)) continue;
      for (const line of order.items || []) {
        if (line.itemId !== item.id) continue;
        const created = new Date(order.createdAt || order.pickupTime);
        const parts = partsInTZ(created);
        const day = sastDate(created);
        if (day === today || sastDate(new Date(order.pickupTime || order.createdAt)) === today) {
          if (sastDate(new Date(order.pickupTime || order.createdAt)) === today) preorders += Number(line.qty) || 0;
        }
        if (parts.dow !== todayParts.dow || day === today) continue;
        byDate.set(day, (byDate.get(day) || 0) + (Number(line.qty) || 0));
      }
    }
    const dates = [...byDate.keys()].sort().slice(-weeks);
    const avg = dates.length ? dates.reduce((sum, day) => sum + byDate.get(day), 0) / dates.length : 0;
    const historyQty = Math.ceil(avg);
    const suggestQty = historyQty + preorders;
    if (suggestQty <= 0 && preorders <= 0) continue;
    rows.push({
      itemId: item.id,
      name: item.name,
      historyAvg: Math.round(avg * 10) / 10,
      historyDays: dates.length,
      preorders,
      suggestQty,
    });
  }
  return rows.sort((a, b) => b.suggestQty - a.suggestQty || a.name.localeCompare(b.name));
}
