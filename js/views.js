import { categories } from './data/menu.js';
import { venue } from './data/venue.js';
import { escapeHtml } from './lib/dom.js';
import { formatZAR } from './lib/money.js';
import { formatSaPhone } from './lib/phone.js';
import { isItemAvailable, kitchenStatus, partsInTZ } from './lib/hours.js';

function qtyControl(itemId, qty) {
  if (qty < 1) {
    return `<button class="add-btn" type="button" data-add="${escapeHtml(itemId)}">Add</button>`;
  }
  return `
    <div class="qty" role="group" aria-label="Quantity">
      <button type="button" data-dec="${escapeHtml(itemId)}" aria-label="Remove one">−</button>
      <span>${qty}</span>
      <button type="button" data-inc="${escapeHtml(itemId)}" aria-label="Add one">+</button>
    </div>`;
}

function itemCard(item, qty, { special = false, available = true } = {}) {
  const badges = [];
  if (special) badges.push('<span class="badge gold">Today</span>');
  if (item.badge) badges.push(`<span class="badge">${escapeHtml(item.badge)}</span>`);
  if (item.popular && !special) badges.push('<span class="badge">Popular</span>');

  return `
    <article class="item-card ${available ? '' : 'is-disabled'}" data-item="${escapeHtml(item.id)}">
      <img class="thumb" src="${escapeHtml(item.image)}" alt="" width="88" height="88" loading="lazy">
      <div class="item-body">
        <div class="item-top">
          <h3>${escapeHtml(item.name)}</h3>
          <span class="price">${formatZAR(item.priceCents)}</span>
        </div>
        <p class="desc">${escapeHtml(item.description)}</p>
        <div class="item-actions">
          <div class="badges">${badges.join('')}</div>
          ${available ? qtyControl(item.id, qty) : '<span class="muted">Not on today</span>'}
        </div>
      </div>
    </article>`;
}

export function renderMenu({ items, cart, category, query, slots, now }) {
  const status = kitchenStatus(now);
  const dow = partsInTZ(now).dow;
  const q = query.trim().toLowerCase();
  const specials = items.filter((item) => item.specialOn?.includes(dow));
  const specialIds = new Set(specials.map((item) => item.id));
  const visible = items.filter((item) => {
    if (category !== 'all' && item.category !== category) return false;
    if (category === 'all' && !q && specialIds.has(item.id)) return false;
    if (!q) return true;
    return `${item.name} ${item.description}`.toLowerCase().includes(q);
  });

  const catChips = categories
    .map(
      (cat) => `
        <button type="button" class="chip ${cat.id === category ? 'is-active' : ''}" data-category="${cat.id}">
          ${escapeHtml(cat.label)}
        </button>`,
    )
    .join('');

  const specialBlock =
    category === 'all' && !q && specials.length
      ? `
        <section class="specials">
          <p class="eyebrow">Today’s special</p>
          ${specials
            .map((item) =>
              itemCard(item, cart.qty(item.id), {
                special: true,
                available: isItemAvailable(item, slots, now),
              }),
            )
            .join('')}
        </section>`
      : '';

  const list =
    visible.length === 0
      ? `<p class="empty">Nothing on the board matches that.</p>`
      : visible
          .map((item) =>
            itemCard(item, cart.qty(item.id), {
              special: item.specialOn?.includes(dow),
              available: isItemAvailable(item, slots, now),
            }),
          )
          .join('');

  return `
    ${renderHeader({ cart, back: false })}
    <section class="hero-card">
      <p class="eyebrow">Pre-order · pickup only</p>
      <h1>Skip the queue. We’ll have it ready.</h1>
      <p class="hero-meta">
        <span class="status ${status.open ? 'is-open' : 'is-closed'}"><i></i> ${escapeHtml(status.label)}</span>
      </p>
      <p class="pickup-line">${escapeHtml(venue.address)} · EASTC campus</p>
    </section>
    <div class="search-wrap">
      <label class="sr-only" for="menu-search">Search menu</label>
      <input id="menu-search" type="search" placeholder="Search the board" value="${escapeHtml(query)}" data-search autocomplete="off">
    </div>
    <nav class="cats" aria-label="Menu categories">${catChips}</nav>
    ${specialBlock}
    <section class="menu-list" aria-label="Menu">
      ${specialBlock && visible.length ? '<p class="eyebrow">Full board</p>' : ''}
      ${list}
    </section>
    ${renderCartBar(cart)}
    ${renderFooterNote()}`;
}

export function renderCartPage({ cart }) {
  const rows = cart.lines.length
    ? cart.lines
        .map(
          (line) => `
          <article class="cart-row">
            <img class="thumb sm" src="${escapeHtml(line.item.image)}" alt="" width="64" height="64">
            <div>
              <h3>${escapeHtml(line.item.name)}</h3>
              <p class="muted">${formatZAR(line.item.priceCents)} each</p>
              <button type="button" class="text-btn" data-remove="${escapeHtml(line.itemId)}">Remove</button>
            </div>
            <div class="cart-row-end">
              ${qtyControl(line.itemId, line.qty)}
              <strong>${formatZAR(line.lineTotal)}</strong>
            </div>
          </article>`,
        )
        .join('')
    : `<div class="empty-card">
         <h2>Your cart is empty</h2>
         <p>Add something from the board — breakfast, pots, grill or a cold drink.</p>
         <a class="btn btn-gold" data-link href="/">Browse menu</a>
       </div>`;

  return `
    ${renderHeader({ cart, back: true, title: 'Cart' })}
    <section class="panel">
      ${rows}
    </section>
    ${
      cart.lines.length
        ? `<section class="summary">
             <div class="sum-row"><span>Items</span><span>${cart.itemCount}</span></div>
             <div class="sum-row total"><span>Total</span><span>${formatZAR(cart.totalCents)}</span></div>
             <p class="pay-hint">Pay when you collect — cash or card at the counter.</p>
             <a class="btn btn-gold btn-block" data-link href="/checkout">Go to checkout</a>
           </section>`
        : ''
    }`;
}

export function renderCheckout({ cart, slots, error = '', pending = false, form = {} }) {
  if (!cart.itemCount) {
    return `
      ${renderHeader({ cart, back: true, title: 'Checkout' })}
      <div class="empty-card">
        <h2>Nothing to check out</h2>
        <a class="btn btn-gold" data-link href="/">Back to menu</a>
      </div>`;
  }

  const grouped = new Map();
  for (const slot of slots) {
    if (!grouped.has(slot.dateLabel)) grouped.set(slot.dateLabel, []);
    grouped.get(slot.dateLabel).push(slot);
  }
  const options = [...grouped.entries()]
    .map(([label, list]) => {
      const inner = list
        .map(
          (slot) =>
            `<option value="${escapeHtml(slot.iso)}" ${form.pickupTime === slot.iso ? 'selected' : ''}>${escapeHtml(slot.displayTime)}</option>`,
        )
        .join('');
      return `<optgroup label="${escapeHtml(label)}">${inner}</optgroup>`;
    })
    .join('');

  return `
    ${renderHeader({ cart, back: true, title: 'Checkout' })}
    <section class="panel">
      <p class="eyebrow">Pickup at the Food Court</p>
      <h2 class="section-title">Who’s collecting?</h2>
      <p class="muted address">${escapeHtml(venue.address)}</p>
      ${error ? `<p class="alert" role="alert">${escapeHtml(error)}</p>` : ''}
      <form id="checkout-form" class="checkout-form" novalidate>
        <label>
          <span>Name</span>
          <input name="customerName" required minlength="2" maxlength="80" autocomplete="name" value="${escapeHtml(form.customerName || '')}" placeholder="Your name">
        </label>
        <label>
          <span>Phone</span>
          <input name="phone" required type="tel" inputmode="tel" autocomplete="tel" value="${escapeHtml(form.phone || '')}" placeholder="082 000 0000">
        </label>
        <label>
          <span>Pickup time</span>
          <select name="pickupTime" required>
            <option value="">Choose a time</option>
            ${options}
          </select>
        </label>
        <label>
          <span>Notes <em>(optional)</em></span>
          <textarea name="notes" maxlength="240" rows="3" placeholder="No chilli, extra gravy, student number…">${escapeHtml(form.notes || '')}</textarea>
        </label>
        <div class="pay-box">
          <strong>Pay on collection</strong>
          <p>Cash or card at the counter. No card details needed here.</p>
        </div>
        <button class="btn btn-gold btn-block" type="submit" ${pending ? 'disabled' : ''}>
          ${pending ? 'Placing order…' : `Place pre-order · ${formatZAR(cart.totalCents)}`}
        </button>
      </form>
    </section>
    <section class="summary compact">
      ${cart.lines
        .map(
          (line) =>
            `<div class="sum-row"><span>${line.qty}× ${escapeHtml(line.item.name)}</span><span>${formatZAR(line.lineTotal)}</span></div>`,
        )
        .join('')}
      <div class="sum-row total"><span>Total</span><span>${formatZAR(cart.totalCents)}</span></div>
    </section>`;
}

export function renderConfirmation({ order }) {
  if (!order) {
    return `
      ${renderHeader({ cart: { itemCount: 0 }, back: true, title: 'Order' })}
      <div class="empty-card">
        <h2>Order not found</h2>
        <p>This confirmation lives on this phone until the kitchen system is connected.</p>
        <a class="btn btn-gold" data-link href="/">Order again</a>
      </div>`;
  }

  const when = new Date(order.pickupTime);
  const timeLabel = order.pickupLabel || when.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });

  return `
    ${renderHeader({ cart: { itemCount: 0 }, back: false, title: 'Order' })}
    <section class="confirm">
      <div class="check" aria-hidden="true">✓</div>
      <p class="eyebrow">Pre-order received</p>
      <h1>${escapeHtml(order.orderNumber)}</h1>
      <p class="lead">Show this screen at the counter. We’ll plate it for <strong>${escapeHtml(timeLabel)}</strong>.</p>
      <div class="ticket">
        <div class="sum-row"><span>Collecting</span><span>${escapeHtml(order.customerName)}</span></div>
        <div class="sum-row"><span>Phone</span><span>${escapeHtml(formatSaPhone(order.phone))}</span></div>
        <div class="sum-row"><span>Pickup</span><span>${escapeHtml(timeLabel)}</span></div>
        <div class="sum-row"><span>Pay</span><span>At the counter</span></div>
        ${order.notes ? `<div class="sum-row"><span>Notes</span><span>${escapeHtml(order.notes)}</span></div>` : ''}
        <hr>
        ${order.items
          .map(
            (line) =>
              `<div class="sum-row"><span>${line.qty}× ${escapeHtml(line.name)}</span><span>${formatZAR(line.lineTotalCents)}</span></div>`,
          )
          .join('')}
        <div class="sum-row total"><span>Total</span><span>${formatZAR(order.totalCents)}</span></div>
      </div>
      <p class="pickup-line">${escapeHtml(venue.name)} · ${escapeHtml(venue.address)}</p>
      <div class="btn-row">
        <a class="btn btn-gold" data-link href="/">New order</a>
        <a class="btn btn-ghost" href="${venue.phoneHref}">Call kitchen</a>
      </div>
    </section>`;
}

export function renderNotFound() {
  return `
    ${renderHeader({ cart: { itemCount: 0 }, back: true, title: 'Not found' })}
    <div class="empty-card">
      <h2>That page isn’t on the board</h2>
      <a class="btn btn-gold" data-link href="/">Back to menu</a>
    </div>`;
}

function renderHeader({ cart, back, title }) {
  return `
    <header class="top">
      ${
        back
          ? `<a class="icon-btn" data-link href="${title === 'Checkout' ? '/cart' : '/'}" aria-label="Back">←</a>`
          : `<div class="mark" aria-hidden="true">FC</div>`
      }
      <div class="brand">
        <strong>${title ? escapeHtml(title) : escapeHtml(venue.name)}</strong>
        <span>Pickup · EASTC campus</span>
      </div>
      <a class="cart-icon" data-link href="/cart" aria-label="Open cart">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 6h15l-1.5 9h-12L5 3H2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="9" cy="20" r="1.3" fill="currentColor"/>
          <circle cx="18" cy="20" r="1.3" fill="currentColor"/>
        </svg>
        ${cart.itemCount ? `<em>${cart.itemCount}</em>` : ''}
      </a>
    </header>`;
}

function renderCartBar(cart) {
  if (!cart.itemCount) return '';
  return `
    <div class="cart-bar">
      <a class="cart-cta" data-link href="/cart">
        <span>View cart · ${cart.itemCount} item${cart.itemCount === 1 ? '' : 's'}</span>
        <strong>${formatZAR(cart.totalCents)}</strong>
      </a>
    </div>`;
}

function renderFooterNote() {
  return `
    <footer class="tiny">
      <p>Mon–Fri 07:00–17:30 · Sat 08:00–15:00 · Sun closed</p>
      <p><a href="${venue.phoneHref}">${escapeHtml(venue.phone)}</a> · ${escapeHtml(venue.address)}</p>
    </footer>`;
}

export function cartQtyLookup(snapshot) {
  const map = new Map(snapshot.lines.map((line) => [line.itemId, line.qty]));
  return {
    ...snapshot,
    qty: (id) => map.get(id) ?? 0,
  };
}
