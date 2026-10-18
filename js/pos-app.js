import { createApi, esc, zar } from './platform/net.js';

const api = createApi();
const root = document.querySelector('#app');
const state = { me: null, view: 'queue', error: '', notice: '', menu: null, cart: {}, queue: [], outbox: [], report: null, pnl: null, entities: [] };

function go(view) {
  state.view = view;
  state.error = '';
  paint();
  load().then(() => paint()).catch((err) => { state.error = err.message; paint(); });
}

async function boot() {
  try {
    const me = await api.call('/api/auth/me');
    state.me = me?.id && ['cashier', 'kitchen', 'supervisor', 'manager', 'finance', 'owner'].includes(me.role) ? me : null;
  } catch { state.me = null; }
  if (state.me && state.me.role !== 'kitchen') await load();
  paint();
  setInterval(() => {
    if (state.me && state.me.role !== 'kitchen' && state.view === 'queue') load().then(paint).catch(() => {});
  }, 4000);
}

async function load() {
  if (!state.me) return;
  if (state.view === 'queue' || state.view === 'sell') {
    state.queue = (await api.call('/api/pos/queue')).orders;
    if (!state.menu) state.menu = await api.call('/api/menu');
  }
  if (state.view === 'outbox') state.outbox = await api.call('/api/outbox');
  if (state.view === 'reports') state.report = await api.call('/api/reports/sales?range=day');
  if (state.view === 'pnl') state.pnl = await api.call('/api/reports/pnl?range=month');
  if (state.view === 'more' && state.me.role === 'owner') state.entities = await api.call('/api/payments/v1/entities');
}

function paint() {
  root.innerHTML = `<div class="app pos-app"><header class="top"><div class="mark">POS</div><div class="brand"><strong>EASTC Food Court POS</strong><span>Powered by AI AutoTech</span></div></header><main class="screen">${state.error ? `<p class="alert">${esc(state.error)}</p>` : ''}${state.notice ? `<p class="ok">${esc(state.notice)}</p>` : ''}${state.me ? body() : login()}</main>${state.me && state.me.role !== 'kitchen' ? tabs() : ''}</div>`;
  root.querySelector('#staff-login')?.addEventListener('submit', onLogin);
  root.querySelectorAll('[data-go]').forEach((node) => node.addEventListener('click', () => go(node.dataset.go)));
  root.querySelectorAll('[data-add]').forEach((node) => node.addEventListener('click', () => { state.cart[node.dataset.add] = (state.cart[node.dataset.add] || 0) + 1; paint(); }));
  root.querySelector('#sell-form')?.addEventListener('submit', onSell);
  root.querySelectorAll('[data-cash]').forEach((node) => node.addEventListener('click', () => takeCash(node.dataset.cash)));
  root.querySelector('#cashup-form')?.addEventListener('submit', onCashup);
  root.querySelector('#refund-form')?.addEventListener('submit', onRefund);
  root.querySelector('#void-form')?.addEventListener('submit', onVoid);
  root.querySelector('#topup-form')?.addEventListener('submit', onTopup);
  root.querySelector('#softpos-form')?.addEventListener('submit', onSoftpos);
  root.querySelector('#tap-form')?.addEventListener('submit', onTap);
  root.querySelector('#expense-form')?.addEventListener('submit', onExpense);
  root.querySelector('#price-form')?.addEventListener('submit', onPrice);
  root.querySelector('#import-form')?.addEventListener('submit', onImport);
  root.querySelector('#entity-switch')?.addEventListener('change', onEntity);
  root.querySelector('[data-logout]')?.addEventListener('click', onLogout);
  root.querySelector('[data-nfc]')?.addEventListener('click', onNfc);
}

function login() {
  return `<section class="stack"><h1>Private till</h1><p>EASTC's own POS. Yoco is only the card gateway. No Square, no Lightspeed.</p><form id="staff-login" class="card stack" style="padding:16px"><label class="field">Username<input data-testid="staff-username" name="username" required></label><label class="field">PIN<input data-testid="staff-pin" name="pin" type="password" required></label><label class="row"><input type="checkbox" name="remember" checked> Remember this phone</label><button class="btn gold full" data-testid="staff-login">Sign in</button></form><p class="muted"><a href="/demo">Demo logins</a> · <a href="/">Student app</a> · <a href="/kitchen.html">Kitchen</a></p></section>`;
}

function tabs() {
  return `<nav class="tabbar"><button data-go="queue" class="${state.view === 'queue' ? 'on' : ''}" data-testid="nav-queue">Queue</button><button data-go="sell" data-testid="nav-sell">Sell</button><button data-go="more" data-testid="nav-more">More</button></nav>`;
}

function body() {
  if (state.me.role === 'kitchen') {
    return `<h1>Kitchen account</h1><p data-testid="kitchen-blocked">This account prepares food. It cannot take payment, refund, or open the P&amp;L.</p><a class="btn" href="/kitchen.html">Open the kitchen screen</a>`;
  }
  if (state.view === 'sell') return sell();
  if (state.view === 'more') return more();
  if (state.view === 'outbox') return outbox();
  if (state.view === 'reports') return reports();
  if (state.view === 'pnl') return pnl();
  if (state.view === 'office') return office();
  return queue();
}

function queue() {
  const cards = state.queue.map((order) => `<article class="card queue-card" data-testid="queue-card"><div class="row between"><strong>${esc(order.orderNumber)}</strong><span class="pill">${esc(order.fulfillment)} · ${esc(order.paymentStatus)}</span></div><p>${esc(order.customerName)} · ${esc(order.memberNumber || order.channel)}</p><p>${order.items.map((item) => `${item.qty}× ${esc(item.name)}`).join(', ')}</p><p>${zar(order.totalCents)} · ${esc(order.paymentMethod || '')}</p>${order.notes ? `<p>Notes: ${esc(order.notes)}</p>` : ''}${order.fulfillment === 'cash_pending' ? `<div class="row"><input data-testid="tendered" id="tender-${order.id}" inputmode="numeric" placeholder="Tendered cents" value="${order.totalCents}"><button class="btn gold" data-testid="take-cash" data-cash="${order.id}">Take cash</button></div>` : ''}</article>`).join('');
  return `<h1>Live orders</h1><p class="muted">${esc(state.me.name)} · ${esc(state.me.entity)} · ${esc(state.me.tillId || 'all tills')}</p>${cards || '<p>No open orders.</p>'}`;
}

function sell() {
  const items = (state.menu?.items || []).map((item) => `<button class="btn secondary" data-add="${item.id}" data-testid="sell-${item.id}">${esc(item.name)} ${zar(item.priceCents)}</button>`).join(' ');
  const lines = Object.entries(state.cart).filter(([, qty]) => qty > 0);
  return `<h1>Walk-in</h1><div class="stack">${items}</div><form id="sell-form" class="card stack" style="padding:16px;margin-top:12px"><p>${lines.map(([id, qty]) => `${qty}× ${esc(id)}`).join(', ') || 'Nothing selected'}</p><label class="field">Tendered cents<input name="tenderedCents" value="10000"></label><div class="split"><button class="btn gold" name="method" value="cash">Cash</button><button class="btn" name="method" value="yoco_card">Yoco link</button><button class="btn secondary" name="method" value="softpos">Card tap handoff</button></div></form><form id="tap-form" class="stack"><label class="field">Wallet tap token<textarea data-testid="tap-token" name="token"></textarea></label><button class="btn">Charge wallet tap</button></form><button class="btn secondary" data-nfc>Read Web NFC</button><p class="notice">This browser cannot read a contactless bank card. Card tap hands off to the Yoco app or a card machine. Record the Yoco reference afterwards.</p><form id="softpos-form" class="row"><input name="intentId" placeholder="Payment id"><input name="yocoReference" placeholder="Yoco reference"><button class="btn">Reconcile</button></form>`;
}

function more() {
  const role = state.me.role;
  const financials = role === 'manager' || role === 'finance' || role === 'owner';
  const entity = role === 'owner' ? `<label class="field">Entity<select id="entity-switch" data-testid="entity-switch">${(state.entities.length ? state.entities : [{ id: state.me.entity, name: state.me.entity }]).map((entity) => `<option value="${esc(entity.id)}" ${entity.id === state.me.entity ? 'selected' : ''}>${esc(entity.name)}</option>`).join('')}</select></label>` : '';
  return `<h1>Till tools</h1><p class="muted">${esc(role)} · own system, own database</p>${entity}<div class="stack"><button class="btn" data-go="outbox" data-testid="open-outbox">WhatsApp outbox</button><a class="btn secondary" href="/api/reports/sales.csv?range=day">Export today's CSV</a>${financials ? '<button class="btn" data-go="pnl" data-testid="open-pnl">P&amp;L</button><button class="btn secondary" data-go="reports">Sales report</button>' : '<p data-testid="no-financials">Full financials are for the manager and finance.</p>'}<button class="btn secondary" data-go="office">Stock, purchases, expenses</button></div>
  <form id="cashup-form" class="card stack" style="padding:16px"><h2>Cash-up</h2><label class="field">Counted cents<input name="countedCents" required></label><button class="btn gold">Close cash-up</button></form>
  <form id="topup-form" class="card stack" style="padding:16px"><h2>Cash into a wallet</h2><input name="memberNumber" placeholder="STU1001 or EDU2001" required><input name="amountCents" placeholder="Amount cents" required><input name="tenderedCents" placeholder="Tendered cents" required><button class="btn">Top up</button></form>
  <form id="refund-form" class="stack"><input name="orderId" placeholder="Order id"><input name="reason" placeholder="Refund reason"><button class="btn danger">Refund</button></form>
  <form id="void-form" class="stack"><input name="orderId" placeholder="Order id"><input name="reason" placeholder="Void reason"><button class="btn secondary">Void</button></form>
  <button class="btn secondary" data-logout>Sign out</button>`;
}

function outbox() {
  const rows = state.outbox.map((row) => `<article class="card queue-card"><strong>${esc(row.event)}</strong> · ${esc(row.audience)} · ${esc(row.provider)}<p>${esc(row.body)}</p></article>`).join('');
  return `<h1>WhatsApp outbox</h1><p class="muted">Mock provider. Nothing is sent until Billy adds a real token.</p><div data-testid="outbox">${rows || '<p>No messages.</p>'}</div>`;
}

function reports() {
  if (!state.report) return '<p>Loading report…</p>';
  return `<h1>Sales ${esc(state.report.range)}</h1><p class="big">${zar(state.report.salesCents)}</p><pre>${esc(JSON.stringify(state.report.byMethod, null, 2))}</pre>`;
}

function pnl() {
  if (!state.pnl) return '<p>Loading P&amp;L…</p>';
  return `<h1 data-testid="pnl">P&amp;L</h1><p data-testid="pnl-sales">Sales ${zar(state.pnl.salesCents)}</p><p>Cost of goods ${zar(state.pnl.cogsCents)}</p><p>Expenses ${zar(state.pnl.expensesCents)}</p><p class="big">${zar(state.pnl.profitCents)}</p><p class="muted">Yoco ${zar(state.pnl.byMethod.yoco)} · Cash ${zar(state.pnl.byMethod.cash)} · Wallet ${zar(state.pnl.byMethod.wallet)}</p>`;
}

function office() {
  return `<h1>Back office</h1><form id="price-form" class="stack"><input name="itemId" placeholder="Item id" value="chips"><input name="priceCents" placeholder="New price cents"><button class="btn">Change price</button></form><form id="expense-form" class="stack"><input name="category" placeholder="Category" value="gas"><input name="amountCents" placeholder="Cents"><input name="note" placeholder="Note"><input name="receipt" type="file" accept="image/*,.pdf"><button class="btn">Submit expense</button></form><form id="import-form" class="stack"><textarea name="csv" placeholder="student_number,full_name,phone">student_number,full_name,phone</textarea><button class="btn secondary">Import students</button></form><p class="muted"><a href="/kitchen.html">Open kitchen</a></p>`;
}

async function onLogin(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    const data = await api.call('/api/auth/staff/login', { method: 'POST', json: { username: form.get('username'), pin: form.get('pin'), remember: Boolean(form.get('remember')) } });
    state.me = data.user;
    if (state.me.role !== 'kitchen') await load();
    paint();
  } catch (err) { state.error = err.message; paint(); }
}

async function takeCash(orderId) {
  const tendered = Number(document.querySelector(`#tender-${orderId}`)?.value || 0);
  try {
    await api.call(`/api/orders/${orderId}/cash`, { method: 'POST', json: { tenderedCents: tendered } });
    state.notice = 'Cash taken. The order is paid.';
    await load();
    paint();
  } catch (err) { state.error = err.message; paint(); }
}

async function onSell(event) {
  event.preventDefault();
  const method = event.submitter?.value || 'cash';
  const form = new FormData(event.target);
  const items = Object.entries(state.cart).filter(([, qty]) => qty > 0).map(([itemId, qty]) => ({ itemId, qty }));
  try {
    const result = await api.call('/api/pos/sales', { method: 'POST', json: { items, method, tenderedCents: Number(form.get('tenderedCents')) } });
    state.cart = {};
    state.notice = result.payment?.softposDeepLink ? `Hand off: ${result.payment.softposDeepLink}` : `Sale ${result.order.orderNumber} ${result.order.paymentStatus}`;
    if (result.payment?.checkoutUrl) location.href = result.payment.checkoutUrl;
    paint();
  } catch (err) { state.error = err.message; paint(); }
}

async function onCashup(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    const row = await api.call('/api/pos/cashup', { method: 'POST', json: { countedCents: Number(form.get('countedCents')) } });
    state.notice = `Cash-up variance ${zar(row.variance_cents)}`;
    paint();
  } catch (err) { state.error = err.message; paint(); }
}

async function onRefund(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try { await api.call(`/api/orders/${form.get('orderId')}/refund`, { method: 'POST', json: { reason: form.get('reason') } }); state.notice = 'Refunded to the original method, including wallet.'; paint(); }
  catch (err) { state.error = err.message; paint(); }
}
async function onVoid(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try { await api.call(`/api/orders/${form.get('orderId')}/void`, { method: 'POST', json: { reason: form.get('reason') } }); state.notice = 'Void recorded.'; paint(); }
  catch (err) { state.error = err.message; paint(); }
}
async function onTopup(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    const result = await api.call('/api/pos/wallet-topup', { method: 'POST', json: { memberNumber: form.get('memberNumber'), amountCents: Number(form.get('amountCents')), tenderedCents: Number(form.get('tenderedCents')) } });
    state.notice = `Wallet topped up. Change ${zar(result.changeCents)}.`;
    paint();
  } catch (err) { state.error = err.message; paint(); }
}
async function onSoftpos(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try { await api.call(`/api/payments/v1/intents/${form.get('intentId')}/softpos-reference`, { method: 'POST', json: { yocoReference: form.get('yocoReference') } }); state.notice = 'Yoco reference reconciled.'; paint(); }
  catch (err) { state.error = err.message; paint(); }
}
async function onTap(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const items = Object.entries(state.cart).filter(([, qty]) => qty > 0).map(([itemId, qty]) => ({ itemId, qty }));
  try { const result = await api.call('/api/pos/wallet-tap', { method: 'POST', json: { token: form.get('token'), items } }); state.notice = `Charged ${result.order.orderNumber}`; state.cart = {}; paint(); }
  catch (err) { state.error = err.message; paint(); }
}
async function onNfc() {
  if (!('NDEFReader' in window)) { state.error = 'Web NFC needs Android Chrome. Paste the wallet code instead. Bank cards are not read here.'; paint(); return; }
  try {
    const reader = new NDEFReader();
    await reader.scan();
    reader.onreading = (event) => {
      const record = event.message.records[0];
      const token = new TextDecoder().decode(record.data);
      const box = root.querySelector('[name=token]');
      if (box) box.value = token;
    };
  } catch (err) { state.error = err.message; paint(); }
}
async function onExpense(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const file = form.get('receipt');
  let receiptBase64 = '';
  if (file && file.size) receiptBase64 = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
  try { await api.call('/api/expenses', { method: 'POST', json: { category: form.get('category'), amountCents: Number(form.get('amountCents')), note: form.get('note'), receiptBase64 } }); state.notice = 'Expense sent for manager approval.'; paint(); }
  catch (err) { state.error = err.message; paint(); }
}
async function onPrice(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try { await api.call(`/api/menu/${form.get('itemId')}`, { method: 'PATCH', json: { priceCents: Number(form.get('priceCents')) } }); state.notice = 'Price updated and audited.'; paint(); }
  catch (err) { state.error = err.message; paint(); }
}
async function onImport(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try { const result = await api.call('/api/students/import', { method: 'POST', json: { csv: form.get('csv') } }); state.notice = `Imported ${result.added}`; paint(); }
  catch (err) { state.error = err.message; paint(); }
}
async function onEntity(event) {
  try { const data = await api.call('/api/auth/entity', { method: 'POST', json: { entityId: event.target.value } }); state.me = data.user; state.notice = `Now in ${data.user.entity}`; paint(); }
  catch (err) { state.error = err.message; paint(); }
}
async function onLogout() {
  await api.call('/api/auth/logout', { method: 'POST', json: {} }).catch(() => {});
  api.setToken('');
  state.me = null;
  paint();
}
boot();
