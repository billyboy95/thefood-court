import { createApi, esc, zar } from './platform/net.js';

const api = createApi();
const root = document.querySelector('#app');
const state = { me: null, orders: [], qr: null, outbox: [], error: '' };

async function boot() {
  try {
    const me = await api.call('/api/auth/me');
    state.me = me?.id ? me : null;
  } catch { state.me = null; }
  if (state.me) await load();
  paint();
  setInterval(() => { if (state.me) load().then(paint).catch(() => {}); }, 4000);
}
async function load() {
  state.orders = (await api.call('/api/kitchen/orders')).orders;
  state.qr = await api.call('/api/kitchen/counter-qr');
  state.outbox = await api.call('/api/outbox');
}
function paint() {
  root.innerHTML = `<div class="app"><header class="top"><div class="mark">K</div><div class="brand"><strong>Kitchen</strong><span>Same orders as the till</span></div><a href="/pos.html">POS</a></header><main class="screen">${state.error ? `<p class="alert">${esc(state.error)}</p>` : ''}${state.me ? board() : login()}</main></div>`;
  root.querySelector('#kitchen-login')?.addEventListener('submit', onLogin);
  root.querySelectorAll('[data-status]').forEach((node) => node.addEventListener('click', () => move(node.dataset.id, node.dataset.status)));
}
function login() {
  return `<form id="kitchen-login" class="card stack" style="padding:16px"><h1>Kitchen login</h1><label class="field">Username<input data-testid="kitchen-user" name="username" value="kitchen1"></label><label class="field">PIN<input data-testid="kitchen-pin" name="pin" type="password"></label><button class="btn gold">Unlock</button></form><p class="muted"><a href="/demo">Demo logins</a></p>`;
}
function board() {
  const cards = state.orders.map((order) => {
    const next = { paid: ['preparing', 'Start'], cash_pending: ['preparing', 'Start'], preparing: ['ready', 'Ready'], ready: ['collected', 'Collected'] }[order.fulfillment];
    return `<article class="card queue-card" data-testid="order-card"><div class="row between"><strong>${esc(order.orderNumber)}</strong><span class="pill">${esc(order.fulfillment)}</span></div><p>${esc(order.customerName)} · ${esc(order.memberNumber || '')}</p><p>${order.items.map((item) => `${item.qty}× ${esc(item.name)}`).join(', ')}</p>${order.notes ? `<p>Notes: ${esc(order.notes)}</p>` : ''}<p>${zar(order.totalCents)} · ${esc(order.paymentStatus)}</p>${next ? `<button class="btn" data-testid="mark-${next[0]}" data-id="${order.id}" data-status="${next[0]}">${next[1]}</button>` : ''}${order.orderQr ? `<p class="muted">Student code for staff scan</p><code>${esc(order.orderQr)}</code>` : ''}</article>`;
  }).join('');
  const messages = state.outbox.slice(0, 5).map((row) => `<li>${esc(row.event)}: ${esc(row.body)}</li>`).join('');
  return `<h1>Orders</h1>${state.qr ? `<img class="qr" data-testid="counter-qr" alt="Rotating counter code" src="${state.qr.dataUrl}"><p data-testid="counter-token">${esc(state.qr.token)}</p><p class="muted">Code rotates every ${state.qr.rotatesSeconds}s. Student scans it from their signed-in app.</p>` : ''}${cards || '<p>Nothing for the kitchen.</p>'}<h2>WhatsApp outbox</h2><ul data-testid="kitchen-outbox">${messages}</ul>`;
}
async function onLogin(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try { state.me = (await api.call('/api/auth/staff/login', { method: 'POST', json: { username: form.get('username'), pin: form.get('pin'), remember: true } })).user; await load(); paint(); }
  catch (err) { state.error = err.message; paint(); }
}
async function move(id, status) {
  try { await api.call(`/api/orders/${id}/status`, { method: 'POST', json: { status } }); await load(); paint(); }
  catch (err) { state.error = err.message; paint(); }
}
boot();
