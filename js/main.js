import { createOrderApi } from './api/client.js';
import { getMenu, getMenuItem } from './data/menu.js';
import { createCart } from './lib/cart.js';
import { getLocalStorage } from './lib/dom.js';
import {
  dayLabel,
  getPickupSlots,
  pickupDow,
  unavailableLines,
  unavailableOrderError,
} from './lib/hours.js';
import { createRouter } from './lib/router.js';
import {
  cartQtyLookup,
  renderCartPage,
  renderCheckout,
  renderConfirmation,
  renderMenu,
  renderNotFound,
} from './views.js';

const root = document.getElementById('app');
const storage = getLocalStorage();
const orderApi = createOrderApi({ storage });
const cart = createCart({ storage, getItem: getMenuItem });

const ui = {
  category: 'all',
  query: '',
  checkoutError: '',
  checkoutNotice: '',
  checkoutPending: false,
  checkoutForm: {},
};

function stripUnavailable(slots, now) {
  const dow = pickupDow(slots, now);
  const snap = cart.snapshot();
  const blocked = unavailableLines(snap.lines, dow);
  if (!blocked.length) return [];
  cart.removeMany(blocked.map((line) => line.itemId));
  return blocked.map((line) => line.item.name);
}

function removedNotice(names, slots, now) {
  if (!names.length) return '';
  const day = dayLabel(pickupDow(slots, now));
  const list = names.join(', ');
  const verb = names.length === 1 ? 'was' : 'were';
  return `${list} ${verb} not available for ${day} pickup and ${verb} removed from your cart.`;
}

const router = createRouter({
  render: (route) => {
    paint(route).catch((err) => {
      root.innerHTML = `<p class="alert">${String(err.message || err)}</p>`;
    });
  },
});

function cartView() {
  return cartQtyLookup(cart.snapshot());
}

async function paint(route) {
  const now = new Date();
  const slots = getPickupSlots(now);

  if (route.name === 'menu') {
    ui.checkoutNotice = '';
    root.innerHTML = renderMenu({
      items: getMenu(),
      cart: cartView(),
      category: ui.category,
      query: ui.query,
      slots,
      now,
    });
    root.dataset.page = 'menu';
    return;
  }

  if (route.name === 'cart') {
    root.innerHTML = renderCartPage({ cart: cartView(), slots, now });
    root.dataset.page = 'cart';
    return;
  }

  if (route.name === 'checkout') {
    const removed = stripUnavailable(slots, now);
    if (removed.length) {
      ui.checkoutNotice = removedNotice(removed, slots, now);
    }
    root.innerHTML = renderCheckout({
      cart: cartView(),
      slots,
      error: ui.checkoutError,
      notice: ui.checkoutNotice,
      pending: ui.checkoutPending,
      form: ui.checkoutForm,
    });
    root.dataset.page = 'checkout';
    return;
  }

  if (route.name === 'order') {
    const order = await orderApi.getOrder(route.id);
    root.innerHTML = renderConfirmation({ order });
    root.dataset.page = 'order';
    return;
  }

  root.innerHTML = renderNotFound();
  root.dataset.page = 'notfound';
}

function refresh() {
  const y = window.scrollY;
  const page = router.current().name;
  return paint(router.current()).then(() => {
    if (page === 'menu') window.scrollTo(0, y);
  });
}

cart.subscribe(() => {
  if (root.dataset.page === 'menu' || root.dataset.page === 'cart' || root.dataset.page === 'checkout') {
    refresh();
  }
});

root.addEventListener('click', (event) => {
  const add = event.target.closest('[data-add]');
  const inc = event.target.closest('[data-inc]');
  const dec = event.target.closest('[data-dec]');
  const remove = event.target.closest('[data-remove]');
  const strip = event.target.closest('[data-strip-unavailable]');
  const cat = event.target.closest('[data-category]');

  if (add) cart.add(add.dataset.add);
  if (inc) {
    const id = inc.dataset.inc;
    cart.setQty(id, cart.snapshot().lines.find((l) => l.itemId === id)?.qty + 1 || 1);
  }
  if (dec) {
    const id = dec.dataset.dec;
    const qty = cart.snapshot().lines.find((l) => l.itemId === id)?.qty ?? 0;
    cart.setQty(id, qty - 1);
  }
  if (remove) cart.setQty(remove.dataset.remove, 0);
  if (strip) {
    stripUnavailable(getPickupSlots(), new Date());
  }
  if (cat) {
    ui.category = cat.dataset.category;
    refresh();
  }
});

root.addEventListener('input', async (event) => {
  if (event.target.matches('[data-search]')) {
    ui.query = event.target.value;
    await refresh();
    const search = root.querySelector('[data-search]');
    search?.focus();
    search?.setSelectionRange(ui.query.length, ui.query.length);
  }
});

root.addEventListener('submit', async (event) => {
  if (event.target.id !== 'checkout-form') return;
  event.preventDefault();
  const form = new FormData(event.target);
  ui.checkoutForm = {
    customerName: String(form.get('customerName') || ''),
    phone: String(form.get('phone') || ''),
    pickupTime: String(form.get('pickupTime') || ''),
    notes: String(form.get('notes') || ''),
  };
  ui.checkoutError = '';
  ui.checkoutPending = true;
  refresh();
  try {
    const now = new Date();
    const slots = getPickupSlots(now);
    const slot = slots.find((s) => s.iso === ui.checkoutForm.pickupTime);
    const snapshot = cart.snapshot();
    if (slot) {
      const blocked = unavailableLines(snapshot.lines, slot.dow);
      if (blocked.length) {
        cart.removeMany(blocked.map((line) => line.itemId));
        throw new Error(unavailableOrderError(blocked.map((line) => line.item), slot.dow));
      }
    }
    const order = await orderApi.createOrder({
      ...ui.checkoutForm,
      items: snapshot.lines.map((line) => ({ itemId: line.itemId, qty: line.qty })),
    });
    ui.checkoutPending = false;
    ui.checkoutForm = {};
    ui.checkoutNotice = '';
    root.dataset.page = 'order';
    cart.clear();
    router.go(`/order/${encodeURIComponent(order.id)}`, { replace: true });
  } catch (err) {
    ui.checkoutPending = false;
    ui.checkoutError = err.message || 'Could not place this order.';
    refresh();
  }
});

router.start();
