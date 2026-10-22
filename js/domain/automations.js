import { WEEKDAY_SHORT } from '../data/venue.js';
import { partsInTZ } from '../lib/hours.js';
import { buildFinanceReport } from './reports.js';
import { sastDate } from './dates.js';
import {
  formatChefNudge,
  formatEodSummary,
  formatLowBalanceWhatsApp,
  formatLowStock,
  formatNoShowReminder,
  formatSoldOut,
} from './notify.js';
import { reorderSuggestions } from './stock.js';
import { prepForecast } from './forecast.js';
import { reconcilePayments } from './reconcile.js';

const OPEN = new Set(['received', 'preparing', 'ready']);

export function planLowBalance({ students = [], settings, alertedIds = [] }) {
  const due = students.filter(
    (student) =>
      student.phone &&
      Number(student.balanceCents) < Number(settings.lowBalanceCents) &&
      !alertedIds.includes(student.id),
  );
  return due.map((student) => ({
    type: 'low-balance',
    studentId: student.id,
    to: student.phone,
    text: formatLowBalanceWhatsApp(student, settings.lowBalanceCents),
    autoTopup: Boolean(student.autoTopup) && Number(student.autoTopupCents || settings.autoTopupCents) > 0,
    autoTopupCents: Number(student.autoTopupCents || settings.autoTopupCents) || 0,
  }));
}

export function planNoShows({ orders = [], now = new Date(), settings }) {
  const actions = [];
  for (const order of orders) {
    if (!OPEN.has(order.status) || order.noShowActionTakenAt) continue;
    const pickup = Date.parse(order.pickupTime);
    if (!Number.isFinite(pickup)) continue;
    const ageMin = (now.getTime() - pickup) / 60000;
    if (ageMin < settings.noShowReminderMinutes) continue;
    if (!order.reminderSentAt) {
      actions.push({
        type: 'no-show-reminder',
        orderId: order.id,
        to: order.phone,
        text: formatNoShowReminder(order),
      });
    }
    if (ageMin >= settings.noShowActionMinutes) {
      actions.push({
        type: settings.noShowAction === 'write_off' ? 'write-off' : 'refund',
        orderId: order.id,
        reason: 'no-show',
      });
    }
  }
  return actions;
}

export function planChefNudge({ now = new Date(), settings, hasSpecialToday = false }) {
  const parts = partsInTZ(now);
  return {
    type: 'chef-nudge',
    hasSpecialToday,
    text: formatChefNudge(WEEKDAY_SHORT[parts.dow] || 'Today'),
    to: settings.chefWhatsappAllowlist,
  };
}

export function planSpecialDeadline({ hasSpecialToday = false }) {
  return {
    type: 'special-deadline',
    keptDefaultMenu: !hasSpecialToday,
    detail: hasSpecialToday ? 'Chef special is already on the board.' : 'No chef special by the deadline. Keeping the default menu.',
  };
}

export function planStockAlerts({ ingredients = [], menu = [], portions = {}, soldOut = {}, lowThreshold = 5 }) {
  const actions = [];
  for (const row of reorderSuggestions(ingredients)) {
    actions.push({
      type: 'low-stock',
      ingredientId: row.ingredientId,
      text: formatLowStock(row.name, row.onHand, row.unit),
    });
  }
  for (const item of menu) {
    const left = portions[item.id];
    if (left == null) continue;
    if (Number(left) <= 0 && !soldOut[item.id]) {
      actions.push({ type: 'auto-sold-out', itemId: item.id, text: formatSoldOut(item.name) });
    } else if (Number(left) > 0 && Number(left) <= lowThreshold) {
      actions.push({ type: 'low-portions', itemId: item.id, text: formatLowStock(item.name, left, 'portions') });
    }
  }
  return actions;
}

export function planEndOfDay({ orders, ledger, students, specials, waste, ingredients, recipes, now, demo }) {
  const day = sastDate(now);
  const report = buildFinanceReport({
    orders,
    ledger,
    students,
    specials,
    waste,
    ingredients,
    recipes,
    from: day,
    to: day,
    demo,
  });
  return {
    type: 'eod',
    report,
    text: formatEodSummary({
      date: day,
      revenueCents: report.revenueCents,
      topItems: report.topSellers,
      wasteCents: report.wasteCents,
      cashToBankCents: report.byMethod.cash.revenueCents,
    }),
  };
}

export function planForecast({ menu, orders, now }) {
  return { type: 'forecast', rows: prepForecast({ menu, orders, now }) };
}

export function planReconcile({ localPayments, remote }) {
  const result = reconcilePayments({ local: localPayments, remote });
  return { type: 'reconcile', ...result };
}

export const SCHEDULED_JOBS = [
  'low-balance',
  'no-show',
  'chef-nudge',
  'special-deadline',
  'stock',
  'eod',
  'weekly-csv',
  'forecast',
  'reconcile',
];
