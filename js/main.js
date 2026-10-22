import { createOrderApi } from './api/client.js';
import { followPayment } from './lib/payRedirect.js';
import { getMenu, getMenuItem } from './data/menu.js';
import { createCart } from './lib/cart.js';
import { getLocalStorage } from './lib/dom.js';
import { getPickupSlots } from './lib/hours.js';
import { createRouter } from './lib/router.js';
import { rangeForPreset, sastDate } from './domain/dates.js';
import { startKitchen } from './kitchen.js';
import {
  renderChef,
  renderCounter,
  renderReports,
  renderSettings,
  renderSpecialsPage,
  renderStock,
  renderWallet,
} from './screens.js';
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
const PIN_KEY = 'foodcourt.staffPin';
const CHEF_KEY = 'foodcourt.chefPin';

const ui = {
  category: 'all',
  query: '',
  checkoutError: '',
  checkoutPending: false,
  checkoutForm: {},
  board: null,
  wallet: null,
  walletError: '',
  walletNotice: '',
  chefUnlocked: false,
  chefError: '',
  chefNotice: '',
  report: null,
  reportError: '',
  reportFrom: '',
  reportTo: '',
  stock: null,
  stockError: '',
  stockNotice: '',
  settings: null,
  settingsError: '',
  settingsNotice: '',
  settingsRuns: [],
  providers: null,
  counter: null,
  specials: null,
};

function cartView() {
  return cartQtyLookup(cart.snapshot());
}

function staffPin() {
  try {
    return sessionStorage.getItem(PIN_KEY) || '';
  } catch {
    return '';
  }
}

function rememberStaff(pin) {
  try {
    sessionStorage.setItem(PIN_KEY, pin);
  } catch {
    /* ignore */
  }
}

const router = createRouter({
  render: (route) => {
    paint(route).catch((err) => {
      root.innerHTML = `<p class="alert">${String(err.message || err)}</p>`;
    });
  },
});

async function loadBoard() {
  try {
    ui.board = await orderApi.getBoard();
  } catch {
    ui.board = null;
  }
}

async function slotsFor(now) {
  try {
    if (orderApi.getPickupSlots) return await orderApi.getPickupSlots(now);
  } catch {
    /* fall through */
  }
  return getPickupSlots(now);
}

async function paint(route) {
  const snapshot = cartView();
  const now = new Date();

  if (route.name === 'kitchen') {
    document.documentElement.classList.add('is-kitchen');
    document.body.classList.add('kitchen-page');
    document.title = 'Kitchen · The Food Court';
    root.dataset.page = 'kitchen';
    await startKitchen(root);
    return;
  }

  document.documentElement.classList.remove('is-kitchen');
  document.body.classList.remove('kitchen-page');

  if (route.name === 'menu') {
    document.title = 'The Food Court · Pre-order pickup';
    if (!ui.board) await loadBoard();
    const slots = await slotsFor(now);
    root.innerHTML = renderMenu({
      items: getMenu(),
      cart: snapshot,
      category: ui.category,
      query: ui.query,
      slots,
      now,
      soldOut: ui.board?.soldOut || {},
      todaySpecial: ui.board?.todaySpecial,
      demoLabel: ui.board?.demoLabel || '',
    });
    root.dataset.page = 'menu';
    return;
  }

  if (route.name === 'cart') {
    root.innerHTML = renderCartPage({ cart: snapshot });
    root.dataset.page = 'cart';
    return;
  }

  if (route.name === 'checkout') {
    const slots = await slotsFor(now);
    let wallet = null;
    let loyaltyText = '';
    try {
      const bag = await orderApi.getWallet();
      wallet = bag?.student ? bag.student : null;
      loyaltyText = bag?.loyaltyText || '';
      ui.wallet = bag;
    } catch {
      wallet = null;
    }
    root.innerHTML = renderCheckout({
      cart: snapshot,
      slots,
      error: ui.checkoutError,
      pending: ui.checkoutPending,
      form: ui.checkoutForm,
      wallet,
      loyaltyText,
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

  if (route.name === 'wallet') {
    document.title = 'Wallet · The Food Court';
    try {
      ui.wallet = await orderApi.getWallet();
    } catch (err) {
      ui.walletError = err.message;
    }
    root.innerHTML = renderWallet({
      wallet: ui.wallet,
      error: ui.walletError,
      notice: ui.walletNotice,
    });
    root.dataset.page = 'wallet';
    return;
  }

  if (route.name === 'specials') {
    document.title = 'Specials · The Food Court';
    ui.specials = await orderApi.getSpecials();
    root.innerHTML = renderSpecialsPage({ archive: ui.specials, demoLabel: ui.specials?.demoLabel || '' });
    root.dataset.page = 'specials';
    return;
  }

  if (route.name === 'chef') {
    document.title = 'Chef · The Food Court';
    root.innerHTML = renderChef({ unlocked: ui.chefUnlocked, error: ui.chefError, notice: ui.chefNotice });
    root.dataset.page = 'chef';
    return;
  }

  if (route.name === 'counter') {
    document.title = 'Now collecting · The Food Court';
    ui.counter = await orderApi.listReady();
    root.innerHTML = renderCounter({ orders: ui.counter.orders || [], demoLabel: ui.counter.demoLabel || '' });
    root.dataset.page = 'counter';
    return;
  }

  if (route.name === 'reports') {
    document.title = 'Reports · The Food Court';
    await paintReports();
    return;
  }

  if (route.name === 'stock') {
    document.title = 'Stock · The Food Court';
    await paintStock();
    return;
  }

  if (route.name === 'settings') {
    document.title = 'Settings · The Food Court';
    await paintSettings();
    return;
  }

  root.innerHTML = renderNotFound();
  root.dataset.page = 'notfound';
}

async function paintReports() {
  const pin = staffPin();
  if (!ui.reportFrom) {
    const range = rangeForPreset('week');
    ui.reportFrom = range.from;
    ui.reportTo = range.to;
  }
  if (pin && !ui.report) {
    try {
      ui.report = await orderApi.getReport({ pin, from: ui.reportFrom, to: ui.reportTo });
      ui.reportError = '';
    } catch (err) {
      ui.reportError = err.message;
    }
  }
  root.innerHTML = renderReports({
    report: ui.report,
    error: ui.reportError,
    from: ui.reportFrom,
    to: ui.reportTo,
  });
  root.dataset.page = 'reports';
}

async function paintStock() {
  const pin = staffPin();
  if (pin && !ui.stock) {
    try {
      ui.stock = await orderApi.getStock(pin);
      ui.stockError = '';
    } catch (err) {
      ui.stockError = err.message;
    }
  }
  root.innerHTML = renderStock({ stock: ui.stock, error: ui.stockError, notice: ui.stockNotice });
  root.dataset.page = 'stock';
}

async function paintSettings() {
  const pin = staffPin();
  if (pin && !ui.settings) {
    try {
      const payload = await orderApi.getSettings(pin);
      ui.settings = payload.settings;
      ui.settingsRuns = payload.runs || [];
      ui.providers = payload.providers;
      ui.settingsError = '';
    } catch (err) {
      ui.settingsError = err.message;
    }
  }
  root.innerHTML = renderSettings({
    settings: ui.settings,
    error: ui.settingsError,
    notice: ui.settingsNotice,
    runs: ui.settingsRuns,
    providers: ui.providers,
  });
  root.dataset.page = 'settings';
}

function refresh() {
  const page = router.current().name;
  if (page === 'menu') ui.board = null;
  if (page === 'reports') ui.report = null;
  if (page === 'stock') ui.stock = null;
  const y = window.scrollY;
  return paint(router.current()).then(() => {
    if (page === 'menu') window.scrollTo(0, y);
  });
}

cart.subscribe(() => {
  if (root.dataset.page === 'menu' || root.dataset.page === 'cart' || root.dataset.page === 'checkout') {
    refresh();
  }
});

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read that photo.'));
    reader.readAsDataURL(file);
  });
}

root.addEventListener('click', async (event) => {
  const t = event.target instanceof Element ? event.target : event.target.parentElement;
  if (!t) return;
  const add = t.closest('[data-add]');
  const inc = t.closest('[data-inc]');
  const dec = t.closest('[data-dec]');
  const remove = t.closest('[data-remove]');
  const cat = t.closest('[data-category]');
  const rate = t.closest('[data-rate]');
  const csv = t.closest('[data-csv]');
  const job = t.closest('[data-job]');
  const signOut = t.closest('[data-sign-out]');
  const nfc = t.closest('[data-nfc-link]');

  if (add) cart.add(add.dataset.add);
  if (inc) {
    const id = inc.dataset.inc;
    cart.setQty(id, cart.snapshot().lines.find((line) => line.itemId === id)?.qty + 1 || 1);
  }
  if (dec) {
    const id = dec.dataset.dec;
    const qty = cart.snapshot().lines.find((line) => line.itemId === id)?.qty ?? 0;
    cart.setQty(id, qty - 1);
  }
  if (remove) cart.setQty(remove.dataset.remove, 0);
  if (cat) {
    ui.category = cat.dataset.category;
    refresh();
  }
  if (rate) {
    try {
      await orderApi.rateOrder({ id: rate.dataset.order, score: Number(rate.dataset.rate) });
      ui.walletNotice = 'Thanks — rating saved.';
      refresh();
    } catch (err) {
      window.alert(err.message);
    }
  }
  if (csv && ui.report?.csv) {
    const blob = new Blob([ui.report.csv], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `food-court-${ui.reportFrom}-${ui.reportTo}.csv`;
    link.click();
  }
  if (job) {
    try {
      const result = await orderApi.runAutomations(staffPin(), job.dataset.job);
      ui.settingsRuns = result.runs || [];
      ui.settingsNotice = `${job.dataset.job} finished. Sends stay off until provider keys are set.`;
      ui.settings = null;
      refresh();
    } catch (err) {
      ui.settingsError = err.message;
      refresh();
    }
  }
  if (signOut) {
    await orderApi.signOutStudent();
    ui.wallet = null;
    refresh();
  }
  if (nfc && globalThis.NDEFReader) {
    try {
      const reader = new globalThis.NDEFReader();
      await reader.scan();
      ui.walletNotice = 'Hold the student card to the phone.';
      refresh();
      reader.onreading = async (nfcEvent) => {
        await orderApi.linkNfc({ uid: nfcEvent.serialNumber || '' });
        ui.walletNotice = 'Card linked.';
        refresh();
      };
    } catch (err) {
      ui.walletError = err.message || 'NFC is not available. Use the QR code.';
      refresh();
    }
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
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;

  if (form.id === 'checkout-form') {
    event.preventDefault();
    const data = new FormData(form);
    ui.checkoutForm = {
      customerName: String(data.get('customerName') || ''),
      phone: String(data.get('phone') || ''),
      pickupTime: String(data.get('pickupTime') || ''),
      notes: String(data.get('notes') || ''),
      paymentMethod: String(data.get('paymentMethod') || 'cash'),
    };
    ui.checkoutError = '';
    ui.checkoutPending = true;
    refresh();
    try {
      const snapshot = cart.snapshot();
      const order = await orderApi.createOrder({
        ...ui.checkoutForm,
        items: snapshot.lines.map((line) => ({ itemId: line.itemId, qty: line.qty })),
      });
      if (followPayment(order.payment)) return;
      ui.checkoutPending = false;
      ui.checkoutForm = {};
      ui.board = null;
      root.dataset.page = 'order';
      cart.clear();
      router.go(`/order/${encodeURIComponent(order.id)}`, { replace: true });
    } catch (err) {
      ui.checkoutPending = false;
      ui.checkoutError = err.message || 'Could not place this order.';
      refresh();
    }
    return;
  }

  if (form.id === 'wallet-login') {
    event.preventDefault();
    const data = new FormData(form);
    try {
      await orderApi.signInStudent({
        studentNumber: String(data.get('studentNumber') || ''),
        pin: String(data.get('pin') || ''),
      });
      ui.walletError = '';
      ui.wallet = null;
      refresh();
    } catch (err) {
      ui.walletError = err.message;
      refresh();
    }
    return;
  }

  if (form.id === 'wallet-register') {
    event.preventDefault();
    const data = new FormData(form);
    try {
      await orderApi.registerStudent({
        studentNumber: String(data.get('studentNumber') || ''),
        pin: String(data.get('pin') || ''),
        fullName: String(data.get('fullName') || ''),
        phone: String(data.get('phone') || ''),
        email: String(data.get('email') || ''),
      });
      ui.walletError = '';
      refresh();
    } catch (err) {
      ui.walletError = err.message;
      refresh();
    }
    return;
  }

  if (form.id === 'wallet-email') {
    event.preventDefault();
    const data = new FormData(form);
    const intent = event.submitter?.value || 'verify';
    try {
      if (intent === 'send') {
        const result = await orderApi.requestEmailCode({ email: String(data.get('email') || '') });
        ui.walletNotice = result.message || 'Check your email for a code.';
      } else {
        await orderApi.verifyEmailCode({
          email: String(data.get('email') || ''),
          code: String(data.get('code') || ''),
        });
        ui.walletNotice = '';
      }
      ui.walletError = '';
      refresh();
    } catch (err) {
      ui.walletError = err.message;
      refresh();
    }
    return;
  }

  if (form.id === 'wallet-topup') {
    event.preventDefault();
    const amount = Number(event.submitter?.value || 0);
    try {
      const result = await orderApi.topUp({ amountCents: amount });
      if (followPayment(result.payment)) return;
      ui.walletNotice = result.payment?.demo
        ? 'Demo top-up added. No card was charged.'
        : result.payment?.status === 'pending'
          ? 'Finish the card payment in the window that opened.'
          : 'Top-up paid.';
      ui.wallet = null;
      refresh();
    } catch (err) {
      ui.walletError = err.message;
      refresh();
    }
    return;
  }

  if (form.id === 'wallet-auto') {
    event.preventDefault();
    const data = new FormData(form);
    try {
      await orderApi.setAutoTopup({ enabled: data.get('enabled') === 'on' });
      ui.walletNotice = 'Auto top-up saved.';
      refresh();
    } catch (err) {
      ui.walletError = err.message;
      refresh();
    }
    return;
  }

  if (form.id === 'chef-pin') {
    event.preventDefault();
    const pin = String(new FormData(form).get('pin') || '');
    try {
      await orderApi.verifyChefPin(pin);
      ui.chefUnlocked = true;
      ui.chefError = '';
      try {
        sessionStorage.setItem(CHEF_KEY, pin);
      } catch {
        /* ignore */
      }
      refresh();
    } catch (err) {
      ui.chefError = err.message;
      refresh();
    }
    return;
  }

  if (form.id === 'chef-special') {
    event.preventDefault();
    const data = new FormData(form);
    const file = data.get('photo');
    try {
      const imageUrl = file instanceof File ? await readFile(file) : '';
      let pin = '';
      try {
        pin = sessionStorage.getItem(CHEF_KEY) || '';
      } catch {
        pin = '';
      }
      await orderApi.publishSpecial({ pin, caption: String(data.get('caption') || ''), imageUrl });
      ui.chefNotice = 'Special is live.';
      ui.board = null;
      refresh();
    } catch (err) {
      ui.chefError = err.message;
      refresh();
    }
    return;
  }

  if (form.id === 'staff-pin') {
    event.preventDefault();
    const pin = String(new FormData(form).get('pin') || '');
    try {
      await orderApi.verifyStaffPin(pin);
      rememberStaff(pin);
      ui.report = null;
      ui.stock = null;
      ui.settings = null;
      ui.reportError = '';
      ui.stockError = '';
      ui.settingsError = '';
      refresh();
    } catch (err) {
      ui.reportError = err.message;
      ui.stockError = err.message;
      ui.settingsError = err.message;
      refresh();
    }
    return;
  }

  if (form.id === 'report-range') {
    event.preventDefault();
    const data = new FormData(form);
    ui.reportFrom = String(data.get('from') || sastDate(new Date()));
    ui.reportTo = String(data.get('to') || ui.reportFrom);
    ui.report = null;
    refresh();
    return;
  }

  if (form.id === 'stock-receive' || form.id === 'stock-waste') {
    event.preventDefault();
    const data = new FormData(form);
    const payload = {
      pin: staffPin(),
      ingredientId: String(data.get('ingredientId') || ''),
      qty: Number(data.get('qty')),
      note: String(data.get('note') || ''),
      reason: String(data.get('reason') || ''),
    };
    try {
      if (form.id === 'stock-receive') await orderApi.receiveGoods(payload);
      else await orderApi.logWaste(payload);
      ui.stock = null;
      ui.stockNotice = 'Saved.';
      refresh();
    } catch (err) {
      ui.stockError = err.message;
      refresh();
    }
    return;
  }

  if (form.id === 'stock-take') {
    event.preventDefault();
    const data = new FormData(form);
    const lines = [];
    for (const [key, value] of data.entries()) {
      if (key.startsWith('count_')) lines.push({ ingredientId: key.slice(6), countedQty: Number(value) });
    }
    try {
      await orderApi.saveStockTake({ pin: staffPin(), lines });
      ui.stock = null;
      ui.stockNotice = 'Count saved. Variances are on the movement list.';
      refresh();
    } catch (err) {
      ui.stockError = err.message;
      refresh();
    }
    return;
  }

  if (form.id === 'settings-form') {
    event.preventDefault();
    const data = new FormData(form);
    const patch = {};
    for (const [key, value] of data.entries()) patch[key] = value;
    try {
      ui.settings = await orderApi.saveSettings(staffPin(), patch);
      ui.settingsNotice = 'Settings saved.';
      refresh();
    } catch (err) {
      ui.settingsError = err.message;
      refresh();
    }
  }
});

setInterval(() => {
  const page = root.dataset.page;
  if (page === 'menu') {
    ui.board = null;
    refresh();
  } else if (page === 'counter' || page === 'order') {
    refresh();
  }
}, 8000);

setInterval(() => {
  if (root.dataset.page !== 'wallet' || !ui.wallet?.student) return;
  orderApi.rotatePayToken().then(() => {
    ui.wallet = null;
    refresh();
  }).catch(() => {});
}, 45000);

router.start();
