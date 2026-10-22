import { WEEKDAY_SHORT } from '../data/venue.js';
import { partsInTZ } from '../lib/hours.js';
import { recipeCostCents } from './stock.js';
import { dateInRange, isoWeekKey, sastDate } from './dates.js';

const METHODS = ['wallet', 'card', 'cash'];

export function isRevenueOrder(order) {
  if (!order) return false;
  if (order.status === 'cancelled' || order.status === 'no_show') return false;
  if (order.paymentStatus === 'refunded' || order.paymentStatus === 'written_off') return false;
  if (order.paymentMethod === 'cash') return order.status === 'collected' || order.paymentStatus === 'paid';
  return order.paymentStatus === 'paid';
}

function emptyMethod() {
  return { wallet: { orders: 0, revenueCents: 0 }, card: { orders: 0, revenueCents: 0 }, cash: { orders: 0, revenueCents: 0 } };
}

function addMethod(bucket, order) {
  const method = METHODS.includes(order.paymentMethod) ? order.paymentMethod : 'cash';
  bucket[method].orders += 1;
  bucket[method].revenueCents += Number(order.totalCents) || 0;
}

export function buildFinanceReport({
  orders = [],
  ledger = [],
  students = [],
  specials = [],
  waste = [],
  ingredients = [],
  recipes = [],
  from,
  to,
  demo = false,
} = {}) {
  const start = from || '1970-01-01';
  const end = to || '2999-12-31';
  const inRange = (iso) => dateInRange(iso, start, end);
  const recognised = orders.filter((order) => inRange(order.createdAt) && isRevenueOrder(order));

  const byMethod = emptyMethod();
  const dailyMap = new Map();
  const weeklyMap = new Map();
  const monthlyMap = new Map();
  const itemMap = new Map();
  const dow = WEEKDAY_SHORT.map((label, index) => ({ dow: index, label, orders: 0, revenueCents: 0 }));
  const hourMap = new Map();
  let revenueCents = 0;

  for (const order of recognised) {
    revenueCents += Number(order.totalCents) || 0;
    addMethod(byMethod, order);
    const day = sastDate(new Date(order.createdAt));
    const parts = partsInTZ(new Date(order.createdAt));
    const dayBucket = dailyMap.get(day) || { date: day, orders: 0, revenueCents: 0, ...emptyMethod() };
    dayBucket.orders += 1;
    dayBucket.revenueCents += Number(order.totalCents) || 0;
    addMethod(dayBucket, order);
    dailyMap.set(day, dayBucket);

    const week = isoWeekKey(day);
    const weekBucket = weeklyMap.get(week) || { week, orders: 0, revenueCents: 0 };
    weekBucket.orders += 1;
    weekBucket.revenueCents += Number(order.totalCents) || 0;
    weeklyMap.set(week, weekBucket);

    const month = day.slice(0, 7);
    const monthBucket = monthlyMap.get(month) || { month, orders: 0, revenueCents: 0 };
    monthBucket.orders += 1;
    monthBucket.revenueCents += Number(order.totalCents) || 0;
    monthlyMap.set(month, monthBucket);

    dow[parts.dow].orders += 1;
    dow[parts.dow].revenueCents += Number(order.totalCents) || 0;
    const hourBucket = hourMap.get(parts.hour) || { hour: parts.hour, orders: 0, revenueCents: 0 };
    hourBucket.orders += 1;
    hourBucket.revenueCents += Number(order.totalCents) || 0;
    hourMap.set(parts.hour, hourBucket);

    for (const line of order.items || []) {
      const key = line.itemId || line.name;
      const current = itemMap.get(key) || {
        itemId: line.itemId || '',
        name: line.name,
        qty: 0,
        revenueCents: 0,
      };
      current.qty += Number(line.qty) || 0;
      current.revenueCents += Number(line.lineTotalCents) || 0;
      itemMap.set(key, current);
    }
  }

  const items = [...itemMap.values()].sort((a, b) => b.qty - a.qty || b.revenueCents - a.revenueCents);
  let cogsCents = 0;
  for (const order of recognised) {
    for (const line of order.items || []) {
      const unitCost = recipeCostCents(recipes, ingredients, line.itemId);
      if (!unitCost) continue;
      const paidQty = Math.max(0, (Number(line.qty) || 0) - (Number(line.loyaltyFreeQty) || 0));
      const freeQty = Number(line.loyaltyFreeQty) || 0;
      cogsCents += unitCost * (paidQty + freeQty);
    }
  }

  const specialRows = (specials || [])
    .filter((row) => row.specialDate >= start && row.specialDate <= end)
    .map((row) => {
      let qty = 0;
      let specialRevenue = 0;
      const needle = String(row.name || '').trim().toLowerCase();
      for (const order of recognised) {
        if (sastDate(new Date(order.createdAt)) !== row.specialDate) continue;
        for (const line of order.items || []) {
          if (String(line.name || '').trim().toLowerCase() !== needle && line.itemId !== row.itemId) continue;
          qty += Number(line.qty) || 0;
          specialRevenue += Number(line.lineTotalCents) || 0;
        }
      }
      return {
        date: row.specialDate,
        name: row.name,
        priceCents: row.priceCents,
        qty,
        revenueCents: specialRevenue,
        demo: Boolean(row.demo),
      };
    });

  const ledgerRows = (ledger || []).filter((row) => inRange(row.createdAt));
  const sumKind = (kind) =>
    ledgerRows.filter((row) => row.kind === kind).reduce((sum, row) => sum + Number(row.amountCents) || 0, 0);
  const topupCents = sumKind('topup');
  const spendCents = Math.abs(
    ledgerRows.filter((row) => row.kind === 'order' || row.kind === 'till').reduce((sum, row) => sum + Math.min(0, Number(row.amountCents) || 0), 0),
  );
  const refundCents = ledgerRows.filter((row) => row.kind === 'refund').reduce((sum, row) => sum + Number(row.amountCents) || 0, 0);

  const refundOrders = orders.filter(
    (order) => inRange(order.updatedAt || order.createdAt) && order.paymentStatus === 'refunded',
  );
  const writeOffs = orders.filter(
    (order) => inRange(order.updatedAt || order.createdAt) && order.paymentStatus === 'written_off',
  );
  const wasteRows = (waste || []).filter((row) => inRange(row.createdAt));
  const stockValueCents = (ingredients || []).reduce(
    (sum, row) => sum + Math.round(Math.max(0, Number(row.onHand)) * Number(row.costCents)),
    0,
  );

  const orderCount = recognised.length;
  return {
    demo: Boolean(demo),
    from: start,
    to: end,
    currency: 'ZAR',
    revenueCents,
    orderCount,
    averageOrderValueCents: orderCount ? Math.round(revenueCents / orderCount) : 0,
    byMethod,
    daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    weekly: [...weeklyMap.values()].sort((a, b) => a.week.localeCompare(b.week)),
    monthly: [...monthlyMap.values()].sort((a, b) => a.month.localeCompare(b.month)),
    items,
    topSellers: items.slice(0, 5),
    byDow: dow,
    byHour: [...hourMap.values()].sort((a, b) => a.hour - b.hour),
    specials: specialRows,
    wallet: {
      topupCents,
      spendCents,
      refundCents,
      outstandingLiabilityCents: (students || []).reduce((sum, student) => sum + (Number(student.balanceCents) || 0), 0),
    },
    refunds: {
      count: refundOrders.length,
      cents: refundOrders.reduce((sum, order) => sum + (Number(order.totalCents) || 0), 0),
    },
    writeOffs: {
      count: writeOffs.length,
      cents: writeOffs.reduce((sum, order) => sum + (Number(order.totalCents) || 0), 0),
    },
    cogsCents,
    stockValueCents,
    grossMarginCents: revenueCents - cogsCents,
    waste: wasteRows,
    wasteCents: wasteRows.reduce((sum, row) => sum + (Number(row.costCents) || 0), 0),
  };
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function line(cells) {
  return cells.map(csvEscape).join(',');
}

export function financeToCsv(report) {
  const rows = [
    line(['section', 'demo', report.demo ? 'demo sample' : 'live']),
    line(['summary', 'from', report.from, 'to', report.to]),
    line(['summary', 'revenue_cents', report.revenueCents, 'orders', report.orderCount, 'aov_cents', report.averageOrderValueCents]),
    line(['summary', 'cogs_cents', report.cogsCents, 'gross_margin_cents', report.grossMarginCents, 'stock_value_cents', report.stockValueCents]),
    line(['summary', 'wallet_topup_cents', report.wallet.topupCents, 'wallet_spend_cents', report.wallet.spendCents, 'wallet_liability_cents', report.wallet.outstandingLiabilityCents]),
    line(['summary', 'refunds_cents', report.refunds.cents, 'writeoff_cents', report.writeOffs.cents, 'waste_cents', report.wasteCents]),
    line([]),
    line(['method', 'orders', 'revenue_cents']),
    ...METHODS.map((method) => line([method, report.byMethod[method].orders, report.byMethod[method].revenueCents])),
    line([]),
    line(['day', 'orders', 'revenue_cents', 'wallet_cents', 'card_cents', 'cash_cents']),
    ...report.daily.map((day) =>
      line([
        day.date,
        day.orders,
        day.revenueCents,
        day.wallet.revenueCents,
        day.card.revenueCents,
        day.cash.revenueCents,
      ]),
    ),
    line([]),
    line(['week', 'orders', 'revenue_cents']),
    ...report.weekly.map((week) => line([week.week, week.orders, week.revenueCents])),
    line([]),
    line(['month', 'orders', 'revenue_cents']),
    ...report.monthly.map((month) => line([month.month, month.orders, month.revenueCents])),
    line([]),
    line(['item_id', 'name', 'qty', 'revenue_cents']),
    ...report.items.map((item) => line([item.itemId, item.name, item.qty, item.revenueCents])),
    line([]),
    line(['dow', 'orders', 'revenue_cents']),
    ...report.byDow.map((row) => line([row.label, row.orders, row.revenueCents])),
    line([]),
    line(['hour', 'orders', 'revenue_cents']),
    ...report.byHour.map((row) => line([row.hour, row.orders, row.revenueCents])),
    line([]),
    line(['special_date', 'name', 'qty', 'revenue_cents']),
    ...report.specials.map((row) => line([row.date, row.name, row.qty, row.revenueCents])),
  ];
  return `${rows.join('\n')}\n`;
}
