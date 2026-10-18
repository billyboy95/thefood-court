import QRCode from 'qrcode';
import { getPickupSlots, partsInTZ, zonedDate, pad2 } from '../js/lib/hours.js';
import { formatZAR } from '../js/lib/money.js';
import { b64url, hmac, randomId, randomToken, signStandardWebhook, verifyStandardWebhook } from './crypto.js';
import { all, one, run, transaction } from './db.js';
import { HttpError } from './errors.js';
import {
  postJournal,
  spendInRange,
  statement,
  trialBalance,
  walletAccount,
  walletBalance,
} from './ledger.js';
import { listOutbox, pushToUser, recordMessage } from './notify.js';

export const FOOD = 'food-court';

export function can(actor, perm) {
  if (!actor) return false;
  if (actor.role === 'owner') return true;
  const grants = {
    cashier: ['pos', 'cashup_own', 'refund_own', 'void_own', 'wallet_topup_cash', 'outbox'],
    kitchen: ['kitchen', 'outbox'],
    supervisor: ['pos', 'kitchen', 'refund', 'void', 'cashup_all', 'outbox', 'wallet_topup_cash', 'reports_ops'],
    manager: [
      'pos', 'kitchen', 'refund', 'void', 'price', 'stock', 'purchase', 'expense', 'expense_approve',
      'reports', 'pnl', 'directory', 'settings', 'cashup_all', 'outbox', 'wallet_topup_cash', 'payroll_apply',
    ],
    finance: ['refund', 'void', 'reports', 'pnl', 'expense_view', 'cashup_all', 'outbox', 'payroll_apply', 'wallet_topup_cash', 'purchase_view'],
    student: ['order', 'wallet_own'],
    educator: ['order', 'wallet_own', 'salary'],
    parent: ['wallet_child'],
  };
  return (grants[actor.role] || []).includes(perm);
}

export function assertCan(actor, perm) {
  if (!can(actor, perm)) throw new HttpError(403, 'Your role cannot do that.');
}

export function settingsOf(ctx, entityId = FOOD) {
  return one(ctx.db, 'SELECT * FROM settings WHERE entity_id = ?', entityId);
}

export function dayStart(now) {
  const p = partsInTZ(now);
  return zonedDate(p.year, p.month, p.day, 0, 0).toISOString();
}

export function nextDayStart(now) {
  const p = partsInTZ(now);
  const noon = zonedDate(p.year, p.month, p.day, 12, 0);
  const next = partsInTZ(new Date(noon.getTime() + 24 * 60 * 60 * 1000));
  return zonedDate(next.year, next.month, next.day, 0, 0).toISOString();
}

export function monthStart(now) {
  const p = partsInTZ(now);
  return zonedDate(p.year, p.month, 1, 0, 0).toISOString();
}

export function nextMonthStart(now) {
  const p = partsInTZ(now);
  const year = p.month === 12 ? p.year + 1 : p.year;
  const month = p.month === 12 ? 1 : p.month + 1;
  return zonedDate(year, month, 1, 0, 0).toISOString();
}

export function daysInMonth(now) {
  const start = new Date(monthStart(now));
  const end = new Date(nextMonthStart(now));
  return Math.round((end - start) / 86400000);
}

export function periodStart(now, range) {
  if (range === 'week') {
    const p = partsInTZ(now);
    const mondayOffset = p.dow === 0 ? 6 : p.dow - 1;
    const noon = zonedDate(p.year, p.month, p.day, 12, 0);
    const back = partsInTZ(new Date(noon.getTime() - mondayOffset * 86400000));
    return zonedDate(back.year, back.month, back.day, 0, 0).toISOString();
  }
  if (range === 'month') return monthStart(now);
  return dayStart(now);
}

function audit(ctx, actor, action, entityType, entityRef, reason, detail) {
  run(
    ctx.db,
    `INSERT INTO audit_log (id, entity_id, actor_id, actor_role, action, entity_type, entity_ref, reason, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    randomId(),
    actor?.entity || FOOD,
    actor?.id || null,
    actor?.role || null,
    action,
    entityType,
    entityRef || null,
    reason || null,
    detail ? JSON.stringify(detail) : null,
    ctx.now().toISOString(),
  );
}

export function expireCashOrders(ctx) {
  const now = ctx.now().toISOString();
  run(
    ctx.db,
    `UPDATE orders SET fulfillment = 'expired', kitchen_visible = 0, updated_at = ?
     WHERE fulfillment = 'cash_pending' AND expires_at IS NOT NULL AND expires_at < ?`,
    now,
    now,
  );
}

function orderItems(ctx, orderId) {
  return all(ctx.db, 'SELECT * FROM order_items WHERE order_id = ?', orderId);
}

export function presentOrder(ctx, order) {
  if (!order) return null;
  const items = orderItems(ctx, order.id);
  return {
    id: order.id,
    entityId: order.entity_id,
    orderNumber: order.order_number,
    channel: order.channel,
    memberNumber: order.member_number,
    memberKind: order.member_kind,
    customerName: order.customer_name,
    phone: order.phone,
    notes: order.notes,
    pickupTime: order.pickup_time,
    pickupLabel: order.pickup_label,
    paymentStatus: order.payment_status,
    paymentMethod: order.payment_method,
    fulfillment: order.fulfillment,
    kitchenVisible: Boolean(order.kitchen_visible),
    totalCents: order.total_cents,
    tillId: order.till_id,
    paidAt: order.paid_at,
    paidByStaffId: order.paid_by_staff_id,
    tenderedCents: order.tendered_cents,
    changeCents: order.change_cents,
    expiresAt: order.expires_at,
    collectedAt: order.collected_at,
    collectedVia: order.collected_via,
    yocoReference: order.yoco_reference,
    createdAt: order.created_at,
    items: items.map((item) => ({
      itemId: item.item_id,
      name: item.name,
      qty: item.qty,
      unitPriceCents: item.unit_price_cents,
      lineTotalCents: item.line_total_cents,
    })),
    orderQr: order.fulfillment === 'ready' && order.payment_status === 'paid' ? orderQr(ctx, order) : null,
  };
}

function incomeAccount(method) {
  if (method === 'cash') return 'income:food:cash';
  if (method === 'wallet') return 'income:food:wallet';
  if (method === 'softpos') return 'income:food:softpos';
  return 'income:food:yoco';
}

function priceLines(ctx, items, dow) {
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'Your cart is empty.');
  const lines = [];
  for (const raw of items) {
    const qty = Math.floor(Number(raw.qty));
    if (!Number.isFinite(qty) || qty < 1 || qty > 20) throw new HttpError(400, 'Check the quantity.');
    const item = one(ctx.db, 'SELECT * FROM menu_items WHERE id = ? AND entity_id = ?', raw.itemId, FOOD);
    if (!item || !item.available) throw new HttpError(400, 'An item in this order is not on the board.');
    const days = item.available_days ? JSON.parse(item.available_days) : null;
    if (days?.length && !days.includes(dow)) throw new HttpError(400, `${item.name} is not available for that pickup day.`);
    if (item.stock_qty < qty) throw new HttpError(409, `${item.name} does not have enough stock.`);
    lines.push({
      itemId: item.id,
      name: item.name,
      qty,
      unitPrice: item.price_cents,
      unitCost: item.cost_cents,
      lineTotal: item.price_cents * qty,
    });
  }
  return lines;
}

function insertItems(ctx, orderId, lines) {
  for (const line of lines) {
    run(
      ctx.db,
      `INSERT INTO order_items (id, order_id, item_id, name, qty, unit_price_cents, unit_cost_cents, line_total_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      randomId(),
      orderId,
      line.itemId,
      line.name,
      line.qty,
      line.unitPrice,
      line.unitCost,
      line.lineTotal,
    );
  }
}

function deductStock(ctx, lines) {
  for (const line of lines) {
    const result = run(
      ctx.db,
      'UPDATE menu_items SET stock_qty = stock_qty - ? WHERE id = ? AND stock_qty >= ?',
      line.qty,
      line.itemId || line.item_id,
      line.qty,
    );
    if (!result.changes) throw new HttpError(409, `${line.name} is sold out.`);
  }
}

function restoreStock(ctx, orderId) {
  for (const line of orderItems(ctx, orderId)) {
    run(ctx.db, 'UPDATE menu_items SET stock_qty = stock_qty + ? WHERE id = ?', line.qty, line.item_id);
  }
}

function bumpRate(ctx, memberNumber) {
  const settings = settingsOf(ctx);
  const since = new Date(ctx.now().getTime() - 10 * 60 * 1000).toISOString();
  const row = one(
    ctx.db,
    `SELECT COUNT(*) AS n FROM rate_events WHERE student_number = ? AND action = 'order' AND created_at >= ?`,
    memberNumber,
    since,
  );
  if (Number(row?.n || 0) >= settings.order_rate_per_10_min) {
    throw new HttpError(429, 'Too many orders. Please wait a few minutes.');
  }
  run(
    ctx.db,
    `INSERT INTO rate_events (id, student_number, action, created_at) VALUES (?, ?, 'order', ?)`,
    randomId(),
    memberNumber,
    ctx.now().toISOString(),
  );
}

function orderNumber(ctx) {
  const p = partsInTZ(ctx.now());
  for (let i = 0; i < 5; i += 1) {
    const candidate = `FC-${pad2(p.day)}${randomToken(3).replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase()}`;
    if (!one(ctx.db, 'SELECT id FROM orders WHERE order_number = ?', candidate)) return candidate;
  }
  return `FC-${randomId().slice(0, 8).toUpperCase()}`;
}

async function notifyPeople(ctx, order, event, audiences) {
  const items = orderItems(ctx, order.id);
  const lines = items.map((item) => `${item.qty}× ${item.name}`);
  const base = [
    `EASTC Food Court ${order.order_number}`,
    order.customer_name,
    ...lines,
  ];
  if (order.notes) base.push(`Notes: ${order.notes}`);
  base.push(formatZAR(order.total_cents));
  const text = {
    order_received: `Order received. ${base.join(' · ')}`,
    payment_received: `Payment received. ${base.join(' · ')}`,
    status_preparing: `Update: ${order.order_number} is being prepared.`,
    status_ready: `Ready for collection: ${order.order_number}. ${order.customer_name}. ${lines.join(', ')}`,
    status_collected: `${order.order_number} collected.`,
    cash_pending: `Cash at counter: ${base.join(' · ')}. Unpaid until the till takes the cash.`,
  }[event] || base.join(' · ');
  const tasks = [];
  for (const audience of audiences) {
    const to = audience === 'customer' ? order.phone : audience === 'kitchen' ? ctx.config.kitchenWhatsapp : ctx.config.tillWhatsapp;
    tasks.push(recordMessage(ctx, {
      entityId: order.entity_id,
      orderId: order.id,
      userId: audience === 'customer' ? userIdForMember(ctx, order.member_number) : null,
      audience,
      channel: 'whatsapp',
      event,
      to,
      body: text,
    }));
    if (event === 'status_ready' && audience === 'customer') {
      tasks.push(recordMessage(ctx, {
        entityId: order.entity_id,
        orderId: order.id,
        userId: userIdForMember(ctx, order.member_number),
        audience: 'customer',
        channel: 'sms',
        event,
        to: order.phone,
        body: text,
      }));
      const uid = userIdForMember(ctx, order.member_number);
      if (uid) tasks.push(pushToUser(ctx, uid, 'Order ready', text));
    }
  }
  await Promise.all(tasks);
}

function userIdForMember(ctx, memberNumber) {
  const user = one(
    ctx.db,
    'SELECT id FROM users WHERE student_number = ? OR staff_number = ?',
    memberNumber,
    memberNumber,
  );
  return user?.id || null;
}

function settlePaid(ctx, orderId, { method, staff, tenderedCents = null, changeCents = null, tillId = null, yocoReference = null }) {
  const order = one(ctx.db, 'SELECT * FROM orders WHERE id = ?', orderId);
  if (!order) throw new HttpError(404, 'Order not found.');
  if (order.payment_status === 'paid') return order;
  const items = orderItems(ctx, order.id);
  deductStock(ctx, items);
  const cost = items.reduce((sum, item) => sum + item.unit_cost_cents * item.qty, 0);
  const debit = method === 'wallet'
    ? walletAccount(order.member_number)
    : method === 'cash'
      ? `asset:cash:${tillId || 'unassigned'}`
      : 'asset:yoco_clearing';
  const entryLines = [
    { account: debit, debitCents: order.total_cents },
    { account: incomeAccount(method), creditCents: order.total_cents },
  ];
  if (cost) {
    entryLines.push({ account: 'expense:cogs', debitCents: cost });
    entryLines.push({ account: 'asset:inventory', creditCents: cost });
  }
  postJournal(ctx.db, {
    entityId: order.entity_id,
    memo: `${order.order_number} ${method}`,
    refType: 'food_sale',
    refId: order.id,
    lines: entryLines,
    now: ctx.now().toISOString(),
  });
  let fulfillment = order.fulfillment;
  if (fulfillment === 'cash_pending' || fulfillment === 'awaiting_payment' || fulfillment === 'failed') {
    fulfillment = order.channel === 'walkin' ? 'collected' : 'paid';
  }
  const collected = fulfillment === 'collected' ? ctx.now().toISOString() : order.collected_at;
  run(
    ctx.db,
    `UPDATE orders SET payment_status = 'paid', payment_method = ?, fulfillment = ?, kitchen_visible = ?,
      till_id = COALESCE(?, till_id), paid_by_staff_id = ?, paid_at = ?, tendered_cents = ?, change_cents = ?,
      yoco_reference = COALESCE(?, yoco_reference), collected_at = ?, updated_at = ? WHERE id = ?`,
    method,
    fulfillment,
    order.channel === 'walkin' ? 0 : 1,
    tillId,
    staff?.id || null,
    ctx.now().toISOString(),
    tenderedCents,
    changeCents,
    yocoReference,
    collected,
    ctx.now().toISOString(),
    order.id,
  );
  if (method === 'wallet') maybeLowBalance(ctx, order.member_number);
  return one(ctx.db, 'SELECT * FROM orders WHERE id = ?', order.id);
}

export async function createOnlineOrder(ctx, actor, input) {
  if (actor?.kind !== 'student' && actor?.kind !== 'educator') {
    throw new HttpError(403, 'Ordering is only open to verified EASTC students and staff.');
  }
  expireCashOrders(ctx);
  const method = String(input?.method || '');
  if (!['yoco_card', 'yoco_eft', 'cash', 'wallet'].includes(method)) {
    throw new HttpError(400, 'Choose Yoco, wallet, or cash at the counter.');
  }
  const slots = getPickupSlots(ctx.now());
  const slot = slots.find((item) => item.iso === input?.pickupTime);
  if (!slot) throw new HttpError(400, 'Choose a pickup time from the list.');
  const lines = priceLines(ctx, input?.items, slot.dow);
  const total = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  bumpRate(ctx, actor.memberNumber);
  const settings = settingsOf(ctx);
  if (method === 'cash') {
    const open = one(
      ctx.db,
      `SELECT COUNT(*) AS n FROM orders WHERE member_number = ? AND fulfillment = 'cash_pending'`,
      actor.memberNumber,
    );
    if (Number(open?.n || 0) >= settings.unpaid_cash_cap) {
      throw new HttpError(409, 'You already have unpaid cash orders. Pay them or wait for them to expire.');
    }
  }
  if (method === 'wallet') assertCanSpend(ctx, actor.memberNumber, total);
  const now = ctx.now().toISOString();
  const id = randomId();
  const kitchenVisible = method === 'wallet' || (method === 'cash' && settings.kitchen_starts === 'on_order') ? 1 : 0;
  const fulfillment = method === 'wallet' ? 'paid' : method === 'cash' ? 'cash_pending' : 'awaiting_payment';
  const paymentStatus = method === 'wallet' ? 'unpaid' : method === 'cash' ? 'unpaid' : 'pending';
  transaction(ctx.db, () => {
    run(
      ctx.db,
      `INSERT INTO orders (
        id, entity_id, order_number, channel, student_number, member_number, member_kind, customer_name, phone, notes,
        pickup_time, pickup_label, payment_status, payment_method, fulfillment, kitchen_visible, total_cents, expires_at, created_at, updated_at
      ) VALUES (?, 'food-court', ?, 'online', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      orderNumber(ctx),
      actor.studentNumber,
      actor.memberNumber,
      actor.kind,
      actor.name,
      actor.phone,
      String(input?.notes || '').trim().slice(0, 240),
      slot.iso,
      slot.label,
      paymentStatus,
      method === 'yoco_card' || method === 'yoco_eft' ? 'yoco' : method,
      fulfillment,
      method === 'wallet' ? 0 : kitchenVisible,
      total,
      method === 'cash' ? new Date(ctx.now().getTime() + settings.cash_expire_minutes * 60000).toISOString() : null,
      now,
      now,
    );
    insertItems(ctx, id, lines);
    if (method === 'wallet') settlePaid(ctx, id, { method: 'wallet' });
  });
  const order = one(ctx.db, 'SELECT * FROM orders WHERE id = ?', id);
  if (method === 'wallet') {
    await notifyPeople(ctx, order, 'order_received', ['customer', 'kitchen', 'till']);
    await notifyPeople(ctx, order, 'payment_received', ['customer']);
  } else if (method === 'cash') {
    const audiences = ['customer', 'till'];
    if (order.kitchen_visible) audiences.push('kitchen');
    await notifyPeople(ctx, order, 'cash_pending', audiences);
  }
  let payment = null;
  if (method === 'yoco_card' || method === 'yoco_eft') {
    payment = createIntent(ctx, {
      entityId: FOOD,
      purpose: 'food_order',
      method,
      amountCents: total,
      payerUserId: actor.id,
      studentNumber: actor.memberNumber,
      orderId: id,
      metadata: { orderNumber: order.order_number },
    });
  }
  return { order: presentOrder(ctx, one(ctx.db, 'SELECT * FROM orders WHERE id = ?', id)), payment };
}

export function createIntent(ctx, input) {
  const id = randomId();
  const now = ctx.now().toISOString();
  run(
    ctx.db,
    `INSERT INTO payment_intents (
      id, entity_id, purpose, method, amount_cents, status, payer_user_id, student_number, order_id, reference, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.entityId,
    input.purpose,
    input.method,
    input.amountCents,
    input.payerUserId || null,
    input.studentNumber || null,
    input.orderId || null,
    input.reference || `PAY-${id.slice(0, 8).toUpperCase()}`,
    JSON.stringify(input.metadata || {}),
    now,
    now,
  );
  const intent = one(ctx.db, 'SELECT * FROM payment_intents WHERE id = ?', id);
  return presentIntent(ctx, intent);
}

export function presentIntent(ctx, intent) {
  if (!intent) return null;
  const test = ctx.config.yocoTestMode;
  const softpos = intent.method === 'softpos_link' || intent.method === 'softpos_reference';
  const link = softpos
    ? ctx.config.softposLinkTemplate
        .replaceAll('{amount}', String(intent.amount_cents))
        .replaceAll('{reference}', intent.reference)
    : null;
  return {
    id: intent.id,
    entityId: intent.entity_id,
    purpose: intent.purpose,
    method: intent.method,
    amountCents: intent.amount_cents,
    currency: intent.currency,
    status: intent.status,
    reference: intent.reference,
    yocoReference: intent.yoco_reference,
    orderId: intent.order_id,
    memberNumber: intent.student_number,
    testMode: Boolean(test && String(intent.method).startsWith('yoco')),
    checkoutUrl: String(intent.method).startsWith('yoco') && test ? `/pay/test/${intent.id}` : null,
    softposDeepLink: link,
    browserCardRead: false,
    note: softpos
      ? 'This phone browser cannot read a contactless bank card. Hand the payment to the Yoco app or card machine, then record the Yoco reference.'
      : null,
  };
}

function walletRow(ctx, memberNumber, entityId = FOOD) {
  return one(
    ctx.db,
    'SELECT * FROM wallet_accounts WHERE entity_id = ? AND member_number = ?',
    entityId,
    memberNumber,
  );
}

export function walletView(ctx, memberNumber, entityId = FOOD) {
  const row = walletRow(ctx, memberNumber, entityId);
  if (!row) throw new HttpError(404, 'No food wallet for that EASTC number.');
  const now = ctx.now();
  const spentToday = spendInRange(ctx.db, memberNumber, entityId, dayStart(now), nextDayStart(now));
  const spentMonth = spendInRange(ctx.db, memberNumber, entityId, monthStart(now), nextMonthStart(now));
  const dailyCap = row.daily_allowance_enabled && row.monthly_budget_cents
    ? Math.floor(row.monthly_budget_cents / daysInMonth(now))
    : null;
  const remainingToday = dailyCap == null ? null : Math.max(0, dailyCap - spentToday);
  const allocation = one(
    ctx.db,
    `SELECT * FROM salary_allocations WHERE entity_id = ? AND staff_number = ? ORDER BY created_at DESC LIMIT 1`,
    entityId,
    memberNumber,
  );
  return {
    entityId,
    memberNumber: row.member_number,
    memberKind: row.member_kind,
    balanceCents: walletBalance(ctx.db, memberNumber, entityId),
    dailyLimitCents: row.daily_limit_cents,
    monthlyLimitCents: row.monthly_limit_cents,
    lowBalanceCents: row.low_balance_cents,
    spentTodayCents: spentToday,
    spentMonthCents: spentMonth,
    dailyAllowance: {
      enabled: Boolean(row.daily_allowance_enabled),
      monthlyBudgetCents: row.monthly_budget_cents,
      daysInMonth: daysInMonth(now),
      dailyCapCents: dailyCap,
      remainingTodayCents: remainingToday,
    },
    parentAllowance: { amountCents: row.allowance_cents, day: row.allowance_day },
    salaryAllocation: allocation
      ? {
          id: allocation.id,
          mode: allocation.mode,
          amountCents: allocation.amount_cents,
          percent: allocation.percent,
          declaredSalaryCents: allocation.declared_salary_cents,
          paydayDay: allocation.payday_day,
          status: allocation.status,
          consentAt: allocation.consent_at,
          cancelledAt: allocation.cancelled_at,
          instructionAmountCents: allocationAmount(allocation),
        }
      : null,
    history: statement(ctx.db, memberNumber, entityId).slice().reverse(),
  };
}

function allocationAmount(allocation) {
  if (!allocation || allocation.status === 'cancelled') return 0;
  if (allocation.mode === 'amount') return Number(allocation.amount_cents || 0);
  return Math.round((Number(allocation.declared_salary_cents || 0) * Number(allocation.percent || 0)) / 100);
}

function assertCanSpend(ctx, memberNumber, amount) {
  const view = walletView(ctx, memberNumber);
  if (view.balanceCents < amount) throw new HttpError(402, 'Food wallet balance is too low.');
  if (view.spentTodayCents + amount > view.dailyLimitCents) {
    throw new HttpError(402, 'This is above the daily spend limit.');
  }
  if (view.spentMonthCents + amount > view.monthlyLimitCents) {
    throw new HttpError(402, 'This is above the monthly spend limit.');
  }
  if (view.dailyAllowance.enabled && view.spentTodayCents + amount > view.dailyAllowance.dailyCapCents) {
    throw new HttpError(402, `Above today’s allowance. Remaining today is ${formatZAR(view.dailyAllowance.remainingTodayCents)}.`);
  }
}

function maybeLowBalance(ctx, memberNumber) {
  const row = walletRow(ctx, memberNumber);
  if (!row) return;
  const balance = walletBalance(ctx.db, memberNumber, row.entity_id);
  const today = dayStart(ctx.now()).slice(0, 10);
  if (balance >= row.low_balance_cents || row.last_low_alert === today) return;
  run(ctx.db, 'UPDATE wallet_accounts SET last_low_alert = ? WHERE id = ?', today, row.id);
  const user = one(ctx.db, 'SELECT * FROM users WHERE student_number = ? OR staff_number = ?', memberNumber, memberNumber);
  const parent = one(ctx.db, `SELECT * FROM users WHERE kind = 'parent' AND linked_student_number = ?`, memberNumber);
  const target = parent || user;
  if (!target) return;
  recordMessage(ctx, {
    entityId: row.entity_id,
    userId: target.id,
    audience: parent ? 'parent' : 'customer',
    channel: 'whatsapp',
    event: 'low_balance',
    to: target.phone,
    body: `Food wallet ${memberNumber} is low: ${formatZAR(balance)} left.`,
  });
}

export function setDailyAllowance(ctx, actor, input) {
  assertCan(actor, 'wallet_own');
  const enabled = Boolean(input?.enabled);
  const budget = input?.monthlyBudgetCents == null ? null : Math.round(Number(input.monthlyBudgetCents));
  if (enabled && (!budget || budget < 100)) throw new HttpError(400, 'Set a monthly amount so the daily allowance can be calculated.');
  run(
    ctx.db,
    `UPDATE wallet_accounts SET daily_allowance_enabled = ?, monthly_budget_cents = ? WHERE entity_id = ? AND member_number = ?`,
    enabled ? 1 : 0,
    enabled ? budget : null,
    actor.entity === FOOD ? FOOD : actor.entity,
    actor.memberNumber,
  );
  return walletView(ctx, actor.memberNumber, FOOD);
}

export function setChildLimits(ctx, actor, input) {
  assertCan(actor, 'wallet_child');
  const number = actor.linkedStudentNumber;
  const daily = Math.round(Number(input?.dailyLimitCents));
  const monthly = Math.round(Number(input?.monthlyLimitCents));
  if (daily < 0 || monthly < 0) throw new HttpError(400, 'Limits must be zero or more.');
  run(
    ctx.db,
    `UPDATE wallet_accounts SET daily_limit_cents = ?, monthly_limit_cents = ?, low_balance_cents = ?, allowance_cents = ?, allowance_day = ?
     WHERE entity_id = 'food-court' AND member_number = ?`,
    daily,
    monthly,
    Math.round(Number(input?.lowBalanceCents ?? 5000)),
    input?.allowanceCents == null ? null : Math.round(Number(input.allowanceCents)),
    input?.allowanceDay == null ? null : Math.round(Number(input.allowanceDay)),
    number,
  );
  return walletView(ctx, number);
}

export function saveSalaryAllocation(ctx, actor, input) {
  assertCan(actor, 'salary');
  if (!input?.consent) throw new HttpError(400, 'Consent is required before a payroll deduction instruction is recorded.');
  const mode = input.mode === 'percent' ? 'percent' : input.mode === 'amount' ? 'amount' : null;
  if (!mode) throw new HttpError(400, 'Choose an amount or a percent of salary.');
  const payday = Math.round(Number(input.paydayDay));
  if (payday < 1 || payday > 28) throw new HttpError(400, 'Payday must be a day from 1 to 28.');
  const registry = one(ctx.db, 'SELECT * FROM staff_registry WHERE staff_number = ?', actor.staffNumber);
  let amount = null;
  let percent = null;
  let declared = registry?.monthly_salary_cents || null;
  if (mode === 'amount') {
    amount = Math.round(Number(input.amountCents));
    if (!amount || amount < 100) throw new HttpError(400, 'Enter the amount to move into the wallet each payday.');
  } else {
    percent = Math.round(Number(input.percent));
    if (percent < 1 || percent > 100) throw new HttpError(400, 'Percent must be between 1 and 100.');
    if (input.declaredSalaryCents) declared = Math.round(Number(input.declaredSalaryCents));
    if (!declared) throw new HttpError(400, 'A declared monthly salary is required to calculate a percent. Payroll is not connected.');
  }
  run(
    ctx.db,
    `UPDATE salary_allocations SET status = 'cancelled', cancelled_at = ? WHERE staff_number = ? AND entity_id = 'food-court' AND status = 'active'`,
    ctx.now().toISOString(),
    actor.staffNumber,
  );
  const id = randomId();
  const consent = 'I consent to EASTC recording a payroll deduction instruction for my food wallet. No live payroll system is connected. I can cancel this instruction.';
  run(
    ctx.db,
    `INSERT INTO salary_allocations (
      id, entity_id, user_id, staff_number, mode, amount_cents, percent, declared_salary_cents, payday_day, consent_at, consent_text, status, created_at
    ) VALUES (?, 'food-court', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    id,
    actor.id,
    actor.staffNumber,
    mode,
    amount,
    percent,
    declared,
    payday,
    ctx.now().toISOString(),
    consent,
    ctx.now().toISOString(),
  );
  audit(ctx, actor, 'salary_allocation', 'salary_allocation', id, consent, { mode, amount, percent, payday });
  return walletView(ctx, actor.memberNumber);
}

export function cancelSalaryAllocation(ctx, actor) {
  assertCan(actor, 'salary');
  const current = one(
    ctx.db,
    `SELECT * FROM salary_allocations WHERE staff_number = ? AND entity_id = 'food-court' AND status = 'active'`,
    actor.staffNumber,
  );
  if (!current) throw new HttpError(404, 'There is no active salary allocation.');
  run(
    ctx.db,
    `UPDATE salary_allocations SET status = 'cancelled', cancelled_at = ? WHERE id = ?`,
    ctx.now().toISOString(),
    current.id,
  );
  audit(ctx, actor, 'salary_allocation_cancel', 'salary_allocation', current.id, 'Cancelled by the staff member');
  return walletView(ctx, actor.memberNumber);
}

/** Placeholder payroll adapter: records an instruction. It does not call a payroll vendor. */
export async function tickPayroll(ctx, entityId = FOOD) {
  const p = partsInTZ(ctx.now());
  const period = `${p.year}-${pad2(p.month)}`;
  const rows = all(
    ctx.db,
    `SELECT * FROM salary_allocations WHERE entity_id = ? AND status = 'active'`,
    entityId,
  );
  const queued = [];
  for (const allocation of rows) {
    if (p.day < allocation.payday_day) continue;
    const exists = one(
      ctx.db,
      'SELECT id FROM payroll_instructions WHERE allocation_id = ? AND period = ?',
      allocation.id,
      period,
    );
    if (exists) continue;
    const amount = allocationAmount(allocation);
    const id = randomId();
    run(
      ctx.db,
      `INSERT INTO payroll_instructions (
        id, entity_id, allocation_id, staff_number, period, amount_cents, status, adapter, detail_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'placeholder', ?, ?)`,
      id,
      entityId,
      allocation.id,
      allocation.staff_number,
      period,
      amount,
      JSON.stringify({
        adapter: 'placeholder',
        note: 'No real payroll integration. This is an instruction record only until finance applies it in the demo.',
      }),
      ctx.now().toISOString(),
    );
    const user = one(ctx.db, 'SELECT * FROM users WHERE staff_number = ?', allocation.staff_number);
    if (user) {
      await recordMessage(ctx, {
        entityId,
        userId: user.id,
        audience: 'customer',
        channel: 'whatsapp',
        event: 'payroll_instruction',
        to: user.phone,
        body: `Payday instruction queued for ${allocation.staff_number}: ${formatZAR(amount)} into the food wallet. Payroll adapter: placeholder.`,
      });
    }
    queued.push(id);
  }
  return queued;
}

export function applyPayrollInstruction(ctx, actor, id) {
  assertCan(actor, 'payroll_apply');
  const row = one(ctx.db, 'SELECT * FROM payroll_instructions WHERE id = ? AND entity_id = ?', id, actor.entity);
  if (!row) throw new HttpError(404, 'Payroll instruction not found.');
  if (row.status !== 'queued') throw new HttpError(409, 'This instruction is not waiting.');
  transaction(ctx.db, () => {
    postJournal(ctx.db, {
      entityId: row.entity_id,
      memo: `Salary allocation ${row.staff_number} ${row.period}`,
      refType: 'salary_allocation',
      refId: row.id,
      now: ctx.now().toISOString(),
      lines: [
        { account: 'asset:payroll_clearing', debitCents: row.amount_cents },
        { account: walletAccount(row.staff_number), creditCents: row.amount_cents },
      ],
    });
    run(
      ctx.db,
      `UPDATE payroll_instructions SET status = 'applied', applied_at = ? WHERE id = ?`,
      ctx.now().toISOString(),
      row.id,
    );
  });
  audit(ctx, actor, 'payroll_apply', 'payroll_instruction', row.id, 'Applied placeholder payroll instruction');
  return one(ctx.db, 'SELECT * FROM payroll_instructions WHERE id = ?', row.id);
}

export async function cashWalletTopup(ctx, actor, input) {
  assertCan(actor, 'wallet_topup_cash');
  const memberNumber = String(input?.memberNumber || '').trim().toUpperCase();
  const wallet = walletRow(ctx, memberNumber, actor.entity || FOOD);
  if (!wallet) throw new HttpError(404, 'No food wallet for that number.');
  const amount = Math.round(Number(input?.amountCents));
  const tendered = Math.round(Number(input?.tenderedCents));
  if (amount < 100) throw new HttpError(400, 'Enter a top-up amount.');
  if (tendered < amount) throw new HttpError(400, 'Amount tendered is less than the top-up.');
  const tillId = actor.tillId || input.tillId || 'till-1';
  if (actor.role === 'cashier' && tillId !== actor.tillId) throw new HttpError(403, 'You can only take cash on your own till.');
  const intent = createIntent(ctx, {
    entityId: wallet.entity_id,
    purpose: 'wallet_topup',
    method: 'cash',
    amountCents: amount,
    payerUserId: wallet.user_id,
    studentNumber: memberNumber,
    metadata: { tendered, change: tendered - amount, tillId },
  });
  transaction(ctx.db, () => {
    postJournal(ctx.db, {
      entityId: wallet.entity_id,
      memo: `Cash wallet top-up ${memberNumber}`,
      refType: 'wallet_topup',
      refId: intent.id,
      now: ctx.now().toISOString(),
      lines: [
        { account: `asset:cash:${tillId}`, debitCents: amount },
        { account: walletAccount(memberNumber), creditCents: amount },
      ],
    });
    run(ctx.db, `UPDATE payment_intents SET status = 'succeeded', updated_at = ? WHERE id = ?`, ctx.now().toISOString(), intent.id);
  });
  audit(ctx, actor, 'wallet_topup_cash', 'wallet', memberNumber, null, { amount, tendered, change: tendered - amount });
  await recordMessage(ctx, {
    entityId: wallet.entity_id,
    userId: wallet.user_id,
    audience: 'customer',
    channel: 'whatsapp',
    event: 'wallet_topup',
    to: one(ctx.db, 'SELECT phone FROM users WHERE id = ?', wallet.user_id)?.phone || '',
    body: `Food wallet topped up with cash: ${formatZAR(amount)}. Balance ${formatZAR(walletBalance(ctx.db, memberNumber))}.`,
  });
  return { payment: presentIntent(ctx, one(ctx.db, 'SELECT * FROM payment_intents WHERE id = ?', intent.id)), wallet: walletView(ctx, memberNumber), changeCents: tendered - amount };
}

export function startYocoTopup(ctx, actor, input) {
  const own = actor.kind === 'student' || actor.kind === 'educator';
  const parent = actor.kind === 'parent';
  if (!own && !parent) throw new HttpError(403, 'Only a member or a linked parent can top up a food wallet.');
  const memberNumber = parent ? actor.linkedStudentNumber : actor.memberNumber;
  const method = input?.method === 'yoco_eft' ? 'yoco_eft' : 'yoco_card';
  const amount = Math.round(Number(input?.amountCents));
  if (amount < 100) throw new HttpError(400, 'Enter a top-up amount.');
  walletRow(ctx, memberNumber) || (() => { throw new HttpError(404, 'No food wallet for that number.'); })();
  return createIntent(ctx, {
    entityId: FOOD,
    purpose: 'wallet_topup',
    method,
    amountCents: amount,
    payerUserId: actor.id,
    studentNumber: memberNumber,
  });
}

export async function takeCash(ctx, actor, orderId, tenderedCents) {
  assertCan(actor, 'pos');
  expireCashOrders(ctx);
  const order = one(ctx.db, 'SELECT * FROM orders WHERE id = ? AND entity_id = ?', orderId, actor.entity);
  if (!order) throw new HttpError(404, 'Order not found.');
  if (order.fulfillment === 'expired') throw new HttpError(410, 'This cash order has expired.');
  if (order.payment_method !== 'cash' || order.fulfillment !== 'cash_pending') {
    throw new HttpError(409, 'This order is not waiting for cash.');
  }
  const tendered = Math.round(Number(tenderedCents));
  if (tendered < order.total_cents) throw new HttpError(400, 'Amount tendered is less than the total.');
  const tillId = actor.tillId || 'till-1';
  let settled;
  transaction(ctx.db, () => {
    settled = settlePaid(ctx, order.id, {
      method: 'cash',
      staff: actor,
      tenderedCents: tendered,
      changeCents: tendered - order.total_cents,
      tillId,
    });
  });
  audit(ctx, actor, 'cash_take', 'order', order.id, null, { tendered, change: tendered - order.total_cents, tillId });
  await notifyPeople(ctx, settled, 'payment_received', ['customer', 'kitchen', 'till']);
  return presentOrder(ctx, settled);
}

export async function setOrderStatus(ctx, actor, orderId, next) {
  assertCan(actor, 'kitchen');
  if (!['preparing', 'ready', 'collected'].includes(next)) throw new HttpError(400, 'Unknown status.');
  const order = one(ctx.db, 'SELECT * FROM orders WHERE id = ? AND entity_id = ?', orderId, actor.entity);
  if (!order) throw new HttpError(404, 'Order not found.');
  if (['collected', 'refunded', 'voided', 'expired', 'failed'].includes(order.fulfillment)) {
    throw new HttpError(409, 'This order can no longer move.');
  }
  if (order.fulfillment === 'cash_pending' && !order.kitchen_visible) {
    throw new HttpError(409, 'Kitchen starts after cash is taken.');
  }
  const expected = {
    paid: 'preparing',
    cash_pending: 'preparing',
    preparing: 'ready',
    ready: 'collected',
  }[order.fulfillment];
  if (next !== expected) throw new HttpError(409, 'Status can only move one step at a time.');
  if (next === 'collected' && order.payment_status !== 'paid') {
    throw new HttpError(409, 'Collect only after the order is paid.');
  }
  if (next === 'collected') return presentOrder(ctx, markCollected(ctx, order, 'staff_button', actor));
  run(
    ctx.db,
    'UPDATE orders SET fulfillment = ?, updated_at = ? WHERE id = ?',
    next,
    ctx.now().toISOString(),
    order.id,
  );
  const updated = one(ctx.db, 'SELECT * FROM orders WHERE id = ?', order.id);
  const event = next === 'ready' ? 'status_ready' : 'status_preparing';
  await notifyPeople(ctx, updated, event, ['customer']);
  return presentOrder(ctx, updated);
}

function markCollected(ctx, order, via, actor) {
  if (order.collected_at || order.fulfillment === 'collected') {
    throw new HttpError(409, 'This order was already collected.');
  }
  if (order.payment_status !== 'paid') throw new HttpError(409, 'Collect only after the order is paid.');
  if (order.fulfillment !== 'ready') throw new HttpError(409, 'The kitchen has not marked this order ready.');
  const now = ctx.now().toISOString();
  const result = run(
    ctx.db,
    `UPDATE orders SET fulfillment = 'collected', collected_at = ?, collected_via = ?, kitchen_visible = 0, updated_at = ?
     WHERE id = ? AND collected_at IS NULL`,
    now,
    via,
    now,
    order.id,
  );
  if (!result.changes) throw new HttpError(409, 'This order was already collected.');
  audit(ctx, actor, 'collect', 'order', order.id, via);
  return one(ctx.db, 'SELECT * FROM orders WHERE id = ?', order.id);
}

function signBody(secret, payload) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${hmac(secret, body)}`;
}

function readSigned(secret, token, prefix) {
  const raw = String(token || '');
  if (!raw.startsWith(prefix)) return null;
  const rest = raw.slice(prefix.length);
  const dot = rest.lastIndexOf('.');
  if (dot < 0) return null;
  const body = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  const expected = hmac(secret, body);
  if (expected.length !== sig.length) return null;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) mismatch |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (mismatch) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function counterToken(ctx, entityId = FOOD) {
  const window = Math.floor(ctx.now().getTime() / 30000);
  return `fcq1.${signBody(ctx.config.qrSecret, { w: window, e: entityId })}`;
}

export function verifyCounter(ctx, token, entityId = FOOD) {
  const payload = readSigned(ctx.config.qrSecret, token, 'fcq1.');
  if (!payload || payload.e !== entityId) return false;
  const window = Math.floor(ctx.now().getTime() / 30000);
  return payload.w === window || payload.w === window - 1;
}

function orderQr(ctx, order) {
  const exp = ctx.now().getTime() + 12 * 60 * 60 * 1000;
  return `fco1.${signBody(ctx.config.qrSecret, { o: order.id, exp })}`;
}

export async function counterQrImage(ctx, entityId) {
  const token = counterToken(ctx, entityId);
  const dataUrl = await QRCode.toDataURL(token, { margin: 1, width: 280 });
  return { token, dataUrl, rotatesSeconds: 30 };
}

export function collectByCounter(ctx, actor, token) {
  if (actor?.kind !== 'student' && actor?.kind !== 'educator') {
    throw new HttpError(403, 'Scan from the logged-in student or staff account that placed the order.');
  }
  if (!verifyCounter(ctx, token, FOOD)) throw new HttpError(401, 'That counter code is not valid or has rotated.');
  const order = one(
    ctx.db,
    `SELECT * FROM orders WHERE member_number = ? AND entity_id = 'food-court' AND payment_status = 'paid' AND fulfillment = 'ready'
     ORDER BY created_at ASC LIMIT 1`,
    actor.memberNumber,
  );
  if (!order) throw new HttpError(404, 'No paid ready order on this account.');
  return presentOrder(ctx, markCollected(ctx, order, 'student_scan', actor));
}

export function collectByOrderQr(ctx, actor, token) {
  assertCan(actor, 'kitchen');
  const payload = readSigned(ctx.config.qrSecret, token, 'fco1.');
  if (!payload || payload.exp < ctx.now().getTime()) throw new HttpError(401, 'That order code is not valid.');
  const order = one(ctx.db, 'SELECT * FROM orders WHERE id = ? AND entity_id = ?', payload.o, actor.entity);
  if (!order) throw new HttpError(404, 'Order not found.');
  return presentOrder(ctx, markCollected(ctx, order, 'staff_scan', actor));
}

export async function createWalkIn(ctx, actor, input) {
  assertCan(actor, 'pos');
  const method = String(input?.method || 'cash');
  if (!['cash', 'yoco_card', 'softpos'].includes(method)) throw new HttpError(400, 'Choose cash, a Yoco link, or Yoco tap-to-phone.');
  const dow = partsInTZ(ctx.now()).dow;
  const lines = priceLines(ctx, input?.items, dow);
  const total = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const id = randomId();
  const now = ctx.now().toISOString();
  const tillId = actor.tillId || 'till-1';
  transaction(ctx.db, () => {
    run(
      ctx.db,
      `INSERT INTO orders (
        id, entity_id, order_number, channel, customer_name, phone, notes, payment_status, payment_method, fulfillment,
        kitchen_visible, total_cents, till_id, created_by_staff_id, created_at, updated_at, member_number, member_kind
      ) VALUES (?, ?, ?, 'walkin', ?, ?, ?, 'pending', ?, 'awaiting_payment', 0, ?, ?, ?, ?, ?, NULL, NULL)`,
      id,
      actor.entity,
      orderNumber(ctx),
      String(input?.customerName || 'Walk-in').slice(0, 80),
      '',
      String(input?.notes || '').slice(0, 240),
      method === 'softpos' ? 'softpos' : method === 'cash' ? 'cash' : 'yoco',
      total,
      tillId,
      actor.id,
      now,
      now,
    );
    insertItems(ctx, id, lines);
    if (method === 'cash') {
      const tendered = Math.round(Number(input?.tenderedCents ?? total));
      if (tendered < total) throw new HttpError(400, 'Amount tendered is less than the total.');
      settlePaid(ctx, id, { method: 'cash', staff: actor, tenderedCents: tendered, changeCents: tendered - total, tillId });
    }
  });
  let payment = null;
  if (method !== 'cash') {
    payment = createIntent(ctx, {
      entityId: actor.entity,
      purpose: 'food_order',
      method: method === 'softpos' ? 'softpos_link' : 'yoco_card',
      amountCents: total,
      payerUserId: actor.id,
      orderId: id,
      metadata: { channel: 'walkin' },
    });
  }
  return { order: presentOrder(ctx, one(ctx.db, 'SELECT * FROM orders WHERE id = ?', id)), payment };
}

export function walletTapToken(ctx, actor) {
  if (actor.kind !== 'student' && actor.kind !== 'educator') throw new HttpError(403, 'Only a member wallet can be tapped.');
  const exp = ctx.now().getTime() + 60 * 1000;
  const nonce = randomToken(9);
  run(
    ctx.db,
    'INSERT INTO tap_nonces (nonce, student_number, expires_at) VALUES (?, ?, ?)',
    nonce,
    actor.memberNumber,
    new Date(exp).toISOString(),
  );
  const token = `fwt1.${signBody(ctx.config.qrSecret, { m: actor.memberNumber, n: nonce, exp, e: FOOD })}`;
  return { token, expiresAt: new Date(exp).toISOString(), nfcUrl: `https://foodcourt.local/tap/${token}` };
}

export async function chargeWalletTap(ctx, actor, input) {
  assertCan(actor, 'pos');
  const payload = readSigned(ctx.config.qrSecret, input?.token, 'fwt1.');
  if (!payload || payload.exp < ctx.now().getTime()) throw new HttpError(401, 'That wallet tap has expired.');
  const nonce = one(ctx.db, 'SELECT * FROM tap_nonces WHERE nonce = ?', payload.n);
  if (!nonce || nonce.used_at || nonce.student_number !== payload.m) throw new HttpError(409, 'That wallet tap was already used.');
  if (input?.orderId) {
    const order = one(ctx.db, 'SELECT * FROM orders WHERE id = ?', input.orderId);
    if (!order || order.member_number !== payload.m) throw new HttpError(403, 'This tap does not belong to that order.');
    if (order.payment_status === 'paid') throw new HttpError(409, 'Order is already paid.');
    assertCanSpend(ctx, payload.m, order.total_cents);
    let settled;
    transaction(ctx.db, () => {
      run(ctx.db, 'UPDATE tap_nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL', ctx.now().toISOString(), payload.n);
      settled = settlePaid(ctx, order.id, { method: 'wallet', staff: actor, tillId: actor.tillId });
    });
    await notifyPeople(ctx, settled, 'payment_received', ['customer', 'kitchen', 'till']);
    return { order: presentOrder(ctx, settled), wallet: walletView(ctx, payload.m) };
  }
  const dow = partsInTZ(ctx.now()).dow;
  const lines = priceLines(ctx, input?.items, dow);
  const total = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  assertCanSpend(ctx, payload.m, total);
  const member = one(ctx.db, 'SELECT * FROM users WHERE student_number = ? OR staff_number = ?', payload.m, payload.m);
  const id = randomId();
  const now = ctx.now().toISOString();
  transaction(ctx.db, () => {
    const used = run(ctx.db, 'UPDATE tap_nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL', now, payload.n);
    if (!used.changes) throw new HttpError(409, 'That wallet tap was already used.');
    run(
      ctx.db,
      `INSERT INTO orders (
        id, entity_id, order_number, channel, student_number, member_number, member_kind, customer_name, phone, notes,
        payment_status, payment_method, fulfillment, kitchen_visible, total_cents, till_id, created_by_staff_id, created_at, updated_at
      ) VALUES (?, 'food-court', ?, 'walkin', ?, ?, ?, ?, ?, '', 'pending', 'wallet', 'awaiting_payment', 0, ?, ?, ?, ?, ?)`,
      id,
      orderNumber(ctx),
      member?.student_number || null,
      payload.m,
      member?.kind || 'student',
      member?.name || payload.m,
      member?.phone || '',
      total,
      actor.tillId,
      actor.id,
      now,
      now,
    );
    insertItems(ctx, id, lines);
    settlePaid(ctx, id, { method: 'wallet', staff: actor, tillId: actor.tillId });
  });
  return { order: presentOrder(ctx, one(ctx.db, 'SELECT * FROM orders WHERE id = ?', id)), wallet: walletView(ctx, payload.m) };
}

function reverseSale(ctx, order, action, actor, reason) {
  const items = orderItems(ctx, order.id);
  const cost = items.reduce((sum, item) => sum + item.unit_cost_cents * item.qty, 0);
  const method = order.payment_method;
  const credit = method === 'wallet'
    ? walletAccount(order.member_number)
    : method === 'cash'
      ? `asset:cash:${order.till_id || 'unassigned'}`
      : 'asset:yoco_clearing';
  const lines = [
    { account: incomeAccount(method), debitCents: order.total_cents },
    { account: credit, creditCents: order.total_cents },
  ];
  if (cost) {
    lines.push({ account: 'asset:inventory', debitCents: cost });
    lines.push({ account: 'expense:cogs', creditCents: cost });
  }
  postJournal(ctx.db, {
    entityId: order.entity_id,
    memo: `${action} ${order.order_number}`,
    refType: 'refund',
    refId: order.id,
    lines,
    now: ctx.now().toISOString(),
  });
  restoreStock(ctx, order.id);
  run(
    ctx.db,
    `UPDATE orders SET payment_status = 'refunded', fulfillment = ?, updated_at = ? WHERE id = ?`,
    action === 'void' ? 'voided' : 'refunded',
    ctx.now().toISOString(),
    order.id,
  );
  audit(ctx, actor, action, 'order', order.id, reason);
}

export function refundOrder(ctx, actor, orderId, reason) {
  if (!can(actor, 'refund') && !can(actor, 'refund_own')) throw new HttpError(403, 'Your role cannot refund.');
  if (!reason || String(reason).trim().length < 3) throw new HttpError(400, 'A refund reason is required.');
  const order = one(ctx.db, 'SELECT * FROM orders WHERE id = ? AND entity_id = ?', orderId, actor.entity);
  if (!order) throw new HttpError(404, 'Order not found.');
  if (actor.role === 'cashier' && order.till_id !== actor.tillId) throw new HttpError(403, 'You can only refund your own till.');
  if (order.payment_status !== 'paid') throw new HttpError(409, 'Only a paid order can be refunded.');
  transaction(ctx.db, () => reverseSale(ctx, order, 'refund', actor, String(reason).trim()));
  return presentOrder(ctx, one(ctx.db, 'SELECT * FROM orders WHERE id = ?', order.id));
}

export function voidOrder(ctx, actor, orderId, reason) {
  if (!can(actor, 'void') && !can(actor, 'void_own')) throw new HttpError(403, 'Your role cannot void.');
  if (!reason || String(reason).trim().length < 3) throw new HttpError(400, 'A void reason is required.');
  const order = one(ctx.db, 'SELECT * FROM orders WHERE id = ? AND entity_id = ?', orderId, actor.entity);
  if (!order) throw new HttpError(404, 'Order not found.');
  if (actor.role === 'cashier' && order.till_id && order.till_id !== actor.tillId) {
    throw new HttpError(403, 'You can only void your own till.');
  }
  if (['refunded', 'voided', 'collected'].includes(order.fulfillment) && order.payment_status !== 'paid') {
    throw new HttpError(409, 'This order cannot be voided.');
  }
  transaction(ctx.db, () => {
    if (order.payment_status === 'paid') reverseSale(ctx, order, 'void', actor, String(reason).trim());
    else {
      run(ctx.db, `UPDATE orders SET fulfillment = 'voided', updated_at = ? WHERE id = ?`, ctx.now().toISOString(), order.id);
      audit(ctx, actor, 'void', 'order', order.id, String(reason).trim());
    }
  });
  return presentOrder(ctx, one(ctx.db, 'SELECT * FROM orders WHERE id = ?', order.id));
}

export async function applySignedWebhook(ctx, raw, headers) {
  if (!verifyStandardWebhook(raw, headers, ctx.config.yocoWebhookSecret, ctx.now().getTime())) {
    throw new HttpError(401, 'Webhook signature is not valid.');
  }
  const event = JSON.parse(raw);
  const webhookId = headers['webhook-id'];
  if (one(ctx.db, 'SELECT id FROM webhook_receipts WHERE id = ?', webhookId)) return { duplicate: true };
  const intentId = event?.data?.metadata?.intentId;
  const intent = one(ctx.db, 'SELECT * FROM payment_intents WHERE id = ?', intentId);
  if (!intent) throw new HttpError(404, 'Payment intent not found.');
  if (Number(event?.data?.amount) !== Number(intent.amount_cents)) {
    throw new HttpError(400, 'Webhook amount does not match the payment.');
  }
  run(ctx.db, 'INSERT INTO webhook_receipts (id, received_at) VALUES (?, ?)', webhookId, ctx.now().toISOString());
  const succeeded = event.type === 'payment.succeeded';
  if (!succeeded) {
    run(ctx.db, `UPDATE payment_intents SET status = 'failed', updated_at = ? WHERE id = ?`, ctx.now().toISOString(), intent.id);
    if (intent.order_id) {
      run(
        ctx.db,
        `UPDATE orders SET payment_status = 'failed', fulfillment = 'failed', kitchen_visible = 0, updated_at = ? WHERE id = ? AND payment_status != 'paid'`,
        ctx.now().toISOString(),
        intent.order_id,
      );
    }
    return { ok: true, status: 'failed' };
  }
  if (intent.status === 'succeeded') return { duplicate: true };
  transaction(ctx.db, () => {
    if (intent.purpose === 'wallet_topup') {
      postJournal(ctx.db, {
        entityId: intent.entity_id,
        memo: `Yoco wallet top-up ${intent.student_number}`,
        refType: 'wallet_topup',
        refId: intent.id,
        now: ctx.now().toISOString(),
        lines: [
          { account: 'asset:yoco_clearing', debitCents: intent.amount_cents },
          { account: walletAccount(intent.student_number), creditCents: intent.amount_cents },
        ],
      });
    } else if (intent.purpose === 'food_order' && intent.order_id) {
      const payMethod = intent.method === 'softpos_link' ? 'softpos' : 'yoco';
      settlePaid(ctx, intent.order_id, { method: payMethod, yocoReference: event?.data?.id || null });
    } else {
      postJournal(ctx.db, {
        entityId: intent.entity_id,
        memo: `${intent.purpose} ${intent.reference}`,
        refType: intent.purpose,
        refId: intent.id,
        now: ctx.now().toISOString(),
        lines: [
          { account: 'asset:yoco_clearing', debitCents: intent.amount_cents },
          { account: `income:${intent.purpose}`, creditCents: intent.amount_cents },
        ],
      });
    }
    run(
      ctx.db,
      `UPDATE payment_intents SET status = 'succeeded', yoco_reference = ?, updated_at = ? WHERE id = ?`,
      event?.data?.id || null,
      ctx.now().toISOString(),
      intent.id,
    );
  });
  if (intent.purpose === 'food_order' && intent.order_id) {
    const order = one(ctx.db, 'SELECT * FROM orders WHERE id = ?', intent.order_id);
    await notifyPeople(ctx, order, 'order_received', ['customer', 'kitchen', 'till']);
    await notifyPeople(ctx, order, 'payment_received', ['customer']);
  }
  if (intent.purpose === 'wallet_topup') {
    const user = one(ctx.db, 'SELECT * FROM users WHERE student_number = ? OR staff_number = ?', intent.student_number, intent.student_number);
    await recordMessage(ctx, {
      entityId: intent.entity_id,
      userId: user?.id || null,
      audience: 'customer',
      channel: 'whatsapp',
      event: 'wallet_topup',
      to: user?.phone || '',
      body: `Food wallet top-up received: ${formatZAR(intent.amount_cents)}.`,
    });
  }
  return { ok: true, status: 'succeeded', intentId: intent.id };
}

export function signedWebhook(ctx, payload) {
  const raw = JSON.stringify(payload);
  return signStandardWebhook(raw, ctx.config.yocoWebhookSecret, { timestamp: Math.floor(ctx.now().getTime() / 1000) });
}

export function posQueue(ctx, actor) {
  assertCan(actor, actor.role === 'finance' ? 'reports' : 'pos');
  expireCashOrders(ctx);
  const rows = all(
    ctx.db,
    `SELECT * FROM orders WHERE entity_id = ? AND fulfillment IN ('cash_pending', 'paid', 'preparing', 'ready')
     ORDER BY created_at ASC`,
    actor.entity,
  );
  return rows.map((order) => presentOrder(ctx, order));
}

export function kitchenOrders(ctx, actor) {
  assertCan(actor, 'kitchen');
  expireCashOrders(ctx);
  const rows = all(
    ctx.db,
    `SELECT * FROM orders WHERE entity_id = ? AND kitchen_visible = 1 AND fulfillment IN ('cash_pending', 'paid', 'preparing', 'ready')
     ORDER BY created_at ASC`,
    actor.entity,
  );
  return rows.map((order) => presentOrder(ctx, order));
}

export function salesReport(ctx, actor, range = 'day') {
  if (!can(actor, 'reports') && !can(actor, 'reports_ops') && !can(actor, 'cashup_own')) {
    throw new HttpError(403, 'Your role cannot see these figures.');
  }
  const from = periodStart(ctx.now(), range);
  const to = ctx.now().toISOString();
  const till = actor.role === 'cashier' ? actor.tillId : null;
  const params = [actor.entity, from, to];
  let tillSql = '';
  if (till) {
    tillSql = ' AND till_id = ?';
    params.push(till);
  }
  const orders = all(
    ctx.db,
    `SELECT * FROM orders WHERE entity_id = ? AND payment_status = 'paid' AND paid_at >= ? AND paid_at <= ?${tillSql}`,
    ...params,
  );
  const byMethod = {};
  const byStaff = {};
  const byItem = {};
  for (const order of orders) {
    byMethod[order.payment_method] = (byMethod[order.payment_method] || 0) + order.total_cents;
    const staffKey = order.paid_by_staff_id || order.created_by_staff_id || 'online';
    byStaff[staffKey] = (byStaff[staffKey] || 0) + order.total_cents;
    for (const item of orderItems(ctx, order.id)) {
      const bucket = byItem[item.item_id] || { itemId: item.item_id, name: item.name, qty: 0, totalCents: 0 };
      bucket.qty += item.qty;
      bucket.totalCents += item.line_total_cents;
      byItem[item.item_id] = bucket;
    }
  }
  return {
    range,
    from,
    to,
    tillId: till,
    salesCents: orders.reduce((sum, order) => sum + order.total_cents, 0),
    orderCount: orders.length,
    byMethod,
    byItem: Object.values(byItem),
    byStaff: Object.entries(byStaff).map(([staffId, totalCents]) => ({ staffId, totalCents })),
    orders: orders.map((order) => ({
      id: order.id,
      orderNumber: order.order_number,
      channel: order.channel,
      method: order.payment_method,
      totalCents: order.total_cents,
      paidAt: order.paid_at,
      tillId: order.till_id,
      staffId: order.paid_by_staff_id || order.created_by_staff_id,
    })),
  };
}

export function toCsv(report) {
  const header = 'paid_at,order_number,channel,method,total_cents,till_id,staff_id';
  const lines = report.orders.map((order) =>
    [order.paidAt, order.orderNumber, order.channel, order.method, order.totalCents, order.tillId || '', order.staffId || ''].join(','),
  );
  return [header, ...lines].join('\n');
}

export function pnlReport(ctx, actor, range = 'day') {
  assertCan(actor, 'pnl');
  const from = periodStart(ctx.now(), range);
  const to = new Date(ctx.now().getTime() + 1000).toISOString();
  const rows = all(
    ctx.db,
    `SELECT l.account, SUM(l.debit_cents) AS debit, SUM(l.credit_cents) AS credit
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE e.entity_id = ? AND e.created_at >= ? AND e.created_at <= ?
     GROUP BY l.account`,
    actor.entity,
    from,
    to,
  );
  let sales = 0;
  let cogs = 0;
  let expenses = 0;
  const byMethod = { yoco: 0, cash: 0, wallet: 0, softpos: 0 };
  for (const row of rows) {
    const netCredit = Number(row.credit) - Number(row.debit);
    const netDebit = Number(row.debit) - Number(row.credit);
    if (row.account.startsWith('income:food:')) {
      sales += netCredit;
      if (row.account.endsWith(':cash')) byMethod.cash += netCredit;
      else if (row.account.endsWith(':wallet')) byMethod.wallet += netCredit;
      else if (row.account.endsWith(':softpos')) byMethod.softpos += netCredit;
      else byMethod.yoco += netCredit;
    } else if (row.account === 'expense:cogs') cogs += netDebit;
    else if (row.account.startsWith('expense:operating')) expenses += netDebit;
  }
  return {
    range,
    salesCents: sales,
    cogsCents: cogs,
    expensesCents: expenses,
    profitCents: sales - cogs - expenses,
    byMethod,
    trial: trialBalance(ctx.db, actor.entity),
  };
}

export function cashupPreview(ctx, actor, tillId) {
  const till = actor.role === 'cashier' ? actor.tillId : tillId || actor.tillId || 'till-1';
  if (actor.role === 'cashier' && till !== actor.tillId) throw new HttpError(403, 'You can only see your own till.');
  if (!can(actor, 'cashup_own') && !can(actor, 'cashup_all')) throw new HttpError(403, 'Your role cannot cash up.');
  const from = dayStart(ctx.now());
  const account = `asset:cash:${till}`;
  const row = one(
    ctx.db,
    `SELECT COALESCE(SUM(l.debit_cents), 0) AS debit, COALESCE(SUM(l.credit_cents), 0) AS credit
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account = ? AND e.entity_id = ? AND e.created_at >= ?`,
    account,
    actor.entity,
    from,
  );
  const movement = Number(row?.debit || 0) - Number(row?.credit || 0);
  return { tillId: till, businessDate: from.slice(0, 10), openingCents: 0, cashSalesCents: movement, expectedCents: movement };
}

export function closeCashup(ctx, actor, input) {
  const preview = cashupPreview(ctx, actor, input?.tillId);
  const counted = Math.round(Number(input?.countedCents));
  if (!Number.isFinite(counted) || counted < 0) throw new HttpError(400, 'Enter the counted cash.');
  const id = randomId();
  run(
    ctx.db,
    `INSERT INTO cashups (
      id, entity_id, till_id, staff_id, business_date, opening_cents, cash_sales_cents, expected_cents, counted_cents, variance_cents, notes, closed_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    id,
    actor.entity,
    preview.tillId,
    actor.id,
    preview.businessDate,
    preview.cashSalesCents,
    preview.expectedCents,
    counted,
    counted - preview.expectedCents,
    String(input?.notes || '').slice(0, 240),
    ctx.now().toISOString(),
  );
  return one(ctx.db, 'SELECT * FROM cashups WHERE id = ?', id);
}

export function updatePrice(ctx, actor, itemId, priceCents) {
  assertCan(actor, 'price');
  const item = one(ctx.db, 'SELECT * FROM menu_items WHERE id = ? AND entity_id = ?', itemId, actor.entity);
  if (!item) throw new HttpError(404, 'Item not found.');
  const next = Math.round(Number(priceCents));
  if (next < 0) throw new HttpError(400, 'Price cannot be negative.');
  run(ctx.db, 'UPDATE menu_items SET price_cents = ? WHERE id = ?', next, item.id);
  audit(ctx, actor, 'price_change', 'menu_item', item.id, null, { from: item.price_cents, to: next });
  return one(ctx.db, 'SELECT * FROM menu_items WHERE id = ?', item.id);
}

export function importDirectory(ctx, actor, kind, csv) {
  assertCan(actor, 'directory');
  const lines = String(csv || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const [header, ...rows] = lines;
  if (!header) throw new HttpError(400, 'CSV is empty.');
  let added = 0;
  for (const row of rows) {
    const cells = row.split(',').map((cell) => cell.trim());
    if (kind === 'students') {
      const [studentNumber, fullName, phone] = cells;
      if (!studentNumber || !fullName) continue;
      run(
        ctx.db,
        `INSERT INTO student_registry (student_number, full_name, phone, active) VALUES (?, ?, ?, 1)
         ON CONFLICT(student_number) DO UPDATE SET full_name = excluded.full_name, phone = excluded.phone, active = 1`,
        studentNumber.toUpperCase(),
        fullName,
        phone || null,
      );
      if (!walletRow(ctx, studentNumber.toUpperCase())) {
        run(
          ctx.db,
          `INSERT INTO wallet_accounts (id, entity_id, member_number, member_kind, daily_limit_cents, monthly_limit_cents, low_balance_cents, daily_allowance_enabled)
           VALUES (?, 'food-court', ?, 'student', 30000, 200000, 5000, 0)`,
          randomId(),
          studentNumber.toUpperCase(),
        );
      }
      added += 1;
    } else {
      const [staffNumber, fullName, phone, title, salary] = cells;
      if (!staffNumber || !fullName) continue;
      run(
        ctx.db,
        `INSERT INTO staff_registry (staff_number, full_name, phone, title, monthly_salary_cents, active)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(staff_number) DO UPDATE SET full_name = excluded.full_name, phone = excluded.phone, title = excluded.title, active = 1`,
        staffNumber.toUpperCase(),
        fullName,
        phone || null,
        title || 'Staff',
        salary ? Math.round(Number(salary)) : null,
      );
      added += 1;
    }
  }
  audit(ctx, actor, 'directory_import', kind, null, null, { added });
  return { added };
}

export function createSupplier(ctx, actor, input) {
  assertCan(actor, 'purchase');
  const id = randomId();
  run(
    ctx.db,
    'INSERT INTO suppliers (id, entity_id, name, contact, phone) VALUES (?, ?, ?, ?, ?)',
    id,
    actor.entity,
    String(input.name || '').trim(),
    input.contact || '',
    input.phone || '',
  );
  return one(ctx.db, 'SELECT * FROM suppliers WHERE id = ?', id);
}

export function createPurchaseOrder(ctx, actor, input) {
  assertCan(actor, 'purchase');
  const id = randomId();
  const now = ctx.now().toISOString();
  transaction(ctx.db, () => {
    run(
      ctx.db,
      `INSERT INTO purchase_orders (id, entity_id, supplier_id, status, created_by, created_at) VALUES (?, ?, ?, 'ordered', ?, ?)`,
      id,
      actor.entity,
      input.supplierId,
      actor.id,
      now,
    );
    for (const line of input.lines || []) {
      run(
        ctx.db,
        `INSERT INTO purchase_lines (id, po_id, item_id, description, qty, unit_cost_cents) VALUES (?, ?, ?, ?, ?, ?)`,
        randomId(),
        id,
        line.itemId || null,
        line.description || '',
        Math.round(Number(line.qty)),
        Math.round(Number(line.unitCostCents)),
      );
    }
  });
  return one(ctx.db, 'SELECT * FROM purchase_orders WHERE id = ?', id);
}

export function receivePurchaseOrder(ctx, actor, id) {
  assertCan(actor, 'purchase');
  const po = one(ctx.db, 'SELECT * FROM purchase_orders WHERE id = ? AND entity_id = ?', id, actor.entity);
  if (!po) throw new HttpError(404, 'Purchase order not found.');
  if (po.status === 'received') throw new HttpError(409, 'Already received.');
  const lines = all(ctx.db, 'SELECT * FROM purchase_lines WHERE po_id = ?', id);
  const total = lines.reduce((sum, line) => sum + line.qty * line.unit_cost_cents, 0);
  transaction(ctx.db, () => {
    for (const line of lines) {
      if (!line.item_id) continue;
      run(
        ctx.db,
        'UPDATE menu_items SET stock_qty = stock_qty + ?, cost_cents = ? WHERE id = ?',
        line.qty,
        line.unit_cost_cents,
        line.item_id,
      );
    }
    postJournal(ctx.db, {
      entityId: po.entity_id,
      memo: `Receive PO ${po.id}`,
      refType: 'purchase',
      refId: po.id,
      now: ctx.now().toISOString(),
      lines: [
        { account: 'asset:inventory', debitCents: total },
        { account: 'liability:accounts_payable', creditCents: total },
      ],
    });
    run(ctx.db, `UPDATE purchase_orders SET status = 'received', received_at = ? WHERE id = ?`, ctx.now().toISOString(), po.id);
  });
  return one(ctx.db, 'SELECT * FROM purchase_orders WHERE id = ?', po.id);
}

export function createExpense(ctx, actor, input, receiptPath) {
  if (!can(actor, 'expense') && !can(actor, 'expense_view')) throw new HttpError(403, 'Your role cannot capture expenses.');
  const amount = Math.round(Number(input.amountCents));
  if (!input.category || amount < 1) throw new HttpError(400, 'Category and amount are required.');
  const id = randomId();
  run(
    ctx.db,
    `INSERT INTO expenses (id, entity_id, category, amount_cents, note, receipt_path, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    id,
    actor.entity,
    String(input.category).slice(0, 60),
    amount,
    String(input.note || '').slice(0, 240),
    receiptPath || null,
    actor.id,
    ctx.now().toISOString(),
  );
  return one(ctx.db, 'SELECT * FROM expenses WHERE id = ?', id);
}

export function decideExpense(ctx, actor, id, decision) {
  assertCan(actor, 'expense_approve');
  const expense = one(ctx.db, 'SELECT * FROM expenses WHERE id = ? AND entity_id = ?', id, actor.entity);
  if (!expense) throw new HttpError(404, 'Expense not found.');
  if (expense.status !== 'pending') throw new HttpError(409, 'Expense is already decided.');
  if (decision === 'rejected') {
    run(
      ctx.db,
      `UPDATE expenses SET status = 'rejected', approved_by = ?, decided_at = ? WHERE id = ?`,
      actor.id,
      ctx.now().toISOString(),
      id,
    );
    return one(ctx.db, 'SELECT * FROM expenses WHERE id = ?', id);
  }
  transaction(ctx.db, () => {
    postJournal(ctx.db, {
      entityId: expense.entity_id,
      memo: `Expense ${expense.category}`,
      refType: 'expense',
      refId: expense.id,
      now: ctx.now().toISOString(),
      lines: [
        { account: `expense:operating:${expense.category}`, debitCents: expense.amount_cents },
        { account: 'asset:cash:operations', creditCents: expense.amount_cents },
      ],
    });
    run(
      ctx.db,
      `UPDATE expenses SET status = 'approved', approved_by = ?, decided_at = ? WHERE id = ?`,
      actor.id,
      ctx.now().toISOString(),
      id,
    );
  });
  audit(ctx, actor, 'expense_approve', 'expense', id, expense.category);
  return one(ctx.db, 'SELECT * FROM expenses WHERE id = ?', id);
}

export function recordSoftposReference(ctx, actor, intentId, yocoReference) {
  assertCan(actor, 'pos');
  const ref = String(yocoReference || '').trim();
  if (ref.length < 3) throw new HttpError(400, 'Enter the Yoco reference from the tap-to-phone payment.');
  const intent = one(ctx.db, 'SELECT * FROM payment_intents WHERE id = ? AND entity_id = ?', intentId, actor.entity);
  if (!intent) throw new HttpError(404, 'Payment not found.');
  if (one(ctx.db, 'SELECT id FROM payment_intents WHERE yoco_reference = ? AND id != ?', ref, intent.id)) {
    throw new HttpError(409, 'That Yoco reference is already reconciled.');
  }
  transaction(ctx.db, () => {
    if (intent.order_id) settlePaid(ctx, intent.order_id, { method: 'softpos', staff: actor, tillId: actor.tillId, yocoReference: ref });
    run(
      ctx.db,
      `UPDATE payment_intents SET status = 'succeeded', yoco_reference = ?, updated_at = ? WHERE id = ?`,
      ref,
      ctx.now().toISOString(),
      intent.id,
    );
  });
  audit(ctx, actor, 'softpos_reconcile', 'payment_intent', intent.id, ref);
  return presentIntent(ctx, one(ctx.db, 'SELECT * FROM payment_intents WHERE id = ?', intent.id));
}

export function reconciliation(ctx, actor) {
  assertCan(actor, 'pnl');
  const rows = all(
    ctx.db,
    `SELECT * FROM payment_intents WHERE entity_id = ? AND method IN ('softpos_link', 'softpos_reference', 'yoco_card', 'yoco_eft', 'cash')
     ORDER BY created_at DESC LIMIT 200`,
    actor.entity,
  );
  return rows.map((row) => ({
    ...presentIntent(ctx, row),
    reconciled: row.status === 'succeeded' && (row.method === 'cash' || Boolean(row.yoco_reference) || row.method.startsWith('yoco')),
  }));
}

export function openEntityWallet(ctx, actor, input) {
  if (actor.role !== 'owner' && actor.role !== 'finance' && actor.role !== 'manager') {
    throw new HttpError(403, 'Your role cannot open wallets for an entity.');
  }
  const entityId = input.entityId || actor.entity;
  if (actor.role !== 'owner' && entityId !== actor.entity) throw new HttpError(403, 'Stay inside your active entity.');
  const memberNumber = String(input.memberNumber || '').trim().toUpperCase();
  if (!memberNumber) throw new HttpError(400, 'A member number is required.');
  const existing = walletRow(ctx, memberNumber, entityId);
  if (existing) return walletView(ctx, memberNumber, entityId);
  run(
    ctx.db,
    `INSERT INTO wallet_accounts (
      id, entity_id, member_number, member_kind, daily_limit_cents, monthly_limit_cents, low_balance_cents, daily_allowance_enabled
    ) VALUES (?, ?, ?, ?, 50000, 200000, 5000, 0)`,
    randomId(),
    entityId,
    memberNumber,
    input.memberKind || 'student',
  );
  return walletView(ctx, memberNumber, entityId);
}

export async function allowanceReminders(ctx) {
  const month = ctx.now().toISOString().slice(0, 7);
  const day = partsInTZ(ctx.now()).day;
  const rows = all(
    ctx.db,
    `SELECT * FROM wallet_accounts WHERE allowance_cents IS NOT NULL AND allowance_day IS NOT NULL AND (last_allowance_reminder IS NULL OR last_allowance_reminder != ?)`,
    month,
  );
  for (const row of rows) {
    if (day < row.allowance_day) continue;
    const topped = one(
      ctx.db,
      `SELECT e.id FROM journal_entries e
       JOIN journal_lines l ON l.entry_id = e.id
       WHERE e.ref_type = 'wallet_topup' AND l.account = ? AND e.created_at >= ?`,
      walletAccount(row.member_number),
      monthStart(ctx.now()),
    );
    if (topped) continue;
    const parent = one(ctx.db, `SELECT * FROM users WHERE kind = 'parent' AND linked_student_number = ?`, row.member_number);
    if (!parent) continue;
    await recordMessage(ctx, {
      entityId: row.entity_id,
      userId: parent.id,
      audience: 'parent',
      channel: 'whatsapp',
      event: 'allowance_reminder',
      to: parent.phone,
      body: `Reminder: ${formatZAR(row.allowance_cents)} monthly food allowance for ${row.member_number} has not been topped up.`,
    });
    run(ctx.db, 'UPDATE wallet_accounts SET last_allowance_reminder = ? WHERE id = ?', month, row.id);
  }
}

export function patchSettings(ctx, actor, input) {
  assertCan(actor, 'settings');
  const current = settingsOf(ctx, actor.entity);
  const kitchen = input.kitchenStarts === 'on_order' ? 'on_order' : input.kitchenStarts === 'after_cash' ? 'after_cash' : current.kitchen_starts;
  run(
    ctx.db,
    `UPDATE settings SET kitchen_starts = ?, cash_expire_minutes = ?, unpaid_cash_cap = ?, order_rate_per_10_min = ?, low_balance_cents = ? WHERE entity_id = ?`,
    kitchen,
    input.cashExpireMinutes != null ? Math.round(Number(input.cashExpireMinutes)) : current.cash_expire_minutes,
    input.unpaidCashCap != null ? Math.round(Number(input.unpaidCashCap)) : current.unpaid_cash_cap,
    input.orderRatePer10Min != null ? Math.round(Number(input.orderRatePer10Min)) : current.order_rate_per_10_min,
    input.lowBalanceCents != null ? Math.round(Number(input.lowBalanceCents)) : current.low_balance_cents,
    actor.entity,
  );
  return settingsOf(ctx, actor.entity);
}

export function crmSync(ctx, actor, payload) {
  assertCan(actor, 'directory');
  const id = randomId();
  run(
    ctx.db,
    'INSERT INTO crm_inbox (id, payload_json, created_at) VALUES (?, ?, ?)',
    id,
    JSON.stringify(payload || {}),
    ctx.now().toISOString(),
  );
  return {
    id,
    mode: ctx.config.crmSyncUrl && !String(ctx.config.crmSyncUrl).includes('PLACEHOLDER') ? 'forward' : 'hook-ready',
    note: 'CRM sync URL is a placeholder. The payload is stored for a later EASTC CRM connection.',
  };
}

export { listOutbox, audit as writeAudit };
