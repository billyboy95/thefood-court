import { getMenu, getMenuItem } from '../data/menu.js';
import {
  applyStatus,
  buildOrder,
  cancelOrderRecord,
  DEFAULT_CHEF_PIN,
  DEFAULT_STAFF_PIN,
  formatKitchenWhatsApp,
  pinMatches,
  sortOpenOrders,
} from '../api/orderService.js';
import { getPickupSlots } from '../lib/hours.js';
import { makeOrderId } from '../lib/ids.js';
import { normalizeSaPhone } from '../lib/phone.js';
import { loyaltyLabel, quoteLoyalty, reverseLoyalty } from '../domain/loyalty.js';
import { assertSlotOpen, annotateSlots } from '../domain/slots.js';
import { makePayToken, parsePayPayload, postLedger, tokenUsable } from '../domain/wallet.js';
import { parseSpecialCaption, resolveTodaySpecial } from '../domain/specials.js';
import { createCheckout } from '../domain/payments.js';
import {
  applyPortions,
  applyStockTake,
  deductIngredients,
  isHidden,
  receiveIngredient,
  recipeCostCents,
  reorderSuggestions,
  restoreSale,
  stockValueCents,
  wasteIngredient,
} from '../domain/stock.js';
import { buildFinanceReport, financeToCsv } from '../domain/reports.js';
import { prepForecast } from '../domain/forecast.js';
import {
  planChefNudge,
  planEndOfDay,
  planForecast,
  planLowBalance,
  planNoShows,
  planReconcile,
  planSpecialDeadline,
  planStockAlerts,
  SCHEDULED_JOBS,
} from '../domain/automations.js';
import { mergeSettings } from '../domain/settings.js';
import { sastDate } from '../domain/dates.js';
import { formatLowBalanceWhatsApp, formatRatingAlert, formatReadyWhatsApp, formatSpecialLive } from '../domain/notify.js';
import { buildDemoState } from './seed.js';

const STATE_KEY = 'foodcourt.state.v2';

function emptyState() {
  return {
    version: 1,
    demo: false,
    demoLabel: '',
    students: [],
    ledger: [],
    orders: [],
    payTokens: [],
    specials: [],
    soldOut: {},
    portions: {},
    suppliers: [],
    ingredients: [],
    recipes: [],
    movements: [],
    goodsReceived: [],
    waste: [],
    stockTakes: [],
    settings: mergeSettings({}),
    automationRuns: [],
    notifications: [],
    paymentIntents: [],
    reconciliationFlags: [],
    ratings: [],
    forecasts: [],
    sessionStudentId: null,
    lowBalanceAlerted: [],
    lastWeeklyCsv: '',
  };
}

function nid(prefix, now) {
  return `${prefix}_${makeOrderId(now)}`;
}

function publicStudent(student) {
  if (!student) return null;
  const copy = { ...student };
  delete copy.pin;
  return copy;
}

function readState(storage, { seedDemo, nowFn, settings }) {
  try {
    const raw = storage.getItem(STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1) {
        parsed.settings = mergeSettings(parsed.settings);
        return parsed;
      }
    }
  } catch {
    /* fresh state */
  }
  const state = seedDemo ? buildDemoState(nowFn()) : emptyState();
  if (settings) state.settings = mergeSettings({ ...state.settings, ...settings });
  storage.setItem(STATE_KEY, JSON.stringify(state));
  return state;
}

export function createDemoStore(storage, { nowFn = () => new Date(), staffPin, chefPin, seedDemo = false, settings } = {}) {
  const persist = (state) => storage.setItem(STATE_KEY, JSON.stringify(state));
  const load = () => readState(storage, { seedDemo, nowFn, settings });

  function expectedStaffPin() {
    if (staffPin) return String(staffPin);
    if (typeof globalThis !== 'undefined' && globalThis.FOODCOURT_STAFF_PIN) return String(globalThis.FOODCOURT_STAFF_PIN);
    return DEFAULT_STAFF_PIN;
  }

  function expectedChefPin() {
    if (chefPin) return String(chefPin);
    if (typeof globalThis !== 'undefined' && globalThis.FOODCOURT_CHEF_PIN) return String(globalThis.FOODCOURT_CHEF_PIN);
    return DEFAULT_CHEF_PIN;
  }

  function staffRole(pin) {
    if (pinMatches(pin, expectedStaffPin())) return 'manager';
    const till =
      typeof globalThis !== 'undefined' && globalThis.FOODCOURT_TILL_PIN ? String(globalThis.FOODCOURT_TILL_PIN) : '';
    if (till && pinMatches(pin, till)) return 'till';
    return null;
  }

  function assertStaff(pin, { manager = false } = {}) {
    const role = staffRole(pin);
    if (!role) throw new Error('Wrong PIN.');
    if (manager && role !== 'manager') throw new Error('Manager PIN required.');
    return role;
  }

  function assertChef(pin) {
    if (!pinMatches(pin, expectedChefPin())) throw new Error('Wrong PIN.');
  }

  function logSkip(state, { job, to = '', text = '' }) {
    const now = nowFn().toISOString();
    const reason = 'Provider keys are not set — nothing was sent';
    state.notifications.unshift({
      id: nid('ntf', nowFn()),
      job,
      channel: job === 'weekly-csv' ? 'email' : 'whatsapp',
      to,
      body: text,
      sent: false,
      skipped: true,
      reason,
      createdAt: now,
      demo: Boolean(state.demo),
    });
    state.automationRuns.unshift({
      id: nid('job', nowFn()),
      job,
      status: 'skipped',
      detail: text ? `${reason}. ${text}` : reason,
      createdAt: now,
      demo: Boolean(state.demo),
    });
  }

  function findStudent(state, id) {
    return state.students.find((student) => student.id === id) || null;
  }

  function replaceStudent(state, student) {
    const index = state.students.findIndex((row) => row.id === student.id);
    if (index >= 0) state.students[index] = student;
  }

  function hidden(state, itemId) {
    return isHidden(state.soldOut, state.portions, itemId);
  }

  function applySale(state, order) {
    const deducted = deductIngredients(state.ingredients, state.recipes, order.items, { ref: order.id });
    state.ingredients = deducted.ingredients;
    const now = nowFn().toISOString();
    for (const movement of deducted.movements) {
      state.movements.unshift({ ...movement, id: nid('mov', nowFn()), createdAt: now, demo: Boolean(state.demo) });
    }
    const portions = applyPortions(state.portions, state.soldOut, order.items, state.settings.portionLowThreshold);
    state.portions = portions.portions;
    state.soldOut = portions.soldOut;
    for (const alert of portions.alerts) {
      const item = getMenuItem(alert.itemId);
      logSkip(state, {
        job: alert.kind === 'sold-out' ? 'sold-out' : 'low-stock',
        text: `${item?.name || alert.itemId} ${alert.kind === 'sold-out' ? 'sold out' : 'low'} (${alert.portions} left)`,
      });
    }
  }

  function restoreOrderStock(state, order) {
    const restored = restoreSale(state.ingredients, state.recipes, state.portions, order.items);
    state.ingredients = restored.ingredients;
    state.portions = restored.portions;
    const now = nowFn().toISOString();
    for (const movement of restored.movements) {
      state.movements.unshift({ ...movement, id: nid('mov', nowFn()), createdAt: now, demo: Boolean(state.demo) });
    }
    for (const line of order.items) {
      if (state.portions[line.itemId] > 0) state.soldOut[line.itemId] = false;
    }
  }

  function settleCancel(state, order, { paymentStatus, reason }) {
    const now = nowFn();
    let student = order.studentId ? findStudent(state, order.studentId) : null;
    if (student) {
      student = { ...student, loyaltyStamps: reverseLoyalty(student.loyaltyStamps, order, state.settings.loyaltyTarget) };
    }
    if (paymentStatus === 'refunded' && order.paymentMethod === 'wallet' && order.paymentStatus === 'paid' && student && order.totalCents > 0) {
      const posted = postLedger(student, {
        id: nid('led', now),
        amountCents: order.totalCents,
        kind: 'refund',
        paymentMethod: 'wallet',
        orderId: order.id,
        note: `Refund ${order.orderNumber}`,
        createdAt: now.toISOString(),
        demo: Boolean(state.demo),
      });
      student = posted.student;
      state.ledger.unshift(posted.entry);
    }
    if (student) replaceStudent(state, student);
    if (paymentStatus === 'refunded') restoreOrderStock(state, order);
    if (paymentStatus === 'written_off') {
      const wasted = deductIngredients([], state.recipes, []);
      void wasted;
      for (const line of order.items) {
        const cost = recipeCostCents(state.recipes, state.ingredients, line.itemId);
        if (!cost) continue;
        state.waste.unshift({
          id: nid('wst', now),
          ingredientId: '',
          name: line.name,
          qty: line.qty,
          unit: 'plate',
          costCents: cost * line.qty,
          reason: 'No-show write-off',
          createdAt: now.toISOString(),
          demo: Boolean(state.demo),
        });
      }
    }
    const nextStatus = order.paymentStatus === 'unpaid' && paymentStatus === 'refunded' ? 'unpaid' : paymentStatus;
    return cancelOrderRecord(order, now, { reason, paymentStatus: nextStatus });
  }

  function activeToken(state, studentId, { rotate = false } = {}) {
    const now = nowFn();
    if (!rotate) {
      const row = state.payTokens.find((token) => token.studentId === studentId && tokenUsable(token, now));
      if (row) return row;
    }
    state.payTokens = state.payTokens.filter((token) => token.studentId !== studentId);
    const fresh = makePayToken(studentId, now);
    fresh.demo = Boolean(state.demo);
    state.payTokens.push(fresh);
    return fresh;
  }

  return {
    load,

    getMenu() {
      return getMenu();
    },

    getBoard() {
      const state = load();
      const now = nowFn();
      return {
        demo: Boolean(state.demo),
        demoLabel: state.demoLabel || '',
        soldOut: { ...state.soldOut },
        portions: { ...state.portions },
        specials: state.specials,
        todaySpecial: resolveTodaySpecial({ specials: state.specials, menuItems: getMenu(), now }),
        settings: {
          slotCapacity: state.settings.slotCapacity,
          loyaltyTarget: state.settings.loyaltyTarget,
          lowBalanceCents: state.settings.lowBalanceCents,
        },
      };
    },

    getPickupSlots(now = nowFn()) {
      const state = load();
      return annotateSlots(getPickupSlots(now), state.orders, state.settings.slotCapacity);
    },

    async createOrder(input) {
      const state = load();
      const now = nowFn();
      const slots = annotateSlots(getPickupSlots(now), state.orders, state.settings.slotCapacity);
      const order = buildOrder(input, {
        getMenuItem,
        now,
        source: state.demo ? 'demo' : 'mock',
        isSoldOut: (id) => hidden(state, id),
      });
      assertSlotOpen(slots, order.pickupTime);
      for (const line of order.items) {
        const left = state.portions[line.itemId];
        if (left != null && left < line.qty) throw new Error(`${line.name} is sold out.`);
      }
      order.demo = Boolean(state.demo);
      const studentId = input?.studentId || state.sessionStudentId || null;
      let student = studentId ? findStudent(state, studentId) : null;
      if (student) student = { ...student };
      if (order.paymentMethod === 'wallet' && !student) throw new Error('Sign in to your wallet to pay with credit.');
      if (student) {
        order.studentId = student.id;
        const quote = quoteLoyalty({
          stamps: student.loyaltyStamps,
          lines: order.items,
          target: state.settings.loyaltyTarget,
        });
        order.items = quote.lines;
        order.totalCents = Math.max(0, order.totalCents - quote.discountCents);
        order.discountCents = quote.discountCents;
        order.loyaltyRedeemed = quote.redeem;
        student.loyaltyStamps = quote.stampsAfter;
      }
      if (order.paymentMethod === 'wallet') {
        if (order.totalCents > 0) {
          const posted = postLedger(student, {
            id: nid('led', now),
            amountCents: -order.totalCents,
            kind: 'order',
            paymentMethod: 'wallet',
            orderId: order.id,
            note: order.orderNumber,
            createdAt: now.toISOString(),
            demo: Boolean(state.demo),
          });
          student = posted.student;
          state.ledger.unshift(posted.entry);
        }
        order.paymentStatus = 'paid';
      } else if (order.paymentMethod === 'card') {
        if (order.totalCents > 0) {
          const payment = await createCheckout({ amountCents: order.totalCents, reference: order.id, kind: 'order' });
          state.paymentIntents.unshift({
            ...payment,
            id: nid('pay', now),
            orderId: order.id,
            createdAt: now.toISOString(),
          });
          order.provider = payment.provider;
        }
        order.paymentStatus = 'paid';
      }
      if (student) replaceStudent(state, student);
      applySale(state, order);
      state.orders.unshift(order);
      logSkip(state, { job: 'new-order', text: formatKitchenWhatsApp(order) });
      persist(state);
      return order;
    },

    getOrder(id) {
      const state = load();
      return state.orders.find((order) => order.id === id || order.orderNumber === id) || null;
    },

    verifyStaffPin(pin) {
      const role = assertStaff(pin);
      const state = load();
      return { ok: true, role, whatsapp: false, payments: 'stub', demo: true, sample: Boolean(state.demo), email: false };
    },

    listOpenOrders(pin) {
      assertStaff(pin);
      const state = load();
      return {
        orders: sortOpenOrders(state.orders),
        whatsapp: false,
        demo: true,
        demoLabel: state.demoLabel || 'Saved on this device only.',
        sample: Boolean(state.demo),
        role: staffRole(pin),
        soldOut: state.soldOut,
        portions: state.portions,
        menu: getMenu().map((item) => ({ id: item.id, name: item.name, category: item.category })),
        forecast: state.forecasts,
      };
    },

    updateOrderStatus(id, status, pin) {
      assertStaff(pin);
      const state = load();
      const index = state.orders.findIndex((order) => order.id === id || order.orderNumber === id);
      if (index < 0) return null;
      const updated = applyStatus(state.orders[index], status, nowFn());
      if (updated.status === 'collected' && updated.paymentMethod === 'cash') updated.paymentStatus = 'paid';
      state.orders[index] = updated;
      if (updated.status === 'ready') {
        logSkip(state, { job: 'order-ready', to: updated.phone, text: formatReadyWhatsApp(updated) });
      }
      persist(state);
      return updated;
    },

    cancelOrder(id, pin) {
      assertStaff(pin);
      const state = load();
      const index = state.orders.findIndex((order) => order.id === id || order.orderNumber === id);
      if (index < 0) return null;
      const updated = settleCancel(state, state.orders[index], { paymentStatus: 'refunded', reason: 'kitchen' });
      state.orders[index] = updated;
      logSkip(state, { job: 'refund', text: `${updated.orderNumber} cancelled. Wallet refunds are on the ledger.` });
      persist(state);
      return updated;
    },

    setSoldOut(itemId, soldOut, pin) {
      assertStaff(pin);
      const state = load();
      if (!getMenuItem(itemId)) throw new Error('Unknown menu item.');
      state.soldOut[itemId] = Boolean(soldOut);
      if (soldOut) logSkip(state, { job: 'sold-out', text: `${getMenuItem(itemId).name} marked sold out` });
      persist(state);
      return { itemId, soldOut: Boolean(soldOut) };
    },

    setPortions(itemId, portions, pin) {
      assertStaff(pin);
      const state = load();
      if (!getMenuItem(itemId)) throw new Error('Unknown menu item.');
      const qty = Math.max(0, Math.trunc(Number(portions)));
      if (!Number.isFinite(qty)) throw new Error('Enter a portion count.');
      state.portions[itemId] = qty;
      state.soldOut[itemId] = qty <= 0;
      persist(state);
      return { itemId, portions: qty, soldOut: qty <= 0 };
    },

    currentStudent() {
      const state = load();
      return publicStudent(findStudent(state, state.sessionStudentId));
    },

    signInStudent({ studentNumber, pin }) {
      const state = load();
      const number = String(studentNumber || '').trim();
      const student = state.students.find((row) => row.studentNumber === number);
      if (!student || !pinMatches(String(pin || ''), student.pin)) throw new Error('Student number or PIN is wrong.');
      state.sessionStudentId = student.id;
      persist(state);
      return publicStudent(student);
    },

    registerStudent({ studentNumber, pin, fullName, phone, email }) {
      const state = load();
      const number = String(studentNumber || '').trim();
      if (!/^\d{4,12}$/.test(number)) throw new Error('Enter your student number.');
      if (String(pin || '').trim().length < 4) throw new Error('Choose a PIN of at least 4 digits.');
      const name = String(fullName || '').trim();
      if (name.length < 2) throw new Error('Please enter your name.');
      const normalized = normalizeSaPhone(phone);
      if (!normalized) throw new Error('Enter a valid South African phone number.');
      if (state.students.some((row) => row.studentNumber === number)) throw new Error('That student number already has a wallet.');
      const student = {
        id: nid('stu', nowFn()),
        studentNumber: number,
        pin: String(pin).trim(),
        fullName: name,
        phone: normalized,
        email: String(email || '').trim().toLowerCase(),
        balanceCents: 0,
        loyaltyStamps: 0,
        nfcUid: '',
        autoTopup: false,
        autoTopupCents: state.settings.autoTopupCents,
        demo: Boolean(state.demo),
      };
      state.students.push(student);
      state.sessionStudentId = student.id;
      persist(state);
      return publicStudent(student);
    },

    requestEmailCode({ email }) {
      const state = load();
      const needle = String(email || '').trim().toLowerCase();
      const student = state.students.find((row) => row.email === needle);
      if (!student) throw new Error('No wallet uses that email yet.');
      return {
        demo: true,
        sent: false,
        skipped: true,
        devCode: '000000',
        message: 'Demo mode — no email is sent. Use code 000000.',
      };
    },

    verifyEmailCode({ email, code }) {
      const state = load();
      if (String(code || '').trim() !== '000000') throw new Error('That code is wrong.');
      const needle = String(email || '').trim().toLowerCase();
      const student = state.students.find((row) => row.email === needle);
      if (!student) throw new Error('No wallet uses that email yet.');
      state.sessionStudentId = student.id;
      persist(state);
      return publicStudent(student);
    },

    signOutStudent() {
      const state = load();
      state.sessionStudentId = null;
      persist(state);
      return { ok: true };
    },

    getWallet() {
      const state = load();
      const student = findStudent(state, state.sessionStudentId);
      if (!student) return { student: null, demo: Boolean(state.demo), demoLabel: state.demoLabel || '' };
      const issued = activeToken(state, student.id);
      persist(state);
      const orders = state.orders.filter((order) => order.studentId === student.id);
      const ledger = state.ledger.filter((row) => row.studentId === student.id);
      return {
        demo: Boolean(state.demo),
        demoLabel: state.demoLabel || '',
        student: publicStudent(student),
        orders: orders.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
        ledger: ledger.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
        token: issued,
        lowBalance: student.balanceCents < state.settings.lowBalanceCents,
        loyaltyText: loyaltyLabel(student.loyaltyStamps, state.settings.loyaltyTarget),
        thresholdCents: state.settings.lowBalanceCents,
        loyaltyTarget: state.settings.loyaltyTarget,
        warning: student.balanceCents < state.settings.lowBalanceCents ? formatLowBalanceWhatsApp(student, state.settings.lowBalanceCents) : '',
      };
    },

    rotatePayToken() {
      const state = load();
      const student = findStudent(state, state.sessionStudentId);
      if (!student) throw new Error('Sign in to show your pay code.');
      const token = activeToken(state, student.id, { rotate: true });
      persist(state);
      return token;
    },

    async topUp({ amountCents }) {
      const state = load();
      const student = findStudent(state, state.sessionStudentId);
      if (!student) throw new Error('Sign in to top up.');
      const now = nowFn();
      const reference = nid('top', now);
      const payment = await createCheckout({ amountCents, reference, kind: 'topup' });
      const posted = postLedger(student, {
        id: nid('led', now),
        amountCents: payment.amountCents,
        kind: 'topup',
        paymentMethod: 'card',
        provider: payment.provider,
        providerRef: reference,
        note: state.demo ? 'Demo top-up — no card was charged' : 'Top-up',
        createdAt: now.toISOString(),
        demo: Boolean(state.demo),
      });
      replaceStudent(state, posted.student);
      state.ledger.unshift(posted.entry);
      state.paymentIntents.unshift({ ...payment, id: reference, createdAt: now.toISOString(), demo: Boolean(state.demo) });
      persist(state);
      return { payment, student: publicStudent(posted.student), entry: posted.entry };
    },

    setAutoTopup({ enabled, amountCents }) {
      const state = load();
      const student = findStudent(state, state.sessionStudentId);
      if (!student) throw new Error('Sign in first.');
      student.autoTopup = Boolean(enabled);
      if (amountCents) student.autoTopupCents = Math.trunc(Number(amountCents));
      replaceStudent(state, student);
      persist(state);
      return publicStudent(student);
    },

    linkNfc({ uid, studentNumber, pin, staffPin: tillPin }) {
      const state = load();
      const serial = String(uid || '').trim();
      if (serial.length < 4) throw new Error('Tap the card again so we can read it.');
      let student = null;
      if (tillPin) {
        assertStaff(tillPin);
        student = state.students.find((row) => row.studentNumber === String(studentNumber || '').trim());
        if (!student || !pinMatches(String(pin || ''), student.pin)) throw new Error('Student number or PIN is wrong.');
      } else {
        student = findStudent(state, state.sessionStudentId);
        if (!student) throw new Error('Sign in to link a card.');
      }
      if (state.students.some((row) => row.nfcUid === serial && row.id !== student.id)) {
        throw new Error('That card is already linked to another wallet.');
      }
      student.nfcUid = serial;
      replaceStudent(state, student);
      persist(state);
      return publicStudent(student);
    },

    async tillCharge({ pin, token, studentNumber, studentPin, nfcUid, method = 'wallet', orderId, amountCents }) {
      assertStaff(pin);
      const state = load();
      const now = nowFn();
      let student = null;
      if (token) {
        const code = parsePayPayload(token) || String(token).trim().toUpperCase();
        const row = state.payTokens.find((item) => item.token === code);
        if (!tokenUsable(row, now)) throw new Error('That QR code has expired. Ask for a fresh one.');
        row.consumedAt = now.toISOString();
        student = findStudent(state, row.studentId);
      } else if (nfcUid) {
        student = state.students.find((row) => row.nfcUid && row.nfcUid === String(nfcUid).trim());
        if (!student) throw new Error('That card is not linked to a wallet.');
      } else if (studentNumber) {
        student = state.students.find((row) => row.studentNumber === String(studentNumber).trim());
        if (!student || !pinMatches(String(studentPin || ''), student.pin)) throw new Error('Student number or PIN is wrong.');
      }
      const order = orderId ? state.orders.find((row) => row.id === orderId || row.orderNumber === orderId) : null;
      const amount = order ? order.totalCents : Math.trunc(Number(amountCents));
      if (!Number.isFinite(amount) || amount < 0) throw new Error('Enter an amount to take.');
      if (method === 'wallet') {
        if (!student) throw new Error('Scan a wallet QR, tap a card, or enter a student number and PIN.');
        if (amount > 0) {
          const posted = postLedger(student, {
            id: nid('led', now),
            amountCents: -amount,
            kind: order ? 'order' : 'till',
            paymentMethod: 'wallet',
            orderId: order?.id || null,
            note: order ? order.orderNumber : 'Counter sale',
            createdAt: now.toISOString(),
            demo: Boolean(state.demo),
          });
          replaceStudent(state, posted.student);
          state.ledger.unshift(posted.entry);
        }
        if (order) {
          order.paymentMethod = 'wallet';
          order.paymentStatus = 'paid';
          order.payOnCollection = false;
          order.studentId = student.id;
          order.updatedAt = now.toISOString();
        }
      } else if (method === 'card') {
        if (amount > 0) {
          const payment = await createCheckout({
            amountCents: amount,
            reference: order?.id || nid('till', now),
            kind: 'till',
          });
          state.paymentIntents.unshift({
            ...payment,
            id: nid('pay', now),
            orderId: order?.id || null,
            createdAt: now.toISOString(),
            demo: Boolean(state.demo),
          });
          if (order) order.provider = payment.provider;
        }
        if (order) {
          order.paymentMethod = 'card';
          order.paymentStatus = 'paid';
          order.payOnCollection = false;
          order.updatedAt = now.toISOString();
        }
      } else if (order) {
        order.paymentMethod = 'cash';
        order.paymentStatus = 'paid';
        order.payOnCollection = true;
        order.updatedAt = now.toISOString();
      }
      persist(state);
      return { ok: true, order: order || null, student: publicStudent(student), demo: Boolean(state.demo) };
    },

    verifyChefPin(pin) {
      assertChef(pin);
      const state = load();
      return { ok: true, demo: Boolean(state.demo) || seedDemo };
    },

    publishSpecial({ pin, caption, name, priceCents, imageUrl }) {
      assertChef(pin);
      const state = load();
      const now = nowFn();
      const parsed = caption ? parseSpecialCaption(caption, now) : null;
      if (caption && !parsed) throw new Error('Use a caption like "Monday special: Burgers R55".');
      const specialName = parsed?.name || String(name || '').trim();
      const price = parsed?.priceCents || Math.trunc(Number(priceCents));
      if (specialName.length < 2) throw new Error('Name the special.');
      if (!Number.isFinite(price) || price <= 0) throw new Error('Enter a price in rands.');
      if (!imageUrl) throw new Error('Add a photo of the special.');
      const row = {
        id: nid('spc', now),
        specialDate: parsed?.specialDate || sastDate(now),
        name: specialName,
        priceCents: price,
        dow: parsed?.dow ?? null,
        dayLabel: parsed?.dayLabel || '',
        caption: parsed?.caption || caption || `${specialName} R${price / 100}`,
        imageUrl,
        source: 'chef-page',
        status: 'live',
        demo: Boolean(state.demo),
        itemId: null,
        createdAt: now.toISOString(),
      };
      state.specials = state.specials.filter((special) => special.specialDate !== row.specialDate);
      state.specials.unshift(row);
      logSkip(state, { job: 'special-live', text: formatSpecialLive(row) });
      persist(state);
      return row;
    },

    getSpecials() {
      const state = load();
      const now = nowFn();
      return {
        demo: Boolean(state.demo),
        demoLabel: state.demoLabel || '',
        specials: [...state.specials].sort((a, b) => b.specialDate.localeCompare(a.specialDate)),
        today: resolveTodaySpecial({ specials: state.specials, menuItems: getMenu(), now }),
      };
    },

    listReady() {
      const state = load();
      return {
        demo: Boolean(state.demo),
        demoLabel: state.demoLabel || '',
        orders: state.orders
          .filter((order) => order.status === 'ready')
          .map((order) => ({
            id: order.id,
            orderNumber: order.orderNumber,
            customerName: order.customerName,
            pickupLabel: order.pickupLabel,
            status: order.status,
          })),
      };
    },

    getReport({ pin, from, to }) {
      const role = assertStaff(pin, { manager: true });
      const state = load();
      const report = buildFinanceReport({
        orders: state.orders,
        ledger: state.ledger,
        students: state.students,
        specials: state.specials,
        waste: state.waste,
        ingredients: state.ingredients,
        recipes: state.recipes,
        from,
        to,
        demo: Boolean(state.demo),
      });
      report.demoLabel = state.demoLabel || '';
      report.reconciliation = state.reconciliationFlags;
      report.role = role;
      report.csv = financeToCsv(report);
      return report;
    },

    getStock(pin) {
      assertStaff(pin, { manager: true });
      const state = load();
      return {
        demo: Boolean(state.demo),
        demoLabel: state.demoLabel || '',
        suppliers: state.suppliers,
        ingredients: state.ingredients,
        recipes: state.recipes,
        movements: state.movements.slice(0, 40),
        goodsReceived: state.goodsReceived,
        waste: state.waste,
        stockTakes: state.stockTakes,
        suggestions: reorderSuggestions(state.ingredients).map((row) => ({
          ...row,
          supplierName: state.suppliers.find((supplier) => supplier.id === row.supplierId)?.name || '',
        })),
        stockValueCents: stockValueCents(state.ingredients),
        portions: state.portions,
        menu: getMenu().map((item) => ({ id: item.id, name: item.name })),
      };
    },

    receiveGoods({ pin, ingredientId, qty, note }) {
      assertStaff(pin, { manager: true });
      const state = load();
      const result = receiveIngredient(state.ingredients, { ingredientId, qty, note });
      state.ingredients = result.ingredients;
      const now = nowFn().toISOString();
      state.movements.unshift({ ...result.movement, id: nid('mov', nowFn()), createdAt: now, demo: Boolean(state.demo) });
      state.goodsReceived.unshift({ ...result.receipt, id: nid('grn', nowFn()), name: result.ingredient.name, createdAt: now, demo: Boolean(state.demo) });
      persist(state);
      return result.receipt;
    },

    logWaste({ pin, ingredientId, qty, reason }) {
      assertStaff(pin, { manager: true });
      const state = load();
      const result = wasteIngredient(state.ingredients, { ingredientId, qty, reason });
      state.ingredients = result.ingredients;
      const now = nowFn().toISOString();
      state.movements.unshift({ ...result.movement, id: nid('mov', nowFn()), createdAt: now, demo: Boolean(state.demo) });
      state.waste.unshift({ ...result.waste, id: nid('wst', nowFn()), createdAt: now, demo: Boolean(state.demo) });
      persist(state);
      return result.waste;
    },

    saveStockTake({ pin, lines, note }) {
      assertStaff(pin, { manager: true });
      const state = load();
      const result = applyStockTake(state.ingredients, lines);
      state.ingredients = result.ingredients;
      const now = nowFn().toISOString();
      for (const movement of result.movements) {
        state.movements.unshift({ ...movement, id: nid('mov', nowFn()), createdAt: now, demo: Boolean(state.demo) });
      }
      state.stockTakes.unshift({
        id: nid('stk', nowFn()),
        note: note || '',
        createdAt: now,
        demo: Boolean(state.demo),
        lines: result.variances,
      });
      persist(state);
      return result.variances;
    },

    getSettings(pin) {
      assertStaff(pin, { manager: true });
      const state = load();
      return {
        demo: Boolean(state.demo),
        demoLabel: state.demoLabel || '',
        settings: state.settings,
        providers: { whatsapp: false, email: false, payments: 'stub' },
        runs: state.automationRuns.slice(0, 30),
        jobs: SCHEDULED_JOBS,
      };
    },

    saveSettings(pin, patch) {
      assertStaff(pin, { manager: true });
      const state = load();
      state.settings = mergeSettings({ ...state.settings, ...patch });
      persist(state);
      return state.settings;
    },

    runAutomations(pin, job = 'all') {
      assertStaff(pin, { manager: true });
      const state = load();
      const now = nowFn();
      const jobs = job === 'all' ? SCHEDULED_JOBS : [job];
      const today = sastDate(now);
      const hasSpecial = state.specials.some((row) => row.specialDate === today && row.status !== 'removed');
      for (const name of jobs) {
        if (name === 'low-balance') {
          const due = planLowBalance({
            students: state.students,
            settings: state.settings,
            alertedIds: state.lowBalanceAlerted,
          });
          if (!due.length) {
            state.automationRuns.unshift({
              id: nid('job', now),
              job: name,
              status: 'ok',
              detail: 'No wallets under the threshold.',
              createdAt: now.toISOString(),
              demo: Boolean(state.demo),
            });
          }
          for (const action of due) {
            logSkip(state, { job: name, to: action.to, text: action.text });
            state.lowBalanceAlerted.push(action.studentId);
            if (action.autoTopup) {
              const student = findStudent(state, action.studentId);
              const posted = postLedger(student, {
                id: nid('led', now),
                amountCents: action.autoTopupCents,
                kind: 'topup',
                paymentMethod: 'card',
                provider: 'stub',
                note: 'Demo auto top-up — no card was charged',
                createdAt: now.toISOString(),
                demo: true,
              });
              replaceStudent(state, posted.student);
              state.ledger.unshift(posted.entry);
            }
          }
        } else if (name === 'no-show') {
          const actions = planNoShows({ orders: state.orders, now, settings: state.settings });
          if (!actions.length) {
            state.automationRuns.unshift({
              id: nid('job', now),
              job: name,
              status: 'ok',
              detail: 'No uncollected orders past the reminder window.',
              createdAt: now.toISOString(),
              demo: Boolean(state.demo),
            });
          }
          for (const action of actions) {
            const index = state.orders.findIndex((order) => order.id === action.orderId);
            if (index < 0) continue;
            if (action.type === 'no-show-reminder') {
              state.orders[index].reminderSentAt = now.toISOString();
              logSkip(state, { job: name, to: action.to, text: action.text });
            } else if (action.type === 'refund') {
              state.orders[index] = settleCancel(state, state.orders[index], { paymentStatus: 'refunded', reason: 'no-show' });
              state.orders[index].noShowActionTakenAt = now.toISOString();
              logSkip(state, { job: name, text: `${state.orders[index].orderNumber} auto-refunded (no-show).` });
            } else if (action.type === 'write-off') {
              state.orders[index] = settleCancel(state, state.orders[index], { paymentStatus: 'written_off', reason: 'no-show' });
              state.orders[index].noShowActionTakenAt = now.toISOString();
              logSkip(state, { job: name, text: `${state.orders[index].orderNumber} written off (no-show).` });
            }
          }
        } else if (name === 'chef-nudge') {
          const plan = planChefNudge({ now, settings: state.settings, hasSpecialToday: hasSpecial });
          logSkip(state, { job: name, to: plan.to, text: plan.text });
        } else if (name === 'special-deadline') {
          const plan = planSpecialDeadline({ hasSpecialToday: hasSpecial });
          state.automationRuns.unshift({
            id: nid('job', now),
            job: name,
            status: 'ok',
            detail: plan.detail,
            createdAt: now.toISOString(),
            demo: Boolean(state.demo),
          });
        } else if (name === 'stock') {
          const actions = planStockAlerts({
            ingredients: state.ingredients,
            menu: getMenu(),
            portions: state.portions,
            soldOut: state.soldOut,
            lowThreshold: state.settings.portionLowThreshold,
          });
          for (const action of actions) {
            if (action.type === 'auto-sold-out') state.soldOut[action.itemId] = true;
            logSkip(state, { job: name, text: action.text });
          }
          if (!actions.length) {
            state.automationRuns.unshift({
              id: nid('job', now),
              job: name,
              status: 'ok',
              detail: 'No low-stock alerts.',
              createdAt: now.toISOString(),
              demo: Boolean(state.demo),
            });
          }
        } else if (name === 'eod') {
          const plan = planEndOfDay({
            orders: state.orders,
            ledger: state.ledger,
            students: state.students,
            specials: state.specials,
            waste: state.waste,
            ingredients: state.ingredients,
            recipes: state.recipes,
            now,
            demo: state.demo,
          });
          logSkip(state, { job: name, to: state.settings.managerWhatsapp, text: plan.text });
        } else if (name === 'weekly-csv') {
          const from = sastDate(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000));
          const report = buildFinanceReport({
            orders: state.orders,
            ledger: state.ledger,
            students: state.students,
            specials: state.specials,
            waste: state.waste,
            ingredients: state.ingredients,
            recipes: state.recipes,
            from,
            to: today,
            demo: state.demo,
          });
          state.lastWeeklyCsv = financeToCsv(report);
          logSkip(state, {
            job: name,
            to: state.settings.reportsEmail,
            text: `Weekly CSV ${from} to ${today} is ready. Email was not sent.`,
          });
        } else if (name === 'forecast') {
          const plan = planForecast({ menu: getMenu(), orders: state.orders, now });
          state.forecasts = plan.rows;
          state.automationRuns.unshift({
            id: nid('job', now),
            job: name,
            status: 'ok',
            detail: `Prep list has ${plan.rows.length} items.`,
            createdAt: now.toISOString(),
            demo: Boolean(state.demo),
          });
        } else if (name === 'reconcile') {
          const plan = planReconcile({
            localPayments: state.paymentIntents.filter((row) => row.status === 'paid'),
            remote: null,
          });
          state.automationRuns.unshift({
            id: nid('job', now),
            job: name,
            status: 'skipped',
            detail: plan.reason || 'Provider keys are not set',
            createdAt: now.toISOString(),
            demo: Boolean(state.demo),
          });
        }
      }
      persist(state);
      return { ok: true, runs: state.automationRuns.slice(0, 15), forecast: state.forecasts };
    },

    rateOrder({ id, score }) {
      const state = load();
      const order = state.orders.find((row) => row.id === id || row.orderNumber === id);
      if (!order) throw new Error('Order not found.');
      if (order.status !== 'ready' && order.status !== 'collected') {
        throw new Error('You can rate this once it is ready for collection.');
      }
      const value = Math.trunc(Number(score));
      if (value < 1 || value > 5) throw new Error('Choose a score from 1 to 5.');
      if (state.ratings.some((row) => row.orderId === order.id)) throw new Error('This order is already rated.');
      const rating = {
        id: nid('rat', nowFn()),
        orderId: order.id,
        score: value,
        createdAt: nowFn().toISOString(),
        demo: Boolean(state.demo),
      };
      state.ratings.push(rating);
      if (value <= state.settings.ratingAlertMax) {
        logSkip(state, { job: 'rating', to: state.settings.managerWhatsapp, text: formatRatingAlert(order, value) });
      }
      persist(state);
      return rating;
    },

    getForecast(pin) {
      assertStaff(pin);
      const state = load();
      const rows = state.forecasts.length ? state.forecasts : prepForecast({ menu: getMenu(), orders: state.orders, now: nowFn() });
      return { demo: Boolean(state.demo), rows };
    },
  };
}
