import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { getMenu as staticMenu } from '../../../js/data/menu.js';
import { getPickupSlots } from '../../../js/lib/hours.js';
import { normalizeSaPhone } from '../../../js/lib/phone.js';
import { buildOrder, formatKitchenWhatsApp, pinMatches } from '../../../js/api/orderService.js';
import { mergeSettings, resolveDestinations } from '../../../js/domain/settings.js';
import { annotateSlots, assertSlotOpen } from '../../../js/domain/slots.js';
import { loyaltyLabel, quoteLoyalty } from '../../../js/domain/loyalty.js';
import { makePayToken, parsePayPayload } from '../../../js/domain/wallet.js';
import { resolveTodaySpecial, parseSpecialCaption, extractInboundMessages } from '../../../js/domain/specials.js';
import { createCheckout, fetchProviderPayments, refundCard, selectPaymentProvider } from '../../../js/domain/payments.js';
import {
  formatLowBalanceWhatsApp,
  formatRatingAlert,
  formatReadyWhatsApp,
  formatSpecialLive,
  formatSpecialRejected,
  metaVerify,
  numberAllowed,
  sendWhatsApp,
  whatsappConfigured,
} from '../../../js/domain/notify.js';
import { emailConfigured, sendEmail } from '../../../js/domain/email.js';
import { buildFinanceReport, financeToCsv } from '../../../js/domain/reports.js';
import { prepForecast } from '../../../js/domain/forecast.js';
import { reorderSuggestions, stockValueCents } from '../../../js/domain/stock.js';
import {
  SCHEDULED_JOBS,
  planChefNudge,
  planEndOfDay,
  planForecast,
  planLowBalance,
  planNoShows,
  planReconcile,
  planSpecialDeadline,
  planStockAlerts,
} from '../../../js/domain/automations.js';
import { sastDate } from '../../../js/domain/dates.js';

const ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'STAFF_PIN',
  'STAFF_TILL_PIN',
  'CHEF_PIN',
  'YOCO_SECRET_KEY',
  'YOCO_WEBHOOK_SECRET',
  'PAYFAST_MERCHANT_ID',
  'PAYFAST_MERCHANT_KEY',
  'PAYFAST_PASSPHRASE',
  'PAYFAST_SANDBOX',
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_VERIFY_TOKEN',
  'KITCHEN_WHATSAPP',
  'MANAGER_WHATSAPP',
  'CHEF_WHATSAPP_ALLOWLIST',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_FROM',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'MANAGER_EMAIL',
  'REPORTS_EMAIL',
  'CRON_SECRET',
  'APP_BASE_URL',
];

function readEnv() {
  const env = {};
  for (const key of ENV_KEYS) env[key] = Deno.env.get(key) || '';
  if (!env.APP_BASE_URL) env.APP_BASE_URL = 'https://thefood-court.co.za';
  return env;
}

function client(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function cors(origin) {
  const allowed =
    !origin ||
    origin === 'https://thefood-court.co.za' ||
    origin === 'https://www.thefood-court.co.za' ||
    /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin || 'https://thefood-court.co.za' : 'https://thefood-court.co.za',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-staff-pin, x-chef-pin, x-cron-secret',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS',
    Vary: 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body ?? null), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors(origin) },
  });
}

function fail(error) {
  const message = String(error?.message || error || 'Something went wrong. Please try again.');
  const status = error?.status || (/wrong pin/i.test(message) ? 401 : /not found/i.test(message) ? 404 : 400);
  const err = new Error(message.replace(/^.*?(Insufficient wallet balance\.)/, '$1'));
  err.status = status;
  return err;
}

function must(result) {
  if (result?.error) throw fail(result.error);
  return result?.data;
}

function staffRole(env, pin) {
  if (env.STAFF_PIN && pinMatches(pin, env.STAFF_PIN)) return 'manager';
  if (env.STAFF_TILL_PIN && pinMatches(pin, env.STAFF_TILL_PIN)) return 'till';
  return null;
}

function assertStaff(env, pin, { manager = false } = {}) {
  const role = staffRole(env, pin);
  if (!role) throw fail(Object.assign(new Error('Wrong PIN.'), { status: 401 }));
  if (manager && role !== 'manager') throw fail(new Error('Manager PIN required.'));
  return role;
}

function assertChef(env, pin) {
  if (!env.CHEF_PIN || !pinMatches(pin, env.CHEF_PIN)) {
    throw fail(Object.assign(new Error('Wrong PIN.'), { status: 401 }));
  }
}

function pinOf(request, body) {
  return request.headers.get('x-staff-pin') || body?.pin || '';
}

function authEmail(studentNumber) {
  return `${String(studentNumber).trim()}@wallet.thefood-court.local`;
}

async function mintSession(db, email) {
  const link = await db.auth.admin.generateLink({ type: 'magiclink', email });
  if (link.error) throw fail(link.error);
  const verified = await db.auth.verifyOtp({
    type: 'email',
    token_hash: link.data?.properties?.hashed_token,
  });
  if (verified.error) throw fail(verified.error);
  return verified.data?.session || null;
}

async function userId(db, request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token || token === env.SUPABASE_ANON_KEY) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

function mapMenu(row) {
  return {
    id: row.id,
    category: row.category,
    name: row.name,
    description: row.description,
    priceCents: row.price_cents,
    image: row.image,
    popular: row.popular,
    availableDays: row.available_days?.length ? row.available_days : undefined,
    specialOn: row.special_on?.length ? row.special_on : undefined,
    badge: row.badge || undefined,
    soldOut: row.sold_out,
    portions: row.portions,
  };
}

function mapItem(row) {
  return {
    itemId: row.item_id,
    name: row.name,
    qty: row.qty,
    unitPriceCents: row.unit_price_cents,
    lineTotalCents: row.line_total_cents,
    loyaltyFreeQty: row.loyalty_free_qty || 0,
  };
}

function mapOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderNumber: row.order_number,
    status: row.status,
    customerName: row.customer_name,
    phone: row.phone,
    pickupTime: row.pickup_time,
    pickupLabel: row.pickup_label,
    notes: row.notes || '',
    items: (row.order_items || []).map(mapItem),
    itemCount: row.item_count,
    totalCents: row.total_cents,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    payOnCollection: row.pay_on_collection,
    studentId: row.student_id,
    loyaltyRedeemed: row.loyalty_redeemed,
    discountCents: row.discount_cents || 0,
    reminderSentAt: row.reminder_sent_at,
    noShowActionTakenAt: row.no_show_action_taken_at,
    cancelReason: row.cancel_reason,
    provider: row.provider,
    demo: false,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStudent(row) {
  if (!row) return null;
  if (row.studentNumber) return row;
  return {
    id: row.id,
    studentNumber: row.student_number,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email || '',
    balanceCents: row.balance_cents,
    loyaltyStamps: row.loyalty_stamps,
    nfcUid: row.nfc_uid || '',
    autoTopup: row.auto_topup,
    autoTopupCents: row.auto_topup_cents,
    lowBalanceAlertedAt: row.low_balance_alerted_at,
    demo: false,
  };
}

function mapLedger(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    amountCents: row.amount_cents,
    balanceAfterCents: row.balance_after_cents,
    kind: row.kind,
    paymentMethod: row.payment_method,
    orderId: row.order_id,
    provider: row.provider,
    providerRef: row.provider_ref,
    note: row.note || '',
    createdAt: row.created_at,
    demo: false,
  };
}

function mapSpecial(row) {
  return {
    id: row.id,
    specialDate: row.special_date,
    name: row.name,
    priceCents: row.price_cents,
    dow: row.dow,
    dayLabel: row.day_label,
    caption: row.caption,
    imageUrl: row.image_url,
    source: row.source,
    status: row.status,
    itemId: row.item_id,
    demo: false,
    createdAt: row.created_at,
  };
}

function mapIngredient(row) {
  return {
    id: row.id,
    name: row.name,
    unit: row.unit,
    costCents: row.cost_cents,
    onHand: Number(row.on_hand),
    reorderLevel: Number(row.reorder_level),
    supplierId: row.supplier_id,
    demo: false,
  };
}

function mapWaste(row) {
  return {
    id: row.id,
    ingredientId: row.ingredient_id,
    name: row.name,
    qty: Number(row.qty),
    unit: row.unit,
    costCents: row.cost_cents,
    reason: row.reason,
    createdAt: row.created_at,
    demo: false,
  };
}

async function loadMenu(db) {
  const { data, error } = await db.from('menu_items').select('*').order('sort');
  if (error) throw fail(error);
  const rows = (data || []).map(mapMenu);
  return rows.length ? rows : staticMenu();
}

async function loadSettings(db, env) {
  const { data, error } = await db.from('app_settings').select('data').eq('id', 1).maybeSingle();
  if (error) throw fail(error);
  return resolveDestinations(mergeSettings(data?.data || {}), env);
}

async function loadOrders(db) {
  const { data, error } = await db.from('orders').select('*, order_items(*)').order('created_at', { ascending: false }).limit(2000);
  if (error) throw fail(error);
  return (data || []).map(mapOrder);
}

async function snapshot(db, env) {
  const [orders, studentsRes, ledgerRes, specialsRes, wasteRes, ingredientsRes, recipesRes, settings, paymentsRes] =
    await Promise.all([
      loadOrders(db),
      db.from('students').select('*'),
      db.from('wallet_ledger').select('*').order('created_at', { ascending: false }).limit(5000),
      db.from('daily_specials').select('*').order('special_date', { ascending: false }),
      db.from('waste_log').select('*').order('created_at', { ascending: false }),
      db.from('ingredients').select('*'),
      db.from('recipes').select('*'),
      loadSettings(db, env),
      db.from('payment_intents').select('*'),
    ]);
  for (const res of [studentsRes, ledgerRes, specialsRes, wasteRes, ingredientsRes, recipesRes, paymentsRes]) {
    if (res.error) throw fail(res.error);
  }
  return {
    orders,
    students: (studentsRes.data || []).map(mapStudent),
    ledger: (ledgerRes.data || []).map(mapLedger),
    specials: (specialsRes.data || []).map(mapSpecial),
    waste: (wasteRes.data || []).map(mapWaste),
    ingredients: (ingredientsRes.data || []).map(mapIngredient),
    recipes: (recipesRes.data || []).map((row) => ({
      menuItemId: row.menu_item_id,
      ingredientId: row.ingredient_id,
      qty: Number(row.qty),
    })),
    settings,
    payments: paymentsRes.data || [],
  };
}

async function logNotice(db, { job, status, detail, to = '', text = '', channel = 'whatsapp', sent = false, skipped = true, reason = '' }) {
  await db.from('automation_runs').insert({ job, status, detail: detail || (text ? `${reason} ${text}`.trim() : reason) });
  if (text) {
    await db.from('notifications').insert({
      job,
      channel,
      recipient: to,
      body: text,
      sent,
      skipped,
      reason,
    });
  }
}

async function notify(db, env, { job, to, text, channel = 'whatsapp' }) {
  const result = channel === 'email'
    ? await sendEmail({ env, to, subject: 'Food Court', text })
    : await sendWhatsApp({ env, to, text });
  const skipped = Boolean(result.skipped);
  await logNotice(db, {
    job,
    status: result.sent ? 'sent' : skipped ? 'skipped' : 'error',
    to,
    text,
    channel,
    sent: Boolean(result.sent),
    skipped,
    reason: result.reason || result.error || '',
    detail: result.sent ? text : `${result.reason || result.error || 'not sent'}. ${text}`,
  });
  return result;
}

function portionsOf(menu) {
  const portions = {};
  const soldOut = {};
  for (const item of menu) {
    if (item.portions != null) portions[item.id] = Number(item.portions);
    if (item.soldOut) soldOut[item.id] = true;
  }
  return { portions, soldOut };
}

async function rememberPayment(db, payment, extra = {}) {
  if (!payment) return;
  await db.from('payment_intents').upsert({
    id: payment.reference,
    provider: payment.provider,
    reference: payment.reference,
    amount_cents: payment.amountCents,
    status: payment.status,
    kind: payment.kind,
    order_id: extra.orderId || null,
    student_id: extra.studentId || null,
    checkout_id: payment.checkoutId || null,
    provider_ref: payment.checkoutId || payment.reference,
  });
}

async function creditWallet(db, { studentId, amountCents, kind, method, orderId, provider, providerRef, note }) {
  const data = must(await db.rpc('wallet_credit', {
    p_student: studentId,
    p_amount: amountCents,
    p_kind: kind,
    p_method: method,
    p_order: orderId || '',
    p_provider: provider || '',
    p_ref: providerRef || '',
    p_note: note || '',
  }));
  return data;
}

export async function handleApi(request) {
  const env = readEnv();
  const origin = request.headers.get('origin');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/functions\/v1\/api/, '').replace(/^\/api/, '') || '/';
    const body = ['POST', 'PUT', 'PATCH'].includes(request.method) ? await request.json().catch(() => ({})) : {};
    const db = client(env);
    const result = await route({ db, env, request, path, body, url });
    if (result === undefined) return json({ error: 'Not found.' }, 404, origin);
    return json(result, 200, origin);
  } catch (error) {
    const wrapped = error?.status ? error : fail(error);
    return json({ error: wrapped.message }, wrapped.status || 400, origin);
  }
}

async function route({ db, env, request, path, body, url }) {
  const menu = await loadMenu(db);
  const itemById = new Map(menu.map((item) => [item.id, item]));
  const getItem = (id) => itemById.get(id) || null;

  if (request.method === 'GET' && path === '/menu') return menu;
  if (request.method === 'GET' && path === '/board') return board(db, menu);
  if (request.method === 'GET' && path === '/slots') return slots(db);
  if (request.method === 'GET' && path === '/specials') return specials(db, menu);
  if (request.method === 'GET' && path === '/counter') return counter(db);

  if (request.method === 'POST' && path === '/orders') return placeOrder({ db, env, body, menu, getItem, request });
  const orderMatch = path.match(/^\/orders\/([^/]+)$/);
  if (request.method === 'GET' && orderMatch) {
    const order = await oneOrder(db, decodeURIComponent(orderMatch[1]));
    if (!order) {
      const err = new Error('Order not found.');
      err.status = 404;
      throw err;
    }
    return order;
  }
  const rateMatch = path.match(/^\/orders\/([^/]+)\/rating$/);
  if (request.method === 'POST' && rateMatch) {
    return rate({ db, env, id: decodeURIComponent(rateMatch[1]), score: body.score });
  }

  if (request.method === 'POST' && path === '/kitchen/login') {
    const role = assertStaff(env, pinOf(request, body));
    return {
      ok: true,
      role,
      whatsapp: whatsappConfigured(env),
      payments: selectPaymentProvider(env),
      email: emailConfigured(env),
      demo: false,
    };
  }
  if (request.method === 'GET' && path === '/kitchen/orders') return kitchenOrders(db, env, pinOf(request, body), menu);
  const statusMatch = path.match(/^\/kitchen\/orders\/([^/]+)$/);
  if (request.method === 'PATCH' && statusMatch) {
    assertStaff(env, pinOf(request, body));
    const updated = must(await db.rpc('set_order_status', { p_id: decodeURIComponent(statusMatch[1]), p_status: body.status }));
    if (!updated) {
      const err = new Error('Order not found.');
      err.status = 404;
      throw err;
    }
    if (updated.status === 'ready') await notify(db, env, { job: 'order-ready', to: updated.phone, text: formatReadyWhatsApp(updated) });
    return updated;
  }
  const cancelMatch = path.match(/^\/kitchen\/orders\/([^/]+)\/cancel$/);
  if (request.method === 'POST' && cancelMatch) {
    assertStaff(env, pinOf(request, body));
    const updated = must(await db.rpc('cancel_order', {
      p_id: decodeURIComponent(cancelMatch[1]),
      p_reason: 'kitchen',
      p_payment_status: 'refunded',
    }));
    if (updated?.provider === 'yoco') {
      const intent = await db.from('payment_intents').select('checkout_id, amount_cents, provider').eq('order_id', updated.id).maybeSingle();
      if (intent.data?.checkout_id) {
        await refundCard({ env, provider: 'yoco', checkoutId: intent.data.checkout_id, amountCents: updated.totalCents });
      }
    }
    return updated;
  }
  if (request.method === 'POST' && path === '/kitchen/soldout') {
    assertStaff(env, pinOf(request, body));
    const { error } = await db.from('menu_items').update({ sold_out: Boolean(body.soldOut) }).eq('id', body.itemId);
    if (error) throw fail(error);
    return { itemId: body.itemId, soldOut: Boolean(body.soldOut) };
  }
  if (request.method === 'POST' && path === '/kitchen/portions') {
    assertStaff(env, pinOf(request, body));
    const qty = Math.max(0, Math.trunc(Number(body.portions)));
    if (!Number.isFinite(qty)) throw fail(new Error('Enter a portion count.'));
    const { error } = await db.from('menu_items').update({ portions: qty, sold_out: qty <= 0 }).eq('id', body.itemId);
    if (error) throw fail(error);
    return { itemId: body.itemId, portions: qty, soldOut: qty <= 0 };
  }
  if (request.method === 'POST' && path === '/till/charge') return till({ db, env, body, request });

  if (request.method === 'POST' && path === '/wallet/register') return register(db, body);
  if (request.method === 'POST' && path === '/wallet/login') return login(db, body);
  if (request.method === 'POST' && path === '/wallet/email-code') return emailCode(db, env, body);
  if (request.method === 'POST' && path === '/wallet/verify-email') return verifyEmail(db, body);
  if (request.method === 'GET' && path === '/wallet') return wallet(db, await userId(db, request, env));
  if (request.method === 'POST' && path === '/wallet/token') return rotateToken(db, await userId(db, request, env));
  if (request.method === 'POST' && path === '/wallet/topup') return topup(db, env, await userId(db, request, env), body);
  if (request.method === 'POST' && path === '/wallet/auto-topup') {
    const id = await userId(db, request, env);
    if (!id) throw fail(new Error('Sign in first.'));
    return must(await db.rpc('set_auto_topup', {
      p_student: id,
      p_enabled: Boolean(body.enabled),
      p_amount: body.amountCents ? Math.trunc(Number(body.amountCents)) : null,
    }));
  }
  if (request.method === 'POST' && path === '/wallet/nfc') return linkCard(db, env, request, body);

  if (request.method === 'POST' && path === '/chef/login') {
    assertChef(env, request.headers.get('x-chef-pin') || body.pin);
    return { ok: true, demo: false };
  }
  if (request.method === 'POST' && path === '/chef/specials') {
    assertChef(env, request.headers.get('x-chef-pin') || body.pin);
    return saveSpecial(db, env, body);
  }

  if (request.method === 'GET' && path === '/reports') return report(db, env, pinOf(request, body), url);
  if (request.method === 'GET' && path === '/stock') return stock(db, env, pinOf(request, body), menu);
  if (request.method === 'POST' && path === '/stock/receive') {
    assertStaff(env, pinOf(request, body), { manager: true });
    return must(await db.rpc('stock_receive', { p_id: body.ingredientId, p_qty: Number(body.qty), p_note: body.note || '' }));
  }
  if (request.method === 'POST' && path === '/stock/waste') {
    assertStaff(env, pinOf(request, body), { manager: true });
    return must(await db.rpc('stock_waste', { p_id: body.ingredientId, p_qty: Number(body.qty), p_reason: body.reason || '' }));
  }
  if (request.method === 'POST' && path === '/stock/take') {
    assertStaff(env, pinOf(request, body), { manager: true });
    return must(await db.rpc('stock_take', { p: { note: body.note || '', lines: body.lines || [] } }));
  }
  if (request.method === 'GET' && path === '/settings') return settingsPage(db, env, pinOf(request, body));
  if (request.method === 'PUT' && path === '/settings') {
    assertStaff(env, pinOf(request, body), { manager: true });
    const current = await loadSettings(db, {});
    const next = mergeSettings({ ...current, ...body });
    return must(await db.rpc('save_settings', { p: next }));
  }
  if (request.method === 'POST' && path === '/automations/run') {
    assertStaff(env, pinOf(request, body), { manager: true });
    return runJobs(db, env, body.job || 'all');
  }
  if (request.method === 'GET' && path === '/forecast') {
    assertStaff(env, pinOf(request, body));
    const rows = await forecastRows(db, menu);
    return { demo: false, rows };
  }
  return undefined;
}

async function board(db, menu) {
  const settings = await loadSettings(db, {});
  const { data, error } = await db.from('daily_specials').select('*').eq('status', 'live');
  if (error) throw fail(error);
  const { portions, soldOut } = portionsOf(menu);
  return {
    demo: false,
    demoLabel: '',
    soldOut,
    portions,
    specials: (data || []).map(mapSpecial),
    todaySpecial: resolveTodaySpecial({ specials: (data || []).map(mapSpecial), menuItems: menu }),
    settings: {
      slotCapacity: settings.slotCapacity,
      loyaltyTarget: settings.loyaltyTarget,
      lowBalanceCents: settings.lowBalanceCents,
    },
  };
}

async function slots(db) {
  const settings = await loadSettings(db, {});
  const { data, error } = await db.from('orders').select('pickup_time, status');
  if (error) throw fail(error);
  const orders = (data || []).map((row) => ({ pickupTime: row.pickup_time, status: row.status }));
  return annotateSlots(getPickupSlots(new Date()), orders, settings.slotCapacity);
}

async function oneOrder(db, id) {
  const { data, error } = await db.from('orders').select('*, order_items(*)').or(`id.eq.${id},order_number.eq.${id}`).maybeSingle();
  if (error) throw fail(error);
  return mapOrder(data);
}

async function placeOrder({ db, env, body, menu, getItem, request }) {
  const settings = await loadSettings(db, env);
  const now = new Date();
  const open = await slots(db);
  const studentSession = await userId(db, request, env);
  const order = buildOrder({ ...body, studentId: body.studentId || studentSession }, {
    getMenuItem: getItem,
    now,
    source: 'supabase',
    isSoldOut: (id) => {
      const item = getItem(id);
      return Boolean(item?.soldOut || (item?.portions != null && Number(item.portions) <= 0));
    },
  });
  assertSlotOpen(open, order.pickupTime);
  let student = null;
  if (order.studentId) {
    const { data, error } = await db.from('students').select('*').eq('id', order.studentId).maybeSingle();
    if (error) throw fail(error);
    student = mapStudent(data);
  }
  if (order.paymentMethod === 'wallet' && !student) throw fail(new Error('Sign in to your wallet to pay with credit.'));
  if (student) {
    const quote = quoteLoyalty({ stamps: student.loyaltyStamps, lines: order.items, target: settings.loyaltyTarget });
    order.items = quote.lines;
    order.totalCents = Math.max(0, order.totalCents - quote.discountCents);
    order.discountCents = quote.discountCents;
    order.loyaltyRedeemed = quote.redeem;
    order.loyaltyStampsAfter = quote.stampsAfter;
    order.studentId = student.id;
  }
  let payment = null;
  if (order.paymentMethod === 'wallet' || order.totalCents === 0) order.paymentStatus = 'paid';
  if (order.paymentMethod === 'card' && order.totalCents > 0) {
    payment = await createCheckout({
      env,
      amountCents: order.totalCents,
      reference: order.id,
      kind: 'order',
      itemName: order.orderNumber,
      successUrl: `${env.APP_BASE_URL}/order/${order.id}`,
      cancelUrl: `${env.APP_BASE_URL}/checkout`,
    });
    order.paymentStatus = payment.status === 'paid' ? 'paid' : 'pending';
    order.provider = payment.provider;
  }
  const saved = must(await db.rpc('commit_sale', { p: order }));
  if (payment) await rememberPayment(db, payment, { orderId: saved.id, studentId: student?.id });
  await notify(db, env, { job: 'new-order', to: settings.kitchenWhatsapp, text: formatKitchenWhatsApp(saved) });
  return payment ? { ...saved, payment } : saved;
}

async function kitchenOrders(db, env, pin, menu) {
  const role = assertStaff(env, pin);
  const orders = (await loadOrders(db)).filter((order) => ['received', 'preparing', 'ready'].includes(order.status));
  orders.sort((a, b) => String(a.pickupTime).localeCompare(String(b.pickupTime)));
  const { portions, soldOut } = portionsOf(menu);
  const forecast = await forecastRows(db, menu);
  return {
    orders,
    whatsapp: whatsappConfigured(env),
    demo: false,
    demoLabel: '',
    sample: false,
    role,
    soldOut,
    portions,
    menu: menu.map((item) => ({ id: item.id, name: item.name, category: item.category })),
    forecast,
  };
}

async function register(db, body) {
  const phone = normalizeSaPhone(body.phone);
  if (!phone) throw fail(new Error('Enter a valid South African phone number.'));
  const number = String(body.studentNumber || '').trim();
  const email = authEmail(number);
  const created = await db.auth.admin.createUser({ email, email_confirm: true, password: crypto.randomUUID() });
  if (created.error) throw fail(new Error(created.error.message.includes('already') ? 'That student number already has a wallet.' : created.error.message));
  let student;
  try {
    student = must(await db.rpc('register_student', {
      p_id: created.data.user.id,
      p_number: number,
      p_pin: String(body.pin || ''),
      p_name: String(body.fullName || ''),
      p_phone: phone,
      p_email: String(body.email || ''),
    }));
  } catch (error) {
    await db.auth.admin.deleteUser(created.data.user.id);
    throw error;
  }
  const session = await mintSession(db, email);
  return { student, access_token: session?.access_token, refresh_token: session?.refresh_token };
}

async function login(db, body) {
  const student = must(await db.rpc('student_by_pin', {
    p_number: String(body.studentNumber || ''),
    p_pin: String(body.pin || ''),
  }));
  if (!student) throw fail(new Error('Student number or PIN is wrong.'));
  const session = await mintSession(db, authEmail(student.studentNumber));
  return { student, access_token: session?.access_token, refresh_token: session?.refresh_token };
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function emailCode(db, env, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const { data, error } = await db.from('students').select('id').eq('email', email).maybeSingle();
  if (error) throw fail(error);
  if (!data) throw fail(new Error('No wallet uses that email yet.'));
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await db.from('email_codes').insert({
    email,
    code_hash: await sha256(code),
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  const sent = await sendEmail({
    env,
    to: email,
    subject: 'Your Food Court sign-in code',
    text: `Your Food Court code is ${code}. It expires in 10 minutes.`,
  });
  await logNotice(db, {
    job: 'email-code',
    status: sent.sent ? 'sent' : 'skipped',
    to: email,
    text: 'Sign-in code',
    channel: 'email',
    sent: Boolean(sent.sent),
    skipped: Boolean(sent.skipped),
    reason: sent.reason || '',
  });
  return {
    sent: Boolean(sent.sent),
    skipped: Boolean(sent.skipped),
    message: sent.sent ? 'Check your email for a code.' : 'Email is not configured, so no code was sent.',
  };
}

async function verifyEmail(db, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  const { data, error } = await db.from('email_codes').select('*').eq('email', email).order('created_at', { ascending: false }).limit(1);
  if (error) throw fail(error);
  const row = data?.[0];
  if (!row || Date.parse(row.expires_at) < Date.now() || row.code_hash !== await sha256(code)) {
    throw fail(new Error('That code is wrong.'));
  }
  const studentRow = must(await db.from('students').select('*').eq('email', email).maybeSingle());
  const student = mapStudent(studentRow);
  if (!student) throw fail(new Error('No wallet uses that email yet.'));
  const session = await mintSession(db, authEmail(student.studentNumber));
  return { student, access_token: session?.access_token, refresh_token: session?.refresh_token };
}

async function issueToken(db, studentId, { rotate = false } = {}) {
  if (!rotate) {
    const { data } = await db.from('pay_tokens').select('*').eq('student_id', studentId).is('consumed_at', null).gt('expires_at', new Date().toISOString()).limit(1);
    if (data?.[0]) {
      return {
        token: data[0].token,
        studentId,
        expiresAt: data[0].expires_at,
        consumedAt: null,
        payload: `FC1.${data[0].token}`,
        createdAt: data[0].created_at,
        demo: false,
      };
    }
  }
  const fresh = makePayToken(studentId);
  return must(await db.rpc('issue_pay_token', {
    p_student: studentId,
    p_token: fresh.token,
    p_expires: fresh.expiresAt,
  }));
}

async function wallet(db, id) {
  if (!id) return { student: null, demo: false, demoLabel: '' };
  const settings = await loadSettings(db, {});
  const student = mapStudent(must(await db.from('students').select('*').eq('id', id).maybeSingle()));
  if (!student) return { student: null, demo: false, demoLabel: '' };
  const orders = (await loadOrders(db)).filter((order) => order.studentId === id);
  const { data: ledger, error } = await db.from('wallet_ledger').select('*').eq('student_id', id).order('created_at', { ascending: false });
  if (error) throw fail(error);
  const token = await issueToken(db, id);
  return {
    demo: false,
    demoLabel: '',
    student,
    orders,
    ledger: (ledger || []).map(mapLedger),
    token,
    lowBalance: student.balanceCents < settings.lowBalanceCents,
    loyaltyText: loyaltyLabel(student.loyaltyStamps, settings.loyaltyTarget),
    thresholdCents: settings.lowBalanceCents,
    loyaltyTarget: settings.loyaltyTarget,
    warning: student.balanceCents < settings.lowBalanceCents ? formatLowBalanceWhatsApp(student, settings.lowBalanceCents) : '',
  };
}

async function rotateToken(db, id) {
  if (!id) throw fail(new Error('Sign in to show your pay code.'));
  return issueToken(db, id, { rotate: true });
}

async function topup(db, env, id, body) {
  if (!id) throw fail(new Error('Sign in to top up.'));
  const reference = crypto.randomUUID();
  const payment = await createCheckout({
    env,
    amountCents: body.amountCents,
    reference,
    kind: 'topup',
    successUrl: `${env.APP_BASE_URL}/wallet`,
    cancelUrl: `${env.APP_BASE_URL}/wallet`,
  });
  await rememberPayment(db, payment, { studentId: id });
  let entry = null;
  let student = mapStudent(must(await db.from('students').select('*').eq('id', id).maybeSingle()));
  if (payment.status === 'paid') {
    const posted = await creditWallet(db, {
      studentId: id,
      amountCents: payment.amountCents,
      kind: 'topup',
      method: 'card',
      provider: payment.provider,
      providerRef: reference,
      note: payment.demo ? 'Top-up recorded. No card was charged because payment keys are not set.' : 'Top-up',
    });
    student = posted.student;
    entry = posted.entry;
  }
  return { payment, student, entry };
}

async function linkCard(db, env, request, body) {
  let id = await userId(db, request, env);
  if (body.staffPin) {
    assertStaff(env, body.staffPin);
    const student = must(await db.rpc('student_by_pin', { p_number: String(body.studentNumber || ''), p_pin: String(body.pin || '') }));
    if (!student) throw fail(new Error('Student number or PIN is wrong.'));
    id = student.id;
  }
  if (!id) throw fail(new Error('Sign in to link a card.'));
  return must(await db.rpc('link_nfc', { p_student: id, p_uid: String(body.uid || '') }));
}

async function till({ db, env, body, request }) {
  assertStaff(env, pinOf(request, body));
  const method = body.method || 'wallet';
  let student = null;
  if (body.token) {
    const code = parsePayPayload(body.token) || String(body.token).trim().toUpperCase();
    const sid = must(await db.rpc('consume_pay_token', { p_token: code }));
    if (!sid) throw fail(new Error('That QR code has expired. Ask for a fresh one.'));
    student = mapStudent(must(await db.from('students').select('*').eq('id', sid).maybeSingle()));
  } else if (body.nfcUid) {
    student = mapStudent(must(await db.from('students').select('*').eq('nfc_uid', String(body.nfcUid).trim()).maybeSingle()));
    if (!student) throw fail(new Error('That card is not linked to a wallet.'));
  } else if (body.studentNumber) {
    student = must(await db.rpc('student_by_pin', { p_number: String(body.studentNumber), p_pin: String(body.studentPin || '') }));
    if (!student) throw fail(new Error('Student number or PIN is wrong.'));
  }
  const order = body.orderId ? await oneOrder(db, body.orderId) : null;
  const amount = order ? order.totalCents : Math.trunc(Number(body.amountCents));
  if (!Number.isFinite(amount) || amount < 0) throw fail(new Error('Enter an amount to take.'));
  let payment = null;
  if (method === 'wallet') {
    if (!student) throw fail(new Error('Scan a wallet QR, tap a card, or enter a student number and PIN.'));
    if (amount > 0) {
      await creditWallet(db, {
        studentId: student.id,
        amountCents: -amount,
        kind: order ? 'order' : 'till',
        method: 'wallet',
        orderId: order?.id,
        note: order ? order.orderNumber : 'Counter sale',
      });
    }
    if (order) {
      await db.from('orders').update({
        payment_method: 'wallet',
        payment_status: 'paid',
        pay_on_collection: false,
        student_id: student.id,
        updated_at: new Date().toISOString(),
      }).eq('id', order.id);
    }
  } else if (method === 'card') {
    if (amount > 0) {
      payment = await createCheckout({
        env,
        amountCents: amount,
        reference: order?.id || crypto.randomUUID(),
        kind: 'till',
        successUrl: `${env.APP_BASE_URL}/kitchen`,
        cancelUrl: `${env.APP_BASE_URL}/kitchen`,
      });
      await rememberPayment(db, payment, { orderId: order?.id, studentId: student?.id });
    }
    if (order && (!payment || payment.status === 'paid')) {
      await db.from('orders').update({
        payment_method: 'card',
        payment_status: 'paid',
        pay_on_collection: false,
        provider: payment?.provider || null,
        updated_at: new Date().toISOString(),
      }).eq('id', order.id);
    }
  } else if (order) {
    await db.from('orders').update({
      payment_method: 'cash',
      payment_status: 'paid',
      pay_on_collection: true,
      updated_at: new Date().toISOString(),
    }).eq('id', order.id);
  }
  return {
    ok: true,
    order: order ? await oneOrder(db, order.id) : null,
    student,
    payment,
    demo: false,
  };
}

async function storeImage(db, imageUrl) {
  if (!imageUrl || !String(imageUrl).startsWith('data:')) return imageUrl;
  const match = String(imageUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw fail(new Error('Add a photo of the special.'));
  const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
  const ext = match[1].includes('png') ? 'png' : 'jpg';
  const path = `${crypto.randomUUID()}.${ext}`;
  const uploaded = await db.storage.from('specials').upload(path, bytes, { contentType: match[1] });
  if (uploaded.error) throw fail(uploaded.error);
  return db.storage.from('specials').getPublicUrl(path).data.publicUrl;
}

async function saveSpecial(db, env, body) {
  const now = new Date();
  const parsed = body.caption ? parseSpecialCaption(body.caption, now) : null;
  if (body.caption && !parsed) throw fail(new Error('Use a caption like "Monday special: Burgers R55".'));
  const name = parsed?.name || String(body.name || '').trim();
  const price = parsed?.priceCents || Math.trunc(Number(body.priceCents));
  if (name.length < 2) throw fail(new Error('Name the special.'));
  if (!Number.isFinite(price) || price <= 0) throw fail(new Error('Enter a price in rands.'));
  const imageUrl = await storeImage(db, body.imageUrl);
  if (!imageUrl) throw fail(new Error('Add a photo of the special.'));
  const row = must(await db.rpc('publish_special', {
    p: {
      id: crypto.randomUUID(),
      specialDate: parsed?.specialDate || sastDate(now),
      name,
      priceCents: price,
      dow: parsed?.dow ?? null,
      dayLabel: parsed?.dayLabel || '',
      caption: parsed?.caption || body.caption || `${name} R${price / 100}`,
      imageUrl,
      source: body.source || 'chef-page',
      itemId: body.itemId || null,
    },
  }));
  const settings = await loadSettings(db, env);
  const allow = String(settings.chefWhatsappAllowlist || '').split(/[\s,;]+/).filter(Boolean)[0] || '';
  if (body.source !== 'whatsapp' && allow) {
    await notify(db, env, { job: 'special-live', to: allow, text: formatSpecialLive(row) });
  }
  return row;
}

async function specials(db, menu) {
  const { data, error } = await db.from('daily_specials').select('*').order('special_date', { ascending: false });
  if (error) throw fail(error);
  const rows = (data || []).filter((row) => row.status === 'live').map(mapSpecial);
  return { demo: false, demoLabel: '', specials: rows, today: resolveTodaySpecial({ specials: rows, menuItems: menu }) };
}

async function counter(db) {
  const { data, error } = await db.from('counter_now').select('*');
  if (error) throw fail(error);
  return {
    demo: false,
    demoLabel: '',
    orders: (data || []).map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      customerName: row.customer_name,
      pickupLabel: row.pickup_label,
      status: row.status,
    })),
  };
}

async function report(db, env, pin, url) {
  const role = assertStaff(env, pin, { manager: true });
  const snap = await snapshot(db, env);
  const from = url.searchParams.get('from') || '';
  const to = url.searchParams.get('to') || '';
  const built = buildFinanceReport({ ...snap, from, to, demo: false });
  const flags = must(await db.from('reconciliation_flags').select('*').order('created_at', { ascending: false }).limit(20));
  built.demoLabel = '';
  built.role = role;
  built.reconciliation = (flags || []).map((row) => ({
    id: row.id,
    reference: row.reference,
    kind: row.kind,
    localCents: row.local_cents,
    providerCents: row.provider_cents,
    provider: row.provider,
    detail: row.detail,
    createdAt: row.created_at,
    demo: false,
  }));
  built.csv = financeToCsv(built);
  return built;
}

async function stock(db, env, pin, menu) {
  assertStaff(env, pin, { manager: true });
  const snap = await snapshot(db, env);
  const suppliers = must(await db.from('suppliers').select('*'));
  const movements = must(await db.from('stock_movements').select('*').order('created_at', { ascending: false }).limit(40));
  const goods = must(await db.from('goods_received').select('*').order('created_at', { ascending: false }));
  const takes = must(await db.from('stock_takes').select('*').order('created_at', { ascending: false }));
  return {
    demo: false,
    demoLabel: '',
    suppliers,
    ingredients: snap.ingredients,
    recipes: snap.recipes,
    movements,
    goodsReceived: goods,
    waste: snap.waste,
    stockTakes: (takes || []).map((row) => ({ id: row.id, note: row.note, createdAt: row.created_at, lines: row.lines, demo: false })),
    suggestions: reorderSuggestions(snap.ingredients).map((row) => ({
      ...row,
      supplierName: (suppliers || []).find((supplier) => supplier.id === row.supplierId)?.name || '',
    })),
    stockValueCents: stockValueCents(snap.ingredients),
    portions: portionsOf(menu).portions,
    menu: menu.map((item) => ({ id: item.id, name: item.name })),
  };
}

async function settingsPage(db, env, pin) {
  assertStaff(env, pin, { manager: true });
  const settings = mergeSettings(await loadSettings(db, {}));
  const runs = must(await db.from('automation_runs').select('*').order('created_at', { ascending: false }).limit(30));
  return {
    demo: false,
    demoLabel: '',
    settings,
    providers: { whatsapp: whatsappConfigured(env), email: emailConfigured(env), payments: selectPaymentProvider(env) },
    runs: (runs || []).map((row) => ({ id: row.id, job: row.job, status: row.status, detail: row.detail, createdAt: row.created_at, demo: false })),
    jobs: SCHEDULED_JOBS,
  };
}

async function forecastRows(db, menu) {
  const today = sastDate(new Date());
  const { data } = await db.from('prep_forecasts').select('*').eq('forecast_date', today);
  if (data?.length) {
    return data.map((row) => ({
      itemId: row.item_id,
      name: row.name,
      historyAvg: Number(row.history_avg),
      historyDays: row.history_days,
      preorders: row.preorders,
      suggestQty: row.suggest_qty,
    }));
  }
  const orders = await loadOrders(db);
  return prepForecast({ menu, orders });
}

async function rate({ db, env, id, score }) {
  const order = await oneOrder(db, id);
  if (!order) throw fail(new Error('Order not found.'));
  if (order.status !== 'ready' && order.status !== 'collected') {
    throw fail(new Error('You can rate this once it is ready for collection.'));
  }
  const value = Math.trunc(Number(score));
  if (value < 1 || value > 5) throw fail(new Error('Choose a score from 1 to 5.'));
  const { error } = await db.from('ratings').insert({ order_id: order.id, score: value });
  if (error) throw fail(new Error(error.message.includes('duplicate') ? 'This order is already rated.' : error.message));
  const settings = await loadSettings(db, env);
  if (value <= settings.ratingAlertMax) {
    await notify(db, env, { job: 'rating', to: settings.managerWhatsapp, text: formatRatingAlert(order, value) });
  }
  return { orderId: order.id, score: value, demo: false };
}

async function runJobs(db, env, job) {
  const names = job === 'all' ? SCHEDULED_JOBS : [job];
  for (const name of names) await runJob(db, env, name);
  const runs = must(await db.from('automation_runs').select('*').order('created_at', { ascending: false }).limit(15));
  const menu = await loadMenu(db);
  return {
    ok: true,
    runs: (runs || []).map((row) => ({ id: row.id, job: row.job, status: row.status, detail: row.detail, createdAt: row.created_at })),
    forecast: await forecastRows(db, menu),
  };
}

async function runJob(db, env, name) {
  const snap = await snapshot(db, env);
  const menu = await loadMenu(db);
  const now = new Date();
  const today = sastDate(now);
  const hasSpecial = snap.specials.some((row) => row.specialDate === today && row.status !== 'removed');
  const settings = snap.settings;

  if (name === 'low-balance') {
    const alertedIds = snap.students
      .filter((student) => student.lowBalanceAlertedAt && Date.now() - Date.parse(student.lowBalanceAlertedAt) < 20 * 60 * 60 * 1000)
      .map((student) => student.id);
    const due = planLowBalance({ students: snap.students, settings, alertedIds });
    if (!due.length) await logNotice(db, { job: name, status: 'ok', detail: 'No wallets under the threshold.' });
    for (const action of due) {
      await notify(db, env, { job: name, to: action.to, text: action.text });
      await db.rpc('mark_low_balance', { p_id: action.studentId });
      if (action.autoTopup && action.autoTopupCents > 0) {
        const reference = crypto.randomUUID();
        const payment = await createCheckout({
          env,
          amountCents: action.autoTopupCents,
          reference,
          kind: 'topup',
          successUrl: `${env.APP_BASE_URL}/wallet`,
          cancelUrl: `${env.APP_BASE_URL}/wallet`,
        });
        await rememberPayment(db, payment, { studentId: action.studentId });
        if (payment.status === 'paid') {
          await creditWallet(db, {
            studentId: action.studentId,
            amountCents: payment.amountCents,
            kind: 'topup',
            method: 'card',
            provider: payment.provider,
            providerRef: reference,
            note: 'Auto top-up. No card was charged because payment keys are not set.',
          });
        } else if (payment.redirectUrl) {
          await notify(db, env, { job: name, to: action.to, text: `Top up your Food Court wallet: ${payment.redirectUrl}` });
        }
      }
    }
    return;
  }

  if (name === 'no-show') {
    const actions = planNoShows({ orders: snap.orders, now, settings });
    if (!actions.length) await logNotice(db, { job: name, status: 'ok', detail: 'No uncollected orders past the reminder window.' });
    for (const action of actions) {
      if (action.type === 'no-show-reminder') {
        await db.rpc('mark_reminder', { p_id: action.orderId });
        await notify(db, env, { job: name, to: action.to, text: action.text });
      } else {
        const status = action.type === 'write-off' ? 'written_off' : 'refunded';
        const updated = must(await db.rpc('cancel_order', { p_id: action.orderId, p_reason: 'no-show', p_payment_status: status }));
        await logNotice(db, {
          job: name,
          status: 'ok',
          detail: `${updated?.orderNumber || action.orderId} ${status === 'written_off' ? 'written off' : 'auto-refunded'} (no-show).`,
        });
      }
    }
    return;
  }

  if (name === 'chef-nudge') {
    const plan = planChefNudge({ now, settings, hasSpecialToday: hasSpecial });
    const to = String(plan.to || '').split(/[\s,;]+/).filter(Boolean)[0] || '';
    await notify(db, env, { job: name, to, text: plan.text });
    return;
  }

  if (name === 'special-deadline') {
    const plan = planSpecialDeadline({ hasSpecialToday: hasSpecial });
    await logNotice(db, { job: name, status: 'ok', detail: plan.detail });
    return;
  }

  if (name === 'stock') {
    const { portions, soldOut } = portionsOf(menu);
    const actions = planStockAlerts({
      ingredients: snap.ingredients,
      menu,
      portions,
      soldOut,
      lowThreshold: settings.portionLowThreshold,
    });
    for (const action of actions) {
      if (action.type === 'auto-sold-out') {
        await db.from('menu_items').update({ sold_out: true }).eq('id', action.itemId);
      }
      await notify(db, env, { job: name, to: settings.kitchenWhatsapp, text: action.text });
    }
    if (!actions.length) await logNotice(db, { job: name, status: 'ok', detail: 'No low-stock alerts.' });
    return;
  }

  if (name === 'eod') {
    const plan = planEndOfDay({ ...snap, now, demo: false });
    await notify(db, env, { job: name, to: settings.managerWhatsapp, text: plan.text });
    return;
  }

  if (name === 'weekly-csv') {
    const from = sastDate(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000));
    const built = buildFinanceReport({ ...snap, from, to: today, demo: false });
    const csv = financeToCsv(built);
    const sent = await sendEmail({
      env,
      to: settings.reportsEmail,
      subject: `Food Court week ${from} to ${today}`,
      text: 'Weekly sales CSV is attached.',
      attachments: [{ filename: `foodcourt-${from}-to-${today}.csv`, content: btoa(csv) }],
    });
    await logNotice(db, {
      job: name,
      status: sent.sent ? 'sent' : 'skipped',
      to: settings.reportsEmail,
      text: `Weekly CSV ${from} to ${today}.`,
      channel: 'email',
      sent: Boolean(sent.sent),
      skipped: Boolean(sent.skipped),
      reason: sent.reason || sent.error || '',
    });
    return;
  }

  if (name === 'forecast') {
    const plan = planForecast({ menu, orders: snap.orders, now });
    await db.from('prep_forecasts').delete().eq('forecast_date', today);
    if (plan.rows.length) {
      await db.from('prep_forecasts').insert(plan.rows.map((row) => ({
        forecast_date: today,
        item_id: row.itemId,
        name: row.name,
        history_avg: row.historyAvg,
        history_days: row.historyDays,
        preorders: row.preorders,
        suggest_qty: row.suggestQty,
      })));
    }
    await logNotice(db, { job: name, status: 'ok', detail: `Prep list has ${plan.rows.length} items.` });
    return;
  }

  if (name === 'reconcile') {
    const remote = await fetchProviderPayments({ env, from: today, to: today }).catch((error) => ({
      skipped: false,
      payments: null,
      reason: error.message,
    }));
    const local = (snap.payments || []).filter((row) => row.status === 'paid').map((row) => ({
      reference: row.reference,
      amountCents: row.amount_cents,
      provider: row.provider,
    }));
    const plan = planReconcile({ localPayments: local, remote: remote.payments });
    if (plan.skipped) {
      await logNotice(db, { job: name, status: 'skipped', detail: plan.reason || remote.reason || 'Provider keys are not set' });
      return;
    }
    for (const mismatch of plan.mismatches) {
      await db.from('reconciliation_flags').insert({
        reference: String(mismatch.reference || ''),
        kind: mismatch.kind,
        local_cents: mismatch.localCents,
        provider_cents: mismatch.providerCents,
        provider: mismatch.provider,
        detail: `${mismatch.kind} on ${mismatch.reference}`,
      });
    }
    await logNotice(db, {
      job: name,
      status: plan.mismatches.length ? 'flagged' : 'ok',
      detail: plan.mismatches.length ? `${plan.mismatches.length} mismatches flagged.` : 'Payments match.',
    });
  }
}

export async function handleAutomations(request) {
  const env = readEnv();
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request.headers.get('origin')) });
  const secret = request.headers.get('x-cron-secret') || '';
  if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
    return json({ error: 'Wrong PIN.' }, 401, request.headers.get('origin'));
  }
  try {
    const body = await request.json().catch(() => ({}));
    const db = client(env);
    const result = await runJobs(db, env, body.job || 'all');
    return json(result, 200, null);
  } catch (error) {
    return json({ error: String(error?.message || error) }, 400, null);
  }
}

export async function handleWhatsAppWebhook(request) {
  const env = readEnv();
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const challenge = metaVerify(Object.fromEntries(url.searchParams.entries()), env.WHATSAPP_VERIFY_TOKEN);
    if (challenge == null) return new Response('forbidden', { status: 403 });
    return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  if (request.method !== 'POST') return json({ ok: true }, 200, null);
  try {
    const payload = await request.json();
    const db = client(env);
    const settings = await loadSettings(db, env);
    for (const message of extractInboundMessages(payload)) {
      if (!numberAllowed(message.from, settings.chefWhatsappAllowlist)) continue;
      const parsed = parseSpecialCaption(message.caption);
      if (!parsed || !message.mediaId) {
        await sendWhatsApp({ env, to: message.from, text: formatSpecialRejected(parsed ? 'A photo is required.' : 'The caption was not understood.') });
        continue;
      }
      let imageUrl = '';
      if (env.WHATSAPP_TOKEN) {
        const meta = await fetch(`https://graph.facebook.com/v21.0/${message.mediaId}`, {
          headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` },
        });
        const info = await meta.json();
        if (info.url) {
          const bin = await fetch(info.url, { headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` } });
          const bytes = new Uint8Array(await bin.arrayBuffer());
          const path = `${crypto.randomUUID()}.jpg`;
          const uploaded = await db.storage.from('specials').upload(path, bytes, { contentType: message.mime || 'image/jpeg' });
          if (!uploaded.error) imageUrl = db.storage.from('specials').getPublicUrl(path).data.publicUrl;
        }
      }
      if (!imageUrl) {
        await sendWhatsApp({ env, to: message.from, text: formatSpecialRejected('The photo could not be saved.') });
        continue;
      }
      const row = await saveSpecial(db, env, { ...parsed, imageUrl, source: 'whatsapp', caption: message.caption });
      await sendWhatsApp({ env, to: message.from, text: formatSpecialLive(row) });
    }
    return json({ ok: true }, 200, null);
  } catch (error) {
    return json({ error: String(error?.message || error) }, 400, null);
  }
}

export async function handlePaymentsWebhook(request) {
  const env = readEnv();
  if (request.method !== 'POST') return json({ ok: true }, 200, null);
  try {
    const db = client(env);
    const type = request.headers.get('content-type') || '';
    let reference = '';
    let status = '';
    let amountCents = null;
    let provider = 'yoco';
    let providerRef = '';
    if (type.includes('application/x-www-form-urlencoded')) {
      const form = await request.formData();
      provider = 'payfast';
      reference = String(form.get('m_payment_id') || '');
      status = String(form.get('payment_status') || '');
      amountCents = Math.round(Number(form.get('amount_gross') || 0) * 100);
      providerRef = String(form.get('pf_payment_id') || reference);
      if (status !== 'COMPLETE') return json({ ok: true, ignored: true }, 200, null);
    } else {
      if (env.YOCO_WEBHOOK_SECRET) {
        const given = request.headers.get('x-yoco-signature') || request.headers.get('webhook-signature') || '';
        if (given && given !== env.YOCO_WEBHOOK_SECRET) return json({ error: 'Invalid signature' }, 401, null);
      }
      const payload = await request.json();
      const inner = payload.payload || payload.data || payload;
      reference = inner.metadata?.reference || inner.externalId || '';
      status = String(inner.status || payload.type || '');
      amountCents = Number(inner.amount);
      providerRef = inner.id || reference;
      if (!/succeeded|complete|paid/i.test(status) && !/succeeded/i.test(String(payload.type || ''))) {
        return json({ ok: true, ignored: true }, 200, null);
      }
    }
    if (!reference) return json({ ok: true, ignored: true }, 200, null);
    const { data: intent } = await db.from('payment_intents').select('*').eq('reference', reference).maybeSingle();
    if (!intent || intent.status === 'paid') return json({ ok: true }, 200, null);
    if (intent.kind === 'topup' && intent.student_id) {
      await creditWallet(db, {
        studentId: intent.student_id,
        amountCents: intent.amount_cents,
        kind: 'topup',
        method: 'card',
        provider,
        providerRef,
        note: 'Card top-up',
      });
    }
    if (intent.order_id) {
      await db.from('orders').update({ payment_status: 'paid', provider, updated_at: new Date().toISOString() }).eq('id', intent.order_id);
    }
    await db.from('payment_intents').update({ status: 'paid', provider_ref: providerRef }).eq('id', intent.id);
    if (amountCents && amountCents !== intent.amount_cents) {
      await db.from('reconciliation_flags').insert({
        reference,
        kind: 'amount',
        local_cents: intent.amount_cents,
        provider_cents: amountCents,
        provider,
        detail: 'Webhook amount differs from the local intent',
      });
    }
    return json({ ok: true }, 200, null);
  } catch (error) {
    return json({ error: String(error?.message || error) }, 400, null);
  }
}
