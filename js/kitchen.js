import { createOrderApi } from './api/client.js';
import { followPayment } from './lib/payRedirect.js';
import { getLocalStorage } from './lib/dom.js';
import { renderKitchenBoard, renderKitchenPin } from './kitchenViews.js';

const PIN_KEY = 'foodcourt.staffPin';
const MUTE_KEY = 'foodcourt.kitchenMute';
const REFRESH_MS = 8000;

const orderApi = createOrderApi({ storage: getLocalStorage() });

const ui = {
  unlocked: false,
  pin: '',
  pinError: '',
  pinPending: false,
  orders: [],
  whatsapp: false,
  demo: false,
  demoLabel: '',
  menu: [],
  soldOut: {},
  portions: {},
  forecast: [],
  filter: 'all',
  muted: false,
  error: '',
  flash: '',
  knownIds: new Set(),
};

let root = null;
let started = false;

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
    demo: ui.demo,
    filter: ui.filter,
    muted: ui.muted,
    error: ui.error,
    flash: ui.flash,
    demoLabel: ui.demoLabel,
    menu: ui.menu,
    soldOut: ui.soldOut,
    portions: ui.portions,
    forecast: ui.forecast,
    nfc: typeof globalThis.NDEFReader === 'function',
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

function onKitchenPage() {
  return Boolean(root) && (root.id === 'kitchen-app' || root.dataset.page === 'kitchen');
}

async function refresh({ announce = false } = {}) {
  if (!ui.unlocked || !onKitchenPage()) return;
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
    ui.demoLabel = result?.demoLabel || '';
    ui.menu = result?.menu || ui.menu;
    ui.soldOut = result?.soldOut || {};
    ui.portions = result?.portions || {};
    ui.forecast = result?.forecast || [];
    if (!ui.forecast.length && orderApi.getForecast) {
      try {
        const forecast = await orderApi.getForecast(ui.pin);
        ui.forecast = forecast.rows || [];
      } catch {
        /* forecast is optional on the board */
      }
    }
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

function eventEl(event) {
  const t = event.target;
  return t instanceof Element ? t : t?.parentElement;
}

let scanStop = null;

async function startScan() {
  const video = root?.querySelector('[data-video]');
  if (!video || !navigator.mediaDevices?.getUserMedia) {
    ui.error = 'This browser has no camera. Type the code or the student number.';
    paint();
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  video.hidden = false;
  video.srcObject = stream;
  await video.play();
  const Detector = globalThis.BarcodeDetector;
  if (!Detector) {
    ui.flash = 'Camera is on, but QR scanning needs Chrome. Type the FC1 code.';
    scanStop = () => stream.getTracks().forEach((track) => track.stop());
    paint();
    const again = root?.querySelector('[data-video]');
    if (again) {
      again.hidden = false;
      again.srcObject = stream;
    }
    return;
  }
  const detector = new Detector({ formats: ['qr_code'] });
  let stopped = false;
  scanStop = () => {
    stopped = true;
    stream.getTracks().forEach((track) => track.stop());
  };
  const tick = async () => {
    if (stopped) return;
    try {
      const codes = await detector.detect(video);
      const raw = codes[0]?.rawValue;
      if (raw) {
        const input = root.querySelector('input[name="token"]');
        if (input) input.value = raw;
        scanStop();
        ui.flash = 'QR read. Confirm the till payment.';
        paint();
        return;
      }
    } catch {
      /* next frame */
    }
    if (!stopped) requestAnimationFrame(tick);
  };
  tick();
}

async function startNfc() {
  if (!globalThis.NDEFReader) {
    ui.error = 'NFC is not available. Use the QR code.';
    paint();
    return;
  }
  try {
    const reader = new globalThis.NDEFReader();
    await reader.scan();
    ui.flash = 'Hold the student card to the till.';
    paint();
    reader.onreading = async (event) => {
      try {
        const form = root.querySelector('#till-form');
        const data = form ? new FormData(form) : new FormData();
        await orderApi.tillCharge({
          pin: ui.pin,
          method: 'wallet',
          nfcUid: event.serialNumber || '',
          orderId: String(data.get('orderId') || ''),
          amountCents: Number(data.get('amountCents') || 0),
        });
        ui.flash = 'Card tapped.';
        await refresh();
      } catch (err) {
        ui.error = err.message;
        paint();
      }
    };
  } catch (err) {
    ui.error = err.message || 'NFC was blocked.';
    paint();
  }
}

function bind() {
  document.addEventListener('submit', (event) => {
    if (!onKitchenPage() || event.target.id !== 'kitchen-pin-form') return;
    event.preventDefault();
    const pin = String(new FormData(event.target).get('pin') || '').trim();
    unlock(pin);
  });

  document.addEventListener('click', async (event) => {
    if (!onKitchenPage()) return;
    const t = eventEl(event);
    if (!t) return;
    const lock = t.closest('[data-lock]');
    const mute = t.closest('[data-mute]');
    const filter = t.closest('button[data-filter]');
    const advance = t.closest('[data-advance]');
    const cancel = t.closest('[data-cancel]');
    const sold = t.closest('[data-soldout]');
    const scan = t.closest('[data-scan]');
    const nfc = t.closest('[data-nfc]');

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
    if (cancel) {
      cancel.disabled = true;
      try {
        await orderApi.cancelOrder(cancel.dataset.cancel, ui.pin);
        await refresh();
      } catch (err) {
        ui.error = err.message || 'Could not cancel that order.';
        paint();
      }
    }
    if (sold) {
      try {
        await orderApi.setSoldOut(sold.dataset.soldout, sold.dataset.sold !== '1', ui.pin);
        await refresh();
      } catch (err) {
        ui.error = err.message || 'Could not update that item.';
        paint();
      }
    }
    if (scan) startScan();
    if (nfc) startNfc();
  });

  document.addEventListener('submit', async (event) => {
    if (!onKitchenPage() || event.target.id !== 'till-form') return;
    event.preventDefault();
    const data = new FormData(event.target);
    const method = event.submitter?.value || 'wallet';
    try {
      const result = await orderApi.tillCharge({
        pin: ui.pin,
        method,
        orderId: String(data.get('orderId') || ''),
        amountCents: Number(data.get('amountCents') || 0),
        studentNumber: String(data.get('studentNumber') || ''),
        studentPin: String(data.get('studentPin') || ''),
        token: String(data.get('token') || ''),
      });
      if (followPayment(result.payment)) return;
      ui.flash = result.demo ? 'Demo till payment recorded. No provider was charged.' : 'Payment taken.';
      await refresh();
    } catch (err) {
      ui.error = err.message || 'Till payment failed.';
      paint();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh({ announce: true });
  });

  setInterval(() => {
    if (document.visibilityState !== 'hidden') refresh({ announce: true });
  }, REFRESH_MS);

  setInterval(() => {
    if (ui.unlocked && onKitchenPage()) paint();
  }, 30000);
}

export async function startKitchen(mount) {
  root = mount;
  if (!root) return;
  if (!started) {
    started = true;
    bind();
  }
  let stored = '';
  try {
    stored = sessionStorage.getItem(PIN_KEY) || '';
  } catch {
    /* ignore */
  }
  if (stored) await unlock(stored);
  else paint();
}

const standalone = document.getElementById('kitchen-app');
if (standalone) startKitchen(standalone);
