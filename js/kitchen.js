import { createOrderApi } from './api/client.js';
import { getLocalStorage } from './lib/dom.js';
import { renderKitchenBoard, renderKitchenPin } from './kitchenViews.js';

const PIN_KEY = 'foodcourt.staffPin';
const MUTE_KEY = 'foodcourt.kitchenMute';
const REFRESH_MS = 8000;

const root = document.getElementById('kitchen-app');
const orderApi = createOrderApi({ storage: getLocalStorage() });

const ui = {
  unlocked: false,
  pin: '',
  pinError: '',
  pinPending: false,
  orders: [],
  whatsapp: false,
  demo: false,
  filter: 'all',
  muted: false,
  error: '',
  flash: '',
  knownIds: new Set(),
};

try {
  ui.muted = sessionStorage.getItem(MUTE_KEY) === '1';
} catch {
  /* ignore */
}

function paint() {
  if (!root) return;
  const now = new Date();
  if (!ui.unlocked) {
    root.innerHTML = renderKitchenPin({ error: ui.pinError, pending: ui.pinPending });
    root.querySelector('input[name="pin"]')?.focus();
    return;
  }
  root.innerHTML = renderKitchenBoard({
    orders: ui.orders,
    now,
    whatsapp: ui.whatsapp,
    demo: ui.demo,
    filter: ui.filter,
    muted: ui.muted,
    error: ui.error,
    flash: ui.flash,
  });
}

function beep() {
  if (ui.muted) return;
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.value = 0.06;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.16);
  } catch {
    /* no audio */
  }
}

function rememberPin(pin) {
  ui.pin = pin;
  try {
    sessionStorage.setItem(PIN_KEY, pin);
  } catch {
    /* ignore */
  }
}

function forgetPin() {
  ui.pin = '';
  ui.unlocked = false;
  try {
    sessionStorage.removeItem(PIN_KEY);
  } catch {
    /* ignore */
  }
}

async function refresh({ announce = false } = {}) {
  if (!ui.unlocked) return;
  try {
    const result = await orderApi.listOpenOrders(ui.pin);
    const orders = Array.isArray(result) ? result : result.orders || [];
    if (announce) {
      const newOnes = orders.filter((order) => !ui.knownIds.has(order.id));
      if (ui.knownIds.size && newOnes.length) {
        beep();
        ui.flash = `${newOnes.length} new pre-order${newOnes.length === 1 ? '' : 's'}`;
        setTimeout(() => {
          ui.flash = '';
          paint();
        }, 4000);
      }
    }
    ui.knownIds = new Set(orders.map((order) => order.id));
    ui.orders = orders;
    ui.whatsapp = Boolean(result?.whatsapp);
    ui.demo = Boolean(result?.demo) || orderApi.mode === 'mock';
    ui.error = '';
    paint();
  } catch (err) {
    const message = err.message || 'Could not load orders.';
    if (/pin/i.test(message) || /unauthor/i.test(message)) {
      forgetPin();
      ui.pinError = message;
      paint();
      return;
    }
    ui.error = message;
    paint();
  }
}

async function unlock(pin) {
  ui.pinPending = true;
  ui.pinError = '';
  paint();
  try {
    const result = await orderApi.verifyStaffPin(pin);
    rememberPin(pin);
    ui.unlocked = true;
    ui.pinPending = false;
    ui.whatsapp = Boolean(result?.whatsapp);
    ui.demo = Boolean(result?.demo) || orderApi.mode === 'mock';
    await refresh();
  } catch (err) {
    ui.pinPending = false;
    ui.pinError = err.message || 'Wrong PIN.';
    paint();
  }
}

root?.addEventListener('submit', (event) => {
  if (event.target.id !== 'kitchen-pin-form') return;
  event.preventDefault();
  const pin = String(new FormData(event.target).get('pin') || '').trim();
  unlock(pin);
});

root?.addEventListener('click', async (event) => {
  const lock = event.target.closest('[data-lock]');
  const mute = event.target.closest('[data-mute]');
  const filter = event.target.closest('[data-filter]');
  const advance = event.target.closest('[data-advance]');

  if (lock) {
    forgetPin();
    ui.orders = [];
    paint();
    return;
  }
  if (mute) {
    ui.muted = !ui.muted;
    try {
      sessionStorage.setItem(MUTE_KEY, ui.muted ? '1' : '0');
    } catch {
      /* ignore */
    }
    paint();
    return;
  }
  if (filter) {
    ui.filter = filter.dataset.filter;
    paint();
    return;
  }
  if (advance) {
    const id = advance.dataset.advance;
    const status = advance.dataset.status;
    advance.disabled = true;
    try {
      await orderApi.updateOrderStatus(id, status, ui.pin);
      await refresh();
    } catch (err) {
      ui.error = err.message || 'Could not update that order.';
      paint();
    }
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh({ announce: true });
});

setInterval(() => {
  if (document.visibilityState !== 'hidden') refresh({ announce: true });
}, REFRESH_MS);

setInterval(() => {
  if (ui.unlocked) paint();
}, 30000);

(async function start() {
  let stored = '';
  try {
    stored = sessionStorage.getItem(PIN_KEY) || '';
  } catch {
    /* ignore */
  }
  if (stored) {
    await unlock(stored);
  } else {
    paint();
  }
})();
