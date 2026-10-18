import { createApi, esc, zar } from './platform/net.js';

const api = createApi();
const root = document.querySelector('#app');
const state = {
  view: 'login',
  mode: 'student',
  me: null,
  menu: null,
  category: 'all',
  cart: loadCart(),
  error: '',
  order: null,
  wallet: null,
  messages: [],
  notes: [],
  form: {},
};

function loadCart() {
  try { return JSON.parse(sessionStorage.getItem('fc_cart') || '{}'); } catch { return {}; }
}
function saveCart() {
  try { sessionStorage.setItem('fc_cart', JSON.stringify(state.cart)); } catch { /* ignore */ }
}
function cartLines() {
  if (!state.menu) return [];
  return Object.entries(state.cart).filter(([, qty]) => qty > 0).map(([id, qty]) => {
    const item = state.menu.items.find((row) => row.id === id);
    return item ? { ...item, qty, line: item.priceCents * qty } : null;
  }).filter(Boolean);
}
function cartCount() { return cartLines().reduce((sum, line) => sum + line.qty, 0); }
function cartTotal() { return cartLines().reduce((sum, line) => sum + line.line, 0); }

function go(view) {
  state.view = view;
  state.error = '';
  const path = view === 'menu' ? '/' : `/${view}`;
  if (location.pathname !== path) history.pushState({}, '', path);
  paint();
}

async function boot() {
  const path = location.pathname.replace(/\/$/, '') || '/';
  if (path.startsWith('/order/')) state.view = 'order';
  else if (path === '/cart') state.view = 'cart';
  else if (path === '/checkout') state.view = 'checkout';
  else if (path === '/collect') state.view = 'collect';
  else if (path === '/account') state.view = 'account';
  else state.view = 'menu';
  try {
    const me = await api.call('/api/auth/me');
    state.me = me?.id ? me : null;
    if (state.me?.kind === 'parent') state.view = 'account';
  } catch {
    state.me = null;
    state.view = 'login';
  }
  if (state.me) await refreshData();
  if (state.view === 'order') {
    const id = location.pathname.split('/')[2];
    try { state.order = await api.call(`/api/orders/${id}`); } catch (err) { state.error = err.message; }
  }
  paint();
  setInterval(() => { if (state.me) poll().catch(() => {}); }, 5000);
}

async function refreshData() {
  if (state.me.kind !== 'parent') state.menu = await api.call('/api/menu');
  try { state.wallet = await api.call('/api/wallet'); } catch { state.wallet = null; }
  state.messages = await api.call('/api/outbox');
  state.notes = await api.call('/api/notifications');
}

async function poll() {
  const notes = await api.call('/api/notifications');
  const fresh = notes.find((note) => !state.notes.some((old) => old.id === note.id) && /ready/i.test(note.title + note.body));
  state.notes = notes;
  state.messages = await api.call('/api/outbox');
  if (fresh && state.view !== 'login') {
    state.banner = fresh.body;
    paint();
  }
}

function paint() {
  root.innerHTML = shell(screen());
  root.querySelectorAll('[data-go]').forEach((node) => node.addEventListener('click', () => go(node.dataset.go)));
  root.querySelectorAll('[data-mode]').forEach((node) => node.addEventListener('click', () => { state.mode = node.dataset.mode; paint(); }));
  root.querySelector('#auth-form')?.addEventListener('submit', onAuth);
  root.querySelectorAll('[data-add]').forEach((node) => node.addEventListener('click', () => changeQty(node.dataset.add, 1)));
  root.querySelectorAll('[data-inc]').forEach((node) => node.addEventListener('click', () => changeQty(node.dataset.inc, 1)));
  root.querySelectorAll('[data-dec]').forEach((node) => node.addEventListener('click', () => changeQty(node.dataset.dec, -1)));
  root.querySelectorAll('[data-cat]').forEach((node) => node.addEventListener('click', () => { state.category = node.dataset.cat; paint(); }));
  root.querySelector('#checkout-form')?.addEventListener('submit', onCheckout);
  root.querySelector('#collect-form')?.addEventListener('submit', onCollect);
  root.querySelector('#allowance-form')?.addEventListener('submit', onAllowance);
  root.querySelector('#salary-form')?.addEventListener('submit', onSalary);
  root.querySelector('#topup-form')?.addEventListener('submit', onTopup);
  root.querySelector('#limits-form')?.addEventListener('submit', onLimits);
  root.querySelector('[data-tap]')?.addEventListener('click', onTap);
  root.querySelector('[data-cancel-salary]')?.addEventListener('click', onCancelSalary);
  root.querySelector('[data-logout]')?.addEventListener('click', onLogout);
  root.querySelector('[data-nfc]')?.addEventListener('click', onNfc);
}

function shell(inner) {
  const tabs = state.me && state.me.kind !== 'parent' ? `
    <nav class="tabbar">
      <button data-go="menu" class="${state.view === 'menu' ? 'on' : ''}">Menu</button>
      <button data-go="cart" class="${state.view === 'cart' ? 'on' : ''}">Cart</button>
      <button data-go="collect" class="${state.view === 'collect' ? 'on' : ''}">Collect</button>
      <button data-go="account" class="${state.view === 'account' ? 'on' : ''}">Wallet</button>
    </nav>` : '';
  return `<div class="app"><header class="top"><div class="mark">FC</div><div class="brand"><strong>The Food Court</strong><span>EASTC campus · test mode</span></div><a href="/demo">Demo</a></header><main class="screen">${state.banner ? `<p class="ok" data-testid="ready-banner">${esc(state.banner)}</p>` : ''}${state.error ? `<p class="alert">${esc(state.error)}</p>` : ''}${inner}</main>${tabs}</div>`;
}

function screen() {
  if (!state.me || state.view === 'login') return login();
  if (state.me.kind === 'parent' || state.view === 'account') return account();
  if (state.view === 'cart') return cart();
  if (state.view === 'checkout') return checkout();
  if (state.view === 'collect') return collect();
  if (state.view === 'order') return order();
  return menu();
}

function login() {
  const title = { student: 'Student number', educator: 'Staff number', parent: 'Parent username' }[state.mode];
  const form = state.form || {};
  return `<section class="stack"><p class="eyebrow">Verified EASTC members only</p><h1>Order before the queue.</h1>
  <div class="chips"><button class="chip ${state.mode === 'student' ? 'on' : ''}" data-mode="student">Student</button><button class="chip ${state.mode === 'educator' ? 'on' : ''}" data-mode="educator">Educator</button><button class="chip ${state.mode === 'parent' ? 'on' : ''}" data-mode="parent">Parent</button></div>
  <form id="auth-form" class="card stack" style="padding:16px">
    <label class="field">${title}<input data-testid="login-number" name="number" autocomplete="username" required value="${esc(form.number || '')}"></label>
    <label class="field">PIN<input data-testid="login-pin" name="pin" inputmode="numeric" type="password" required value="${esc(form.pin || '')}"></label>
    <label class="field"><span><input type="checkbox" name="register" ${form.register ? 'checked' : ''}> Create my account</span></label>
    <label class="field"><span><input data-testid="popia" type="checkbox" name="popia" ${form.popia ? 'checked' : ''}> I accept the POPIA notice. EASTC stores my name, number and orders in its own database so the kitchen can make and hand over food.</span></label>
    <label class="field"><span><input type="checkbox" name="remember" ${form.remember === false ? '' : 'checked'}> Remember this device</span></label>
    <button class="btn full" data-testid="login-submit" type="submit">Continue</button>
  </form>
  <p class="muted"><a href="/pos.html">Staff POS</a> · <a href="/kitchen.html">Kitchen</a> · <a href="/demo">Test logins</a></p></section>`;
}

function menu() {
  const items = (state.menu?.items || []).filter((item) => state.category === 'all' || item.category === state.category);
  const cats = (state.menu?.categories || []).map((cat) => `<button class="chip ${state.category === cat.id ? 'on' : ''}" data-cat="${cat.id}">${esc(cat.label)}</button>`).join('');
  const cards = items.map((item) => `<article class="item"><div><h3>${esc(item.name)}</h3><p class="muted">${esc(item.description || '')}</p><strong>${zar(item.priceCents)}</strong> ${item.soldOut ? '<span class="pill">Sold out</span>' : `<button class="add" data-testid="add-${item.id}" data-add="${item.id}">+</button>`}</div><img src="${esc(item.image)}" alt=""></article>`).join('');
  const bar = cartCount() ? `<div class="cartbar"><button class="btn gold full" data-go="cart" data-testid="open-cart">Cart · ${cartCount()} · ${zar(cartTotal())}</button></div>` : '';
  return `<p class="muted">${esc(state.menu?.kitchen?.label || '')}</p><div class="chips">${cats}</div>${cards}${bar}`;
}

function cart() {
  const lines = cartLines();
  if (!lines.length) return `<h1>Cart</h1><p>Your cart is empty.</p><button class="btn" data-go="menu">Back to the board</button>`;
  const rows = lines.map((line) => `<div class="row between"><div><strong>${esc(line.name)}</strong><div class="muted">${zar(line.line)}</div></div><div class="row"><button data-dec="${line.id}">−</button><span>${line.qty}</span><button data-inc="${line.id}">+</button></div></div>`).join('');
  return `<h1>Cart</h1><div class="card stack" style="padding:16px">${rows}<strong>${zar(cartTotal())}</strong><button class="btn gold" data-testid="go-checkout" data-go="checkout">Checkout</button></div>`;
}

function checkout() {
  const slots = (state.menu?.slots || []).map((slot) => `<option value="${esc(slot.iso)}">${esc(slot.dateLabel)} ${esc(slot.displayTime || slot.label)}</option>`).join('');
  const balance = state.wallet ? `<p class="muted">Wallet ${zar(state.wallet.balanceCents)}${state.wallet.dailyAllowance?.enabled ? ` · left today ${zar(state.wallet.dailyAllowance.remainingTodayCents)}` : ''}</p>` : '';
  return `<h1>Checkout</h1>${balance}<form id="checkout-form" class="stack"><label class="field">Pickup<select name="pickupTime" data-testid="pickup">${slots}</select></label><label class="field">Notes<textarea name="notes" maxlength="240"></textarea></label>
  <label class="row"><input type="radio" name="method" value="yoco_card" checked data-testid="pay-yoco"> Pay now with Yoco (test)</label>
  <label class="row"><input type="radio" name="method" value="wallet" data-testid="pay-wallet"> Food wallet</label>
  <label class="row"><input type="radio" name="method" value="cash" data-testid="pay-cash"> Pay cash at the counter</label>
  <button class="btn gold full" type="submit">Place order · ${zar(cartTotal())}</button></form>`;
}

function order() {
  const order = state.order;
  if (!order) return `<p>Order not available.</p>`;
  const items = order.items.map((item) => `<li>${item.qty}× ${esc(item.name)}</li>`).join('');
  return `<p class="eyebrow">${esc(order.fulfillment)} · ${esc(order.paymentStatus)}</p><h1 data-testid="order-number">${esc(order.orderNumber)}</h1><ul>${items}</ul><p>${zar(order.totalCents)} · ${esc(order.paymentMethod || 'unpaid')}</p>${order.notes ? `<p>Notes: ${esc(order.notes)}</p>` : ''}<p class="muted">Same order on the till, in the kitchen and on WhatsApp.</p><button class="btn" data-testid="go-collect" data-go="collect">Collect</button>`;
}

function collect() {
  return `<h1>Collect</h1><p>Scan the code on the kitchen screen, or type it. It rotates and only matches your own paid, ready order.</p><form id="collect-form" class="stack"><label class="field">Counter code<textarea data-testid="collect-token" name="token" required></textarea></label><button class="btn gold" data-testid="collect-submit">I've got the code</button></form>`;
}

function account() {
  const me = state.me;
  const wallet = state.wallet;
  const allowance = wallet?.dailyAllowance?.enabled ? `<p class="ok">Today you can still spend ${zar(wallet.dailyAllowance.remainingTodayCents)} of ${zar(wallet.dailyAllowance.dailyCapCents)}.</p>` : '';
  const history = (wallet?.history || []).slice(0, 8).map((line) => `<li>${esc(line.memo)} · ${line.credit_cents ? '+' : '−'}${zar(line.credit_cents || line.debit_cents)}</li>`).join('');
  const messages = (state.messages || []).slice(0, 6).map((row) => `<li><strong>${esc(row.event)}</strong> ${esc(row.body)}</li>`).join('');
  const salary = me.kind === 'educator' ? `<form id="salary-form" class="card stack" style="padding:16px"><h2>Payday allocation</h2><p class="muted">This records a payroll instruction only. EASTC payroll is not connected.</p><label class="field">Amount (cents)<input name="amountCents" inputmode="numeric" placeholder="50000"></label><label class="field">or percent<input name="percent" inputmode="numeric" value="10"></label><label class="field">Payday (1-28)<input name="paydayDay" value="25"></label><label class="row"><input type="checkbox" name="consent" required> I consent and I can cancel</label><button class="btn">Save instruction</button></form><button class="btn secondary" data-cancel-salary>Cancel salary allocation</button>` : '';
  const parent = me.kind === 'parent' ? `<form id="limits-form" class="card stack" style="padding:16px"><h2>Limits for ${esc(me.linkedStudentNumber)}</h2><label class="field">Daily limit cents<input name="dailyLimitCents" value="${wallet?.dailyLimitCents || 30000}"></label><label class="field">Monthly limit cents<input name="monthlyLimitCents" value="${wallet?.monthlyLimitCents || 200000}"></label><label class="field">Monthly allowance cents<input name="allowanceCents" value="${wallet?.parentAllowance?.amountCents || 200000}"></label><label class="field">Allowance day<input name="allowanceDay" value="${wallet?.parentAllowance?.day || 1}"></label><button class="btn">Save limits</button></form>` : '';
  const own = me.kind !== 'parent' ? `<form id="allowance-form" class="card stack" style="padding:16px"><h2>Make the balance last</h2><label class="row"><input type="checkbox" name="enabled" ${wallet?.dailyAllowance?.enabled ? 'checked' : ''}> Daily allowance</label><label class="field">Monthly budget cents<input name="monthlyBudgetCents" value="${wallet?.dailyAllowance?.monthlyBudgetCents || 200000}"></label><button class="btn secondary">Update allowance</button></form><button class="btn" data-tap data-testid="wallet-tap">Show wallet tap code</button><p data-testid="wallet-tap-token" id="tap-token"></p><button class="btn secondary" data-nfc>Share tap with Web NFC</button>` : '';
  return `<h1>${esc(me.name)}</h1><p class="pill">${esc(me.memberNumber || me.linkedStudentNumber || me.role)}</p><p class="big">${wallet ? zar(wallet.balanceCents) : ''}</p>${allowance}
  <form id="topup-form" class="row"><input name="amountCents" inputmode="numeric" value="10000" aria-label="Top-up cents"><button class="btn gold" name="method" value="yoco_card">Top up Yoco</button></form>
  ${own}${parent}${salary}<h2>Wallet history</h2><ul>${history || '<li>No wallet movement yet.</li>'}</ul><h2>WhatsApp outbox</h2><ul data-testid="student-outbox">${messages || '<li>No messages yet.</li>'}</ul><button class="btn secondary" data-logout>Sign out</button><p class="notice">POPIA: your student or staff number, name, phone and orders stay in EASTC's own database for food collection. This demo is not the live campus register.</p>`;
}

function changeQty(id, delta) {
  state.cart[id] = Math.max(0, (state.cart[id] || 0) + delta);
  saveCart();
  paint();
}

async function onAuth(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const number = String(form.get('number') || '');
  const pin = String(form.get('pin') || '');
  const register = form.get('register');
  const popiaAccepted = Boolean(form.get('popia'));
  const remember = Boolean(form.get('remember'));
  state.form = { number, pin, register: Boolean(register), popia: popiaAccepted, remember };
  try {
    let data;
    if (state.mode === 'parent') {
      data = register
        ? await api.call('/api/auth/parent/register', { method: 'POST', json: { studentNumber: number, name: 'Parent', pin, popiaAccepted, remember } })
        : await api.call('/api/auth/parent/login', { method: 'POST', json: { username: number, pin, remember } });
    } else if (register && state.mode === 'educator') {
      data = await api.call('/api/auth/educator/register', { method: 'POST', json: { staffNumber: number, pin, popiaAccepted, remember } });
    } else if (register) {
      data = await api.call('/api/auth/student/register', { method: 'POST', json: { studentNumber: number, pin, popiaAccepted, remember } });
    } else {
      data = await api.call('/api/auth/member/login', { method: 'POST', json: { number, pin, remember } });
    }
    state.me = data.user;
    state.form = {};
    await refreshData();
    go(state.me.kind === 'parent' ? 'account' : 'menu');
  } catch (err) { state.error = err.message; paint(); }
}

async function onCheckout(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    const result = await api.call('/api/orders', { method: 'POST', json: {
      items: cartLines().map((line) => ({ itemId: line.id, qty: line.qty })),
      pickupTime: form.get('pickupTime'),
      notes: form.get('notes'),
      method: form.get('method'),
    } });
    state.cart = {};
    saveCart();
    state.order = result.order;
    if (result.payment?.checkoutUrl) location.href = result.payment.checkoutUrl;
    else { history.pushState({}, '', `/order/${result.order.id}`); state.view = 'order'; paint(); }
  } catch (err) { state.error = err.message; paint(); }
}

async function onCollect(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    state.order = await api.call('/api/collect/counter', { method: 'POST', json: { token: form.get('token') } });
    state.view = 'order';
    history.pushState({}, '', `/order/${state.order.id}`);
    paint();
  } catch (err) { state.error = err.message; paint(); }
}

async function onAllowance(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    state.wallet = await api.call('/api/wallet/daily-allowance', { method: 'POST', json: { enabled: Boolean(form.get('enabled')), monthlyBudgetCents: Number(form.get('monthlyBudgetCents')) } });
    paint();
  } catch (err) { state.error = err.message; paint(); }
}

async function onSalary(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const percent = Number(form.get('percent'));
  const amountCents = Number(form.get('amountCents'));
  try {
    state.wallet = await api.call('/api/wallet/salary-allocation', { method: 'POST', json: {
      mode: amountCents ? 'amount' : 'percent',
      amountCents: amountCents || undefined,
      percent: amountCents ? undefined : percent,
      paydayDay: Number(form.get('paydayDay')),
      consent: Boolean(form.get('consent')),
    } });
    paint();
  } catch (err) { state.error = err.message; paint(); }
}

async function onCancelSalary() {
  try { state.wallet = await api.call('/api/wallet/salary-allocation/cancel', { method: 'POST', json: {} }); paint(); }
  catch (err) { state.error = err.message; paint(); }
}

async function onTopup(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    const payment = await api.call('/api/wallet/topup', { method: 'POST', json: { amountCents: Number(form.get('amountCents')), method: 'yoco_card' } });
    if (payment.checkoutUrl) location.href = payment.checkoutUrl;
  } catch (err) { state.error = err.message; paint(); }
}

async function onLimits(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    state.wallet = await api.call('/api/wallet/limits', { method: 'POST', json: {
      dailyLimitCents: Number(form.get('dailyLimitCents')),
      monthlyLimitCents: Number(form.get('monthlyLimitCents')),
      allowanceCents: Number(form.get('allowanceCents')),
      allowanceDay: Number(form.get('allowanceDay')),
      lowBalanceCents: 5000,
    } });
    paint();
  } catch (err) { state.error = err.message; paint(); }
}

async function onTap() {
  try {
    const tap = await api.call('/api/wallet/tap-token', { method: 'POST', json: {} });
    const node = document.querySelector('#tap-token');
    if (node) node.textContent = tap.token;
  } catch (err) { state.error = err.message; paint(); }
}

async function onNfc() {
  const node = document.querySelector('#tap-token');
  const token = node?.textContent;
  if (!token) { state.error = 'Show a wallet tap code first.'; paint(); return; }
  if (!('NDEFReader' in window)) { state.error = 'Web NFC is available on Android Chrome. The code above is the same tap.'; paint(); return; }
  try {
    const writer = new NDEFReader();
    await writer.write({ records: [{ recordType: 'url', data: token }] });
  } catch (err) { state.error = err.message; paint(); }
}

async function onLogout() {
  await api.call('/api/auth/logout', { method: 'POST', json: {} }).catch(() => {});
  api.setToken('');
  state.me = null;
  state.view = 'login';
  paint();
}

window.addEventListener('popstate', boot);
boot();
