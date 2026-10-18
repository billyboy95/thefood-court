import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicJwk } from './crypto.js';
import { createContext } from './context.js';
import {
  actorFromAccess,
  createAuthCode,
  exchangeAuthCode,
  loginMember,
  loginOperator,
  loginParent,
  openSession,
  passkeyLoginOptions,
  passkeyLoginVerify,
  passkeyRegisterOptions,
  passkeyRegisterVerify,
  popiaText,
  publicUser,
  registerEducator,
  registerParent,
  registerStudent,
  revokeRefresh,
  rotateRefresh,
  switchEntity,
} from './auth.js';
import {
  allowanceReminders,
  applyPayrollInstruction,
  applySignedWebhook,
  can,
  cancelSalaryAllocation,
  cashupPreview,
  cashWalletTopup,
  chargeWalletTap,
  closeCashup,
  collectByCounter,
  collectByOrderQr,
  counterQrImage,
  createExpense,
  createOnlineOrder,
  createPurchaseOrder,
  createSupplier,
  createWalkIn,
  crmSync,
  decideExpense,
  expireCashOrders,
  importDirectory,
  kitchenOrders,
  listOutbox,
  openEntityWallet,
  patchSettings,
  pnlReport,
  posQueue,
  presentIntent,
  presentOrder,
  receivePurchaseOrder,
  reconciliation,
  recordSoftposReference,
  refundOrder,
  salesReport,
  saveSalaryAllocation,
  setChildLimits,
  setDailyAllowance,
  setOrderStatus,
  settingsOf,
  signedWebhook,
  startYocoTopup,
  takeCash,
  tickPayroll,
  toCsv,
  updatePrice,
  voidOrder,
  walletTapToken,
  walletView,
  FOOD,
} from './commerce.js';
import { DEMO, ENTITIES, all, one, run } from './db.js';
import { HttpError } from './errors.js';
import { randomId } from './crypto.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
  return `${proto}://${host}`;
}

function rpId(req) {
  return String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(':')[0];
}

function cookieLine(req, ctx, name, value, maxAge) {
  const secure = originOf(req).startsWith('https');
  let line = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; HttpOnly`;
  if (maxAge != null) line += `; Max-Age=${Math.max(0, Math.round(maxAge))}`;
  if (secure) line += '; Secure';
  if (ctx.config.cookieDomain) line += `; Domain=${ctx.config.cookieDomain}`;
  return line;
}

function applySession(req, res, ctx, session, jar) {
  const accessAge = ctx.config.accessTtlSec;
  const refreshAge = Math.max(0, Math.round((new Date(session.refreshExpiresAt) - ctx.now()) / 1000));
  jar.push(cookieLine(req, ctx, 'fc_access', session.accessToken, accessAge));
  jar.push(cookieLine(req, ctx, 'fc_refresh', session.refreshToken, refreshAge));
  if (session.deviceId) jar.push(cookieLine(req, ctx, 'fc_device', session.deviceId, ctx.config.rememberTtlSec));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 6_000_000) throw new HttpError(413, 'Upload is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function actorFrom(req, ctx) {
  const header = String(req.headers.authorization || '');
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const token = bearer || cookies(req).fc_access;
  if (!token) return null;
  return actorFromAccess(ctx, token);
}

function requireActor(req, ctx) {
  const actor = actorFrom(req, ctx);
  if (!actor) throw new HttpError(401, 'Sign in.');
  return actor;
}

async function tick(ctx) {
  expireCashOrders(ctx);
  await allowanceReminders(ctx);
  await tickPayroll(ctx);
}

export function createApp(opts = {}) {
  const ctx = createContext(opts);
  const server = http.createServer((req, res) => {
    handle(ctx, req, res).catch((err) => {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      const body = JSON.stringify({ error: err.message || 'Server error' });
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      }
      res.end(body);
    });
  });
  return {
    ctx,
    server,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address();
          resolve(`http://127.0.0.1:${addr.port}`);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => {
          try { ctx.db.close(); } catch { /* already closed */ }
          resolve();
        });
      });
    },
  };
}

async function handle(ctx, req, res) {
  const url = new URL(req.url, originOf(req));
  const pathname = url.pathname.replace(/\/$/, '') || '/';
  const method = req.method.toUpperCase();
  if (method === 'GET' && pathname === '/api/health') {
    return json(res, { ok: true, service: 'eastc-food-court', testMode: ctx.config.yocoTestMode, whatsapp: 'mock' });
  }
  if (pathname.startsWith('/api')) await tick(ctx);
  else expireCashOrders(ctx);
  const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const contentType = String(req.headers['content-type'] || '');
  let body = {};
  if (raw.length && contentType.includes('application/json')) body = JSON.parse(raw.toString('utf8'));
  else if (raw.length && contentType.includes('application/x-www-form-urlencoded')) {
    body = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  }
  const jar = [];
  const sendJson = (status, payload) => json(res, payload, status, jar);
  const actor = () => requireActor(req, ctx);

  if (method === 'GET' && pathname === '/.well-known/openid-configuration') {
    const issuer = originOf(req);
    return sendJson(200, {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      userinfo_endpoint: `${issuer}/oauth/userinfo`,
      jwks_uri: `${issuer}/oauth/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['openid', 'profile'],
    });
  }
  if (method === 'GET' && pathname === '/oauth/jwks') {
    return sendJson(200, { keys: [publicJwk(ctx.keys.publicKey)] });
  }
  if (method === 'GET' && pathname === '/oauth/authorize') {
    const current = actorFrom(req, ctx);
    if (!current) return html(res, oauthForm(url));
    const code = createAuthCode(ctx, {
      clientId: url.searchParams.get('client_id'),
      redirectUri: url.searchParams.get('redirect_uri'),
      codeChallenge: url.searchParams.get('code_challenge'),
      userId: current.id,
      entity: current.entity,
    });
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') || '');
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  if (method === 'POST' && pathname === '/oauth/token') {
    const form = contentType.includes('application/x-www-form-urlencoded')
      ? Object.fromEntries(new URLSearchParams(raw.toString('utf8')))
      : body;
    return sendJson(200, exchangeAuthCode(ctx, {
      code: form.code,
      clientId: form.client_id,
      redirectUri: form.redirect_uri,
      codeVerifier: form.code_verifier,
    }));
  }
  if (method === 'GET' && pathname === '/oauth/userinfo') {
    return sendJson(200, publicUser(actor()));
  }

  if (method === 'POST' && pathname === '/api/auth/student/register') {
    const session = registerStudent(ctx, { ...body, userAgent: req.headers['user-agent'] });
    applySession(req, res, ctx, session, jar);
    return sendJson(201, session);
  }
  if (method === 'POST' && pathname === '/api/auth/educator/register') {
    const session = registerEducator(ctx, { ...body, userAgent: req.headers['user-agent'] });
    applySession(req, res, ctx, session, jar);
    return sendJson(201, session);
  }
  if (method === 'POST' && pathname === '/api/auth/member/login') {
    const session = loginMember(ctx, { ...body, userAgent: req.headers['user-agent'] });
    applySession(req, res, ctx, session, jar);
    return sendJson(200, session);
  }
  if (method === 'POST' && pathname === '/api/auth/parent/register') {
    const session = registerParent(ctx, { ...body, userAgent: req.headers['user-agent'] });
    applySession(req, res, ctx, session, jar);
    return sendJson(201, session);
  }
  if (method === 'POST' && pathname === '/api/auth/parent/login') {
    const session = loginParent(ctx, { ...body, userAgent: req.headers['user-agent'] });
    applySession(req, res, ctx, session, jar);
    return sendJson(200, session);
  }
  if (method === 'POST' && pathname === '/api/auth/staff/login') {
    const session = loginOperator(ctx, { ...body, userAgent: req.headers['user-agent'] });
    applySession(req, res, ctx, session, jar);
    return sendJson(200, session);
  }
  if (method === 'POST' && pathname === '/api/auth/refresh') {
    const session = rotateRefresh(ctx, cookies(req).fc_refresh || body.refreshToken);
    applySession(req, res, ctx, session, jar);
    return sendJson(200, session);
  }
  if (method === 'POST' && pathname === '/api/auth/logout') {
    revokeRefresh(ctx, cookies(req).fc_refresh || body.refreshToken);
    jar.push(cookieLine(req, ctx, 'fc_access', '', 0));
    jar.push(cookieLine(req, ctx, 'fc_refresh', '', 0));
    return sendJson(200, { ok: true });
  }
  if (method === 'GET' && pathname === '/api/auth/me') {
    const current = actorFrom(req, ctx);
    if (!current) return sendJson(200, { authenticated: false });
    return sendJson(200, publicUser(current));
  }
  if (method === 'POST' && pathname === '/api/auth/entity') {
    const current = actor();
    switchEntity(ctx, current, body.entityId);
    const rebound = openSession(ctx, current.id, {
      remember: true,
      deviceId: cookies(req).fc_device || null,
      entity: body.entityId,
      userAgent: req.headers['user-agent'],
    });
    applySession(req, res, ctx, rebound, jar);
    return sendJson(200, rebound);
  }
  if (method === 'POST' && pathname === '/api/auth/passkey/register/options') {
    return sendJson(200, await passkeyRegisterOptions(ctx, actor(), rpId(req)));
  }
  if (method === 'POST' && pathname === '/api/auth/passkey/register/verify') {
    return sendJson(200, await passkeyRegisterVerify(ctx, actor(), body, rpId(req), originOf(req)));
  }
  if (method === 'POST' && pathname === '/api/auth/passkey/login/options') {
    return sendJson(200, await passkeyLoginOptions(ctx, rpId(req)));
  }
  if (method === 'POST' && pathname === '/api/auth/passkey/login/verify') {
    const session = await passkeyLoginVerify(ctx, body, rpId(req), originOf(req), req.headers['user-agent']);
    applySession(req, res, ctx, session, jar);
    return sendJson(200, session);
  }
  if (method === 'GET' && pathname === '/api/popia') return sendJson(200, { notice: popiaText() });

  if (method === 'GET' && pathname === '/api/menu') {
    const { categories } = await import('../js/data/menu.js');
    const { getPickupSlots, kitchenStatus } = await import('../js/lib/hours.js');
    const items = all(ctx.db, `SELECT * FROM menu_items WHERE entity_id = 'food-court' ORDER BY category, name`);
    const staff = actorFrom(req, ctx);
    const showCost = staff && (can(staff, 'price') || can(staff, 'pnl'));
    return sendJson(200, {
      categories,
      kitchen: kitchenStatus(ctx.now()),
      slots: getPickupSlots(ctx.now()),
      items: items.map((item) => ({
        id: item.id,
        category: item.category,
        name: item.name,
        description: item.description,
        priceCents: item.price_cents,
        costCents: showCost ? item.cost_cents : undefined,
        image: item.image,
        stockQty: showCost ? item.stock_qty : undefined,
        soldOut: item.stock_qty <= 0,
        availableDays: item.available_days ? JSON.parse(item.available_days) : null,
        popular: Boolean(item.popular),
      })),
    });
  }
  const price = pathname.match(/^\/api\/menu\/([^/]+)$/);
  if (method === 'PATCH' && price) {
    return sendJson(200, updatePrice(ctx, actor(), price[1], body.priceCents));
  }

  if (method === 'POST' && pathname === '/api/orders') {
    return sendJson(201, await createOnlineOrder(ctx, actor(), body));
  }
  if (method === 'GET' && pathname === '/api/orders/mine') {
    const current = actor();
    const rows = all(ctx.db, 'SELECT * FROM orders WHERE member_number = ? ORDER BY created_at DESC', current.memberNumber);
    return sendJson(200, rows.map((order) => presentOrder(ctx, order)));
  }
  const orderGet = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (method === 'GET' && orderGet) {
    const current = actor();
    const order = one(ctx.db, 'SELECT * FROM orders WHERE id = ?', orderGet[1]);
    if (!order) throw new HttpError(404, 'Order not found.');
    const staff = ['cashier', 'kitchen', 'supervisor', 'manager', 'finance', 'owner'].includes(current.role);
    if (!staff && order.member_number !== current.memberNumber && order.student_number !== current.linkedStudentNumber) {
      throw new HttpError(403, 'That order belongs to someone else.');
    }
    return sendJson(200, presentOrder(ctx, order));
  }
  const cash = pathname.match(/^\/api\/orders\/([^/]+)\/cash$/);
  if (method === 'POST' && cash) return sendJson(200, await takeCash(ctx, actor(), cash[1], body.tenderedCents));
  const status = pathname.match(/^\/api\/orders\/([^/]+)\/status$/);
  if (method === 'POST' && status) return sendJson(200, await setOrderStatus(ctx, actor(), status[1], body.status));
  const refund = pathname.match(/^\/api\/orders\/([^/]+)\/refund$/);
  if (method === 'POST' && refund) return sendJson(200, refundOrder(ctx, actor(), refund[1], body.reason));
  const voided = pathname.match(/^\/api\/orders\/([^/]+)\/void$/);
  if (method === 'POST' && voided) return sendJson(200, voidOrder(ctx, actor(), voided[1], body.reason));

  if (method === 'GET' && pathname === '/api/kitchen/orders') return sendJson(200, { orders: kitchenOrders(ctx, actor()) });
  if (method === 'GET' && pathname === '/api/kitchen/counter-qr') {
    const current = actor();
    if (!can(current, 'kitchen')) throw new HttpError(403, 'Only kitchen staff can show the counter code.');
    return sendJson(200, await counterQrImage(ctx, current.entity));
  }
  if (method === 'POST' && pathname === '/api/collect/counter') return sendJson(200, collectByCounter(ctx, actor(), body.token));
  if (method === 'POST' && pathname === '/api/collect/order') return sendJson(200, collectByOrderQr(ctx, actor(), body.token));
  if (method === 'GET' && pathname === '/api/pos/queue') return sendJson(200, { orders: posQueue(ctx, actor()) });
  if (method === 'POST' && pathname === '/api/pos/sales') return sendJson(201, await createWalkIn(ctx, actor(), body));
  if (method === 'GET' && pathname === '/api/pos/cashup') return sendJson(200, cashupPreview(ctx, actor(), url.searchParams.get('tillId')));
  if (method === 'POST' && pathname === '/api/pos/cashup') return sendJson(201, closeCashup(ctx, actor(), body));
  if (method === 'POST' && pathname === '/api/pos/wallet-tap') return sendJson(200, await chargeWalletTap(ctx, actor(), body));
  if (method === 'POST' && pathname === '/api/pos/wallet-topup') return sendJson(200, await cashWalletTopup(ctx, actor(), body));

  if (method === 'GET' && pathname === '/api/wallet') {
    const current = actor();
    const member = current.kind === 'parent' ? current.linkedStudentNumber : current.memberNumber;
    return sendJson(200, walletView(ctx, member));
  }
  if (method === 'GET' && pathname === '/api/wallet/statement') {
    const current = actor();
    const member = url.searchParams.get('member') || (current.kind === 'parent' ? current.linkedStudentNumber : current.memberNumber);
    if (current.kind === 'parent' && member !== current.linkedStudentNumber) throw new HttpError(403, 'You can only see your linked student.');
    if ((current.kind === 'student' || current.kind === 'educator') && member !== current.memberNumber) {
      throw new HttpError(403, 'You can only see your own wallet.');
    }
    return sendJson(200, walletView(ctx, member));
  }
  if (method === 'POST' && pathname === '/api/wallet/topup') return sendJson(201, startYocoTopup(ctx, actor(), body));
  if (method === 'POST' && pathname === '/api/wallet/daily-allowance') return sendJson(200, setDailyAllowance(ctx, actor(), body));
  if (method === 'POST' && pathname === '/api/wallet/limits') return sendJson(200, setChildLimits(ctx, actor(), body));
  if (method === 'POST' && pathname === '/api/wallet/salary-allocation') return sendJson(200, saveSalaryAllocation(ctx, actor(), body));
  if (method === 'POST' && pathname === '/api/wallet/salary-allocation/cancel') return sendJson(200, cancelSalaryAllocation(ctx, actor()));
  if (method === 'POST' && pathname === '/api/wallet/tap-token') return sendJson(200, walletTapToken(ctx, actor()));
  if (method === 'GET' && pathname === '/api/payroll/instructions') {
    const current = actor();
    if (!can(current, 'payroll_apply') && current.kind !== 'educator') throw new HttpError(403, 'Your role cannot see payroll instructions.');
    const rows = current.kind === 'educator'
      ? all(ctx.db, 'SELECT * FROM payroll_instructions WHERE staff_number = ? ORDER BY created_at DESC', current.staffNumber)
      : all(ctx.db, 'SELECT * FROM payroll_instructions WHERE entity_id = ? ORDER BY created_at DESC', current.entity);
    return sendJson(200, rows);
  }
  const payroll = pathname.match(/^\/api\/payroll\/instructions\/([^/]+)\/apply$/);
  if (method === 'POST' && payroll) return sendJson(200, applyPayrollInstruction(ctx, actor(), payroll[1]));

  if (method === 'GET' && pathname === '/api/payments/v1/entities') return sendJson(200, ENTITIES);
  if (method === 'POST' && pathname === '/api/payments/v1/intents') {
    const current = actor();
    const entityId = body.entity || body.entityId || current.entity;
    if (current.role !== 'owner' && entityId !== current.entity) throw new HttpError(403, 'Payment entity does not match your session.');
    if (!['manager', 'finance', 'owner', 'supervisor', 'cashier'].includes(current.role)) {
      throw new HttpError(403, 'Your role cannot create entity payments.');
    }
    const intent = (await import('./commerce.js')).createIntent(ctx, {
      entityId,
      purpose: body.purpose || 'fee',
      method: body.method || 'yoco_card',
      amountCents: Math.round(Number(body.amountCents)),
      payerUserId: current.id,
      studentNumber: body.memberNumber || null,
      metadata: body.metadata || {},
    });
    return sendJson(201, intent);
  }
  const intentGet = pathname.match(/^\/api\/payments\/v1\/intents\/([^/]+)$/);
  if (method === 'GET' && intentGet) {
    const row = one(ctx.db, 'SELECT * FROM payment_intents WHERE id = ?', intentGet[1]);
    if (!row) throw new HttpError(404, 'Payment not found.');
    return sendJson(200, presentIntent(ctx, row));
  }
  const softpos = pathname.match(/^\/api\/payments\/v1\/intents\/([^/]+)\/softpos-reference$/);
  if (method === 'POST' && softpos) return sendJson(200, recordSoftposReference(ctx, actor(), softpos[1], body.yocoReference));
  if (method === 'GET' && pathname === '/api/payments/v1/reconciliation') return sendJson(200, reconciliation(ctx, actor()));
  if (method === 'POST' && pathname === '/api/payments/v1/wallets') return sendJson(201, openEntityWallet(ctx, actor(), body));

  if (method === 'POST' && pathname === '/api/yoco/webhook') {
    const headers = {
      'webhook-id': req.headers['webhook-id'],
      'webhook-timestamp': req.headers['webhook-timestamp'],
      'webhook-signature': req.headers['webhook-signature'],
    };
    return sendJson(200, await applySignedWebhook(ctx, raw.toString('utf8'), headers));
  }
  const payPage = pathname.match(/^\/pay\/test\/([^/]+)$/);
  if (method === 'GET' && payPage) return html(res, payHtml(ctx, payPage[1]));
  if (method === 'POST' && payPage) {
    const intent = one(ctx.db, 'SELECT * FROM payment_intents WHERE id = ?', payPage[1]);
    if (!intent) throw new HttpError(404, 'Checkout not found.');
    const outcome = String(body.outcome || 'succeeded');
    const payload = {
      id: `evt_${intent.id}`,
      type: outcome === 'failed' ? 'payment.failed' : 'payment.succeeded',
      data: {
        id: `pay_${intent.id}`,
        amount: intent.amount_cents,
        currency: 'ZAR',
        metadata: { intentId: intent.id, orderId: intent.order_id },
      },
    };
    const signed = signedWebhook(ctx, payload);
    await applySignedWebhook(ctx, signed.rawBody, signed.headers);
    const next = intent.order_id ? `/order/${intent.order_id}?result=${outcome === 'failed' ? 'failed' : 'paid'}` : `/account?topup=${outcome}`;
    res.writeHead(302, { Location: next });
    return res.end();
  }

  if (method === 'GET' && pathname === '/api/reports/sales') {
    return sendJson(200, salesReport(ctx, actor(), url.searchParams.get('range') || 'day'));
  }
  if (method === 'GET' && pathname === '/api/reports/sales.csv') {
    const csv = toCsv(salesReport(ctx, actor(), url.searchParams.get('range') || 'day'));
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="sales.csv"' });
    return res.end(csv);
  }
  if (method === 'GET' && pathname === '/api/reports/pnl') {
    return sendJson(200, pnlReport(ctx, actor(), url.searchParams.get('range') || 'day'));
  }
  if (method === 'GET' && pathname === '/api/reports/trial') {
    return sendJson(200, pnlReport(ctx, actor(), 'month').trial);
  }

  if (method === 'GET' && pathname === '/api/suppliers') return sendJson(200, all(ctx.db, 'SELECT * FROM suppliers WHERE entity_id = ?', actor().entity));
  if (method === 'POST' && pathname === '/api/suppliers') return sendJson(201, createSupplier(ctx, actor(), body));
  if (method === 'GET' && pathname === '/api/purchase-orders') {
    return sendJson(200, all(ctx.db, 'SELECT * FROM purchase_orders WHERE entity_id = ? ORDER BY created_at DESC', actor().entity));
  }
  if (method === 'POST' && pathname === '/api/purchase-orders') return sendJson(201, createPurchaseOrder(ctx, actor(), body));
  const receive = pathname.match(/^\/api\/purchase-orders\/([^/]+)\/receive$/);
  if (method === 'POST' && receive) return sendJson(200, receivePurchaseOrder(ctx, actor(), receive[1]));
  if (method === 'GET' && pathname === '/api/expenses') return sendJson(200, all(ctx.db, 'SELECT * FROM expenses WHERE entity_id = ? ORDER BY created_at DESC', actor().entity));
  if (method === 'POST' && pathname === '/api/expenses') {
    let receiptPath = null;
    if (body.receiptBase64) {
      const dir = path.join(ROOT, 'data', 'receipts');
      fs.mkdirSync(dir, { recursive: true });
      receiptPath = path.join(dir, `${randomId()}.bin`);
      fs.writeFileSync(receiptPath, Buffer.from(body.receiptBase64, 'base64'));
    }
    return sendJson(201, createExpense(ctx, actor(), body, receiptPath));
  }
  const decide = pathname.match(/^\/api\/expenses\/([^/]+)\/decide$/);
  if (method === 'POST' && decide) return sendJson(200, decideExpense(ctx, actor(), decide[1], body.decision));
  if (method === 'GET' && pathname === '/api/audit') {
    const current = actor();
    if (!can(current, 'pnl') && !can(current, 'reports_ops')) throw new HttpError(403, 'Your role cannot read the audit log.');
    return sendJson(200, all(ctx.db, 'SELECT * FROM audit_log WHERE entity_id = ? ORDER BY created_at DESC LIMIT 200', current.entity));
  }
  if (method === 'GET' && pathname === '/api/settings') return sendJson(200, settingsOf(ctx, actor().entity));
  if (method === 'PATCH' && pathname === '/api/settings') return sendJson(200, patchSettings(ctx, actor(), body));
  if (method === 'POST' && pathname === '/api/students/import') return sendJson(200, importDirectory(ctx, actor(), 'students', body.csv));
  if (method === 'POST' && pathname === '/api/staff/import') return sendJson(200, importDirectory(ctx, actor(), 'staff', body.csv));
  if (method === 'POST' && pathname === '/api/crm/sync') return sendJson(202, crmSync(ctx, actor(), body));
  if (method === 'GET' && pathname === '/api/outbox') {
    const current = actor();
    if (!can(current, 'outbox') && current.kind !== 'student' && current.kind !== 'educator' && current.kind !== 'parent') {
      throw new HttpError(403, 'Your role cannot read messages.');
    }
    if (current.kind === 'student' || current.kind === 'educator' || current.kind === 'parent') {
      return sendJson(200, listOutbox(ctx.db, FOOD, { userId: current.id }));
    }
    return sendJson(200, listOutbox(ctx.db, current.entity, { orderId: url.searchParams.get('orderId') || undefined }));
  }
  if (method === 'GET' && pathname === '/api/notifications') {
    const current = actor();
    return sendJson(200, all(ctx.db, 'SELECT * FROM inapp_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', current.id));
  }
  if (method === 'GET' && pathname === '/api/push/vapid') return sendJson(200, { publicKey: ctx.vapid.publicKey });
  if (method === 'POST' && pathname === '/api/push/subscribe') {
    const current = actor();
    runPush(ctx, current.id, body);
    return sendJson(201, { ok: true });
  }
  if (method === 'GET' && pathname === '/demo') {
    if (!ctx.config.demoLoginPage) throw new HttpError(404, 'Demo access is off.');
    return html(res, demoHtml());
  }

  if (method === 'GET' || method === 'HEAD') return serveStatic(res, pathname, method);
  throw new HttpError(404, 'Not found.');
}

function runPush(ctx, userId, body) {
  run(
    ctx.db,
    `INSERT INTO push_subscriptions (id, user_id, endpoint, keys_json, created_at) VALUES (?, ?, ?, ?, ?)`,
    randomId(),
    userId,
    body.endpoint,
    JSON.stringify(body.keys || {}),
    ctx.now().toISOString(),
  );
}

function json(res, payload, status = 200, jar = []) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(jar.length ? { 'set-cookie': jar } : {}),
  });
  res.end(JSON.stringify(payload));
}

function html(res, markup, status = 200) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(markup);
}

function payHtml(ctx, id) {
  const intent = one(ctx.db, 'SELECT * FROM payment_intents WHERE id = ?', id);
  if (!intent) return '<p>Checkout not found.</p>';
  const view = presentIntent(ctx, intent);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Yoco test checkout</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/css/platform.css"></head>
  <body class="pay-body"><main class="card stack">
  <p class="eyebrow">Yoco test mode</p>
  <h1>${(view.amountCents / 100).toFixed(2)} ZAR</h1>
  <p>No live card is charged. This stand-in signs a webhook the server verifies before anything is marked paid.</p>
  <p>Reference ${view.reference}</p>
  <form method="post"><input type="hidden" name="outcome" value="succeeded"><button class="btn" data-testid="pay-success" type="submit">Pay (test success)</button></form>
  <form method="post"><input type="hidden" name="outcome" value="eft"><button class="btn secondary" data-testid="pay-eft" type="submit">Simulate EFT success</button></form>
  <form method="post"><input type="hidden" name="outcome" value="failed"><button class="btn danger" data-testid="pay-fail" type="submit">Fail payment</button></form>
  </main></body></html>`;
}

function oauthForm(url) {
  const next = url.pathname + url.search;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/css/platform.css"><title>EASTC sign in</title></head>
  <body><main class="card stack"><h1>EASTC sign-in</h1>
  <form method="post" action="/api/auth/staff/login"><p>Continue in the app, then return.</p>
  <a class="btn" href="/pos.html">Open POS login</a></form>
  <p class="muted">Authorise ${next}</p></main></body></html>`;
}

function demoHtml() {
  const students = DEMO.students.map((s) => `<li>${s.number} · ${s.name} · PIN ${s.pin || 'not registered'}</li>`).join('');
  const educators = DEMO.educators.map((s) => `<li>${s.number} · ${s.name} · PIN ${s.pin || 'self-signup'} · salary allocation ${s.account ? '10% payday 25' : 'none yet'}</li>`).join('');
  const staff = DEMO.staff.map((s) => `<li>${s.username} · ${s.role} · PIN ${s.pin}</li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demo access</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/css/platform.css"></head>
  <body><main class="card stack"><p class="eyebrow">TEST DATA</p><h1>Demo access</h1>
  <p>These are seeded people, not live EASTC records. Yoco is in test mode. WhatsApp is the on-screen outbox.</p>
  <h2>Students</h2><ul>${students}</ul>
  <h2>Educator</h2><ul>${educators}</ul>
  <p>Parent of STU1001: parent.stu1001 · PIN 1010</p>
  <h2>POS / kitchen</h2><ul>${staff}</ul>
  <p><a href="/">Student app</a> · <a href="/pos.html">POS</a> · <a href="/kitchen.html">Kitchen</a></p>
  </main></body></html>`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.csv': 'text/csv',
};

function serveStatic(res, pathname, method) {
  const blocked = pathname.startsWith('/server') || pathname.startsWith('/data') || pathname.startsWith('/tests') || pathname.startsWith('/node_modules') || pathname.includes('..');
  if (blocked) throw new HttpError(403, 'Forbidden.');
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (rel === '/pos') rel = '/pos.html';
  if (rel === '/kitchen') rel = '/kitchen.html';
  const file = path.resolve(ROOT, `.${rel}`);
  if (!file.startsWith(ROOT)) throw new HttpError(403, 'Forbidden.');
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    if (method === 'HEAD') return res.end();
    return fs.createReadStream(file).pipe(res);
  }
  if (!path.extname(rel)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (method === 'HEAD') return res.end();
    return fs.createReadStream(path.join(ROOT, 'index.html')).pipe(res);
  }
  throw new HttpError(404, 'Not found.');
}
