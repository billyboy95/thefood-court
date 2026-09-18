import { venue } from './data/venue.js';
import { NEXT_ACTION, STATUS_LABELS } from './api/orderService.js';
import { escapeHtml } from './lib/dom.js';
import { formatZAR } from './lib/money.js';
import { formatSaPhone } from './lib/phone.js';
import { partsInTZ } from './lib/hours.js';

function clockLabel(now) {
  const p = partsInTZ(now);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${days[p.dow]} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function isOverdue(order, now) {
  if (order.status === 'ready' || order.status === 'collected') return false;
  const t = Date.parse(order.pickupTime);
  return Number.isFinite(t) && t < now.getTime();
}

export function renderKitchenPin({ error = '', pending = false } = {}) {
  return `
    <div class="k-login">
      <div class="k-login-card">
        <p class="k-eyebrow">Staff only</p>
        <h1>Kitchen board</h1>
        <p class="k-lead">Enter the till PIN to see open pre-orders.</p>
        ${error ? `<p class="alert" role="alert">${escapeHtml(error)}</p>` : ''}
        <form id="kitchen-pin-form" class="k-pin-form">
          <label>
            <span class="sr-only">Staff PIN</span>
            <input name="pin" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="12" placeholder="PIN" required>
          </label>
          <button class="btn btn-gold btn-block" type="submit" ${pending ? 'disabled' : ''}>
            ${pending ? 'Checking…' : 'Open board'}
          </button>
        </form>
        <p class="k-hint">Bookmark <strong>/kitchen.html</strong> on the counter laptop or TV.</p>
      </div>
    </div>`;
}

function orderCard(order, now) {
  const action = NEXT_ACTION[order.status];
  const overdue = isOverdue(order, now);
  const when = order.pickupLabel || '';
  return `
    <article class="k-card is-${escapeHtml(order.status)} ${overdue ? 'is-overdue' : ''}" data-order="${escapeHtml(order.id)}">
      <header class="k-card-top">
        <h2>${escapeHtml(order.orderNumber)}</h2>
        <strong>${formatZAR(order.totalCents)}</strong>
      </header>
      <p class="k-pickup ${overdue ? 'is-late' : ''}">
        ${overdue ? 'OVERDUE · ' : ''}Pickup ${escapeHtml(when)}
      </p>
      <p class="k-who">${escapeHtml(order.customerName)}</p>
      <p class="k-phone">${escapeHtml(formatSaPhone(order.phone))}</p>
      <ul class="k-items">
        ${order.items
          .map((line) => `<li>${line.qty}× ${escapeHtml(line.name)}</li>`)
          .join('')}
      </ul>
      ${order.notes ? `<p class="k-notes">${escapeHtml(order.notes)}</p>` : ''}
      ${
        action
          ? `<button type="button" class="btn k-action" data-advance="${escapeHtml(order.id)}" data-status="${escapeHtml(action.status)}">${escapeHtml(action.label)}</button>`
          : ''
      }
    </article>`;
}

function column(status, orders, now) {
  const list = orders.filter((order) => order.status === status);
  return `
    <section class="k-col" data-col="${status}">
      <h2>${STATUS_LABELS[status]} <em>${list.length}</em></h2>
      ${
        list.length
          ? list.map((order) => orderCard(order, now)).join('')
          : `<p class="k-empty">None</p>`
      }
    </section>`;
}

export function renderKitchenBoard({
  orders = [],
  now = new Date(),
  demo = false,
  filter = 'all',
  muted = false,
  error = '',
  flash = '',
} = {}) {
  const counts = {
    received: orders.filter((o) => o.status === 'received').length,
    preparing: orders.filter((o) => o.status === 'preparing').length,
    ready: orders.filter((o) => o.status === 'ready').length,
  };

  return `
    <header class="k-top">
      <div class="k-brand">
        <div class="mark" aria-hidden="true">FC</div>
        <div>
          <strong>${escapeHtml(venue.name)}</strong>
          <span>Kitchen · ${escapeHtml(clockLabel(now))}</span>
        </div>
      </div>
      <div class="k-meta">
        <span class="k-live"><i></i> Live</span>
        <span class="k-count">${orders.length} open</span>
        <button type="button" class="k-icon-btn" data-mute aria-pressed="${muted ? 'true' : 'false'}">${muted ? 'Sound off' : 'Sound on'}</button>
        <button type="button" class="k-icon-btn" data-lock>Lock</button>
      </div>
    </header>
    ${
      demo
        ? `<p class="k-banner">Demo mode — orders on this device only. Deploy the Cloudflare Worker and set FOODCOURT_API_URL so the till sees student phones.</p>`
        : ''
    }
    ${error ? `<p class="alert k-alert" role="alert">${escapeHtml(error)}</p>` : ''}
    ${flash ? `<p class="k-flash" role="status">${escapeHtml(flash)}</p>` : ''}
    <nav class="k-filters" aria-label="Filter orders">
      <button type="button" class="chip ${filter === 'all' ? 'is-active' : ''}" data-filter="all">All ${orders.length}</button>
      <button type="button" class="chip ${filter === 'received' ? 'is-active' : ''}" data-filter="received">Received ${counts.received}</button>
      <button type="button" class="chip ${filter === 'preparing' ? 'is-active' : ''}" data-filter="preparing">Preparing ${counts.preparing}</button>
      <button type="button" class="chip ${filter === 'ready' ? 'is-active' : ''}" data-filter="ready">Ready ${counts.ready}</button>
    </nav>
    <div class="k-board" data-filter="${escapeHtml(filter)}">
      ${column('received', orders, now)}
      ${column('preparing', orders, now)}
      ${column('ready', orders, now)}
    </div>
    <p class="k-foot">Pay at the counter · ${escapeHtml(venue.address)}</p>`;
}
