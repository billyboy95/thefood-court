import { getMenuItem } from '../data/menu.js';
import { addCivilDays, formatMins, partsInTZ, zonedDate } from '../lib/hours.js';
import { makeOrderNumber } from '../lib/ids.js';
import { sastDate } from '../domain/dates.js';
import { mergeSettings } from '../domain/settings.js';

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t ^ (t >>> 7)) ^ Math.imul(t, 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROTATION = ['wallet', 'card', 'cash'];
const CORE_ITEMS = ['eggs-toast', 'beef-stew', 'chicken-stew', 'campus-burger', 'chips', 'juice', 'coffee-tea', 'chicken-2pc', 'veg-curry'];

const STUDENTS = [
  {
    id: 'stu_thabo',
    studentNumber: '20240001',
    pin: '1234',
    fullName: 'Thabo Mokoena',
    phone: '+27821234567',
    email: 'thabo@eastc.test',
    balanceCents: 0,
    loyaltyStamps: 7,
    nfcUid: '04:DE:MO:TH:AB:01',
    autoTopup: false,
    autoTopupCents: 10000,
    demo: true,
  },
  {
    id: 'stu_lerato',
    studentNumber: '20240002',
    pin: '1234',
    fullName: 'Lerato Nkosi',
    phone: '+27829876543',
    email: 'lerato@eastc.test',
    balanceCents: 0,
    loyaltyStamps: 9,
    nfcUid: '04:DE:MO:LE:RA:02',
    autoTopup: false,
    autoTopupCents: 10000,
    demo: true,
  },
  {
    id: 'stu_amahle',
    studentNumber: '20240003',
    pin: '1234',
    fullName: 'Amahle Dlamini',
    phone: '+27761112233',
    email: 'amahle@eastc.test',
    balanceCents: 0,
    loyaltyStamps: 2,
    nfcUid: '',
    autoTopup: false,
    autoTopupCents: 5000,
    demo: true,
  },
];

const DESIRED_BALANCE = {
  stu_thabo: 18000,
  stu_lerato: 3500,
  stu_amahle: 0,
};

function lineFor(itemId, qty) {
  const item = getMenuItem(itemId);
  return {
    itemId,
    name: item.name,
    qty,
    unitPriceCents: item.priceCents,
    lineTotalCents: item.priceCents * qty,
  };
}

/**
 * Sample history for demo mode. Every row is flagged demo.
 * Stock on hand is a snapshot, not a replay of every past plate.
 */
export function buildDemoState(now = new Date()) {
  const rand = mulberry32(20261022);
  const todayParts = partsInTZ(now);
  const today = sastDate(now);
  const students = STUDENTS.map((student) => ({ ...student }));
  const orders = [];
  let seq = 0;
  let openToday = 0;
  let walletRefundsLeft = 1;
  let writeOffsLeft = 1;

  for (let ago = 20; ago >= 0; ago -= 1) {
    const day = ago === 0 ? todayParts : addCivilDays(todayParts, -ago);
    if (day.dow === 0) continue;
    const dayIso = `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
    const count = 2 + Math.floor(rand() * 2);
    for (let n = 0; n < count; n += 1) {
      const hour = [8, 10, 12, 14][n % 4];
      const minute = n % 2 === 0 ? 0 : 30;
      const when = zonedDate(day.year, day.month, day.day, hour, minute);
      const student = students[seq % students.length];
      const paymentMethod = ROTATION[seq % ROTATION.length];
      const itemId = day.dow === 6 && rand() > 0.7 ? 'full-brunch' : CORE_ITEMS[Math.floor(rand() * CORE_ITEMS.length)];
      const qty = rand() > 0.8 ? 2 : 1;
      const extraId = rand() > 0.55 ? 'juice' : null;
      const items = [lineFor(itemId, qty)];
      if (extraId && extraId !== itemId) items.push(lineFor(extraId, 1));
      const totalCents = items.reduce((sum, line) => sum + line.lineTotalCents, 0);
      let status = 'collected';
      let paymentStatus = 'paid';
      let cancelReason = null;
      if (dayIso === today && openToday < 3) {
        status = ['received', 'preparing', 'ready'][openToday];
        paymentStatus = paymentMethod === 'cash' ? 'unpaid' : 'paid';
        openToday += 1;
      } else if (dayIso < today && paymentMethod === 'wallet' && walletRefundsLeft) {
        status = 'cancelled';
        paymentStatus = 'refunded';
        cancelReason = 'kitchen';
        walletRefundsLeft -= 1;
      } else if (dayIso < today && paymentMethod === 'cash' && writeOffsLeft) {
        status = 'cancelled';
        paymentStatus = 'written_off';
        cancelReason = 'no-show';
        writeOffsLeft -= 1;
      }
      const created = new Date(when.getTime() - 20 * 60 * 1000);
      orders.push({
        id: `ord_demo_${seq}`,
        orderNumber: makeOrderNumber(created, rand),
        status,
        customerName: student.fullName,
        phone: student.phone,
        pickupTime: when.toISOString(),
        pickupLabel: formatMins(hour * 60 + minute),
        notes: seq % 11 === 0 ? 'No chilli' : '',
        items,
        itemCount: items.reduce((sum, line) => sum + line.qty, 0),
        totalCents,
        paymentMethod,
        paymentStatus,
        payOnCollection: paymentMethod === 'cash',
        studentId: student.id,
        loyaltyRedeemed: false,
        discountCents: 0,
        reminderSentAt: null,
        noShowActionTakenAt: cancelReason === 'no-show' ? created.toISOString() : null,
        cancelReason,
        provider: paymentMethod === 'card' ? 'stub' : null,
        demo: true,
        source: 'demo',
        createdAt: created.toISOString(),
        updatedAt: when.toISOString(),
      });
      seq += 1;
    }
  }

  const ledger = [];
  const opened = orders[0]?.createdAt || now.toISOString();
  for (const student of students) {
    const mine = orders.filter((order) => order.studentId === student.id && order.paymentMethod === 'wallet');
    const spent = mine.filter((order) => order.paymentStatus === 'paid');
    const refunded = mine.filter((order) => order.paymentStatus === 'refunded');
    const spend = spent.reduce((sum, order) => sum + order.totalCents, 0);
    const topup = DESIRED_BALANCE[student.id] + spend;
    const events = [{ at: opened, kind: 'topup', amount: topup, order: null, id: `led_${student.id}_topup` }];
    for (const order of [...spent, ...refunded]) {
      events.push({ at: order.createdAt, kind: 'order', amount: -order.totalCents, order, id: `led_${order.id}` });
      if (order.paymentStatus === 'refunded') {
        events.push({
          at: order.updatedAt,
          kind: 'refund',
          amount: order.totalCents,
          order,
          id: `led_${order.id}_refund`,
        });
      }
    }
    events.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
    let balance = 0;
    for (const event of events) {
      balance += event.amount;
      ledger.push({
        id: event.id,
        studentId: student.id,
        amountCents: event.amount,
        balanceAfterCents: balance,
        kind: event.kind,
        paymentMethod: event.kind === 'topup' ? 'card' : 'wallet',
        orderId: event.order?.id || null,
        provider: event.kind === 'topup' ? 'stub' : null,
        providerRef: event.kind === 'topup' ? `demo-topup-${student.studentNumber}` : null,
        note: event.order ? `${event.kind === 'refund' ? 'Refund ' : ''}${event.order.orderNumber}` : 'Demo top-up',
        createdAt: event.at,
        demo: true,
      });
    }
    student.balanceCents = balance;
  }

  function special(ago, name, priceCents, image, itemId) {
    const day = ago === 0 ? todayParts : addCivilDays(todayParts, -ago);
    const specialDate = `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return {
      id: `spc_${ago}_${itemId}`,
      specialDate,
      name,
      priceCents,
      dow: day.dow,
      dayLabel: names[day.dow],
      caption: `${names[day.dow]} special: ${name} R${priceCents / 100}`,
      imageUrl: image,
      source: ago === 0 ? 'whatsapp' : 'chef-page',
      status: 'live',
      demo: true,
      itemId,
      createdAt: zonedDate(day.year, day.month, day.day, 8, 5).toISOString(),
    };
  }

  const specials = [
    special(0, 'Campus burger & chips', 6900, '/assets/food/burger.jpg', 'campus-burger'),
    special(2, 'Chips', 3000, '/assets/food/chips.jpg', 'chips'),
    special(6, 'Beef stew & pap', 7200, '/assets/food/beef-stew.jpg', 'beef-stew'),
  ];

  const suppliers = [
    { id: 'sup_metro', name: 'Metro Foods', phone: '011 555 0101', email: 'orders@metrofoods.example', demo: true },
    { id: 'sup_fresh', name: 'Fresh Campus', phone: '011 555 0144', email: 'hello@freshcampus.example', demo: true },
  ];

  const ingredients = [
    { id: 'ing_beef', name: 'Beef stew portion', unit: 'portion', costCents: 2800, onHand: 40, reorderLevel: 12, supplierId: 'sup_metro', demo: true },
    { id: 'ing_chicken', name: 'Chicken pieces', unit: 'piece', costCents: 1800, onHand: 36, reorderLevel: 24, supplierId: 'sup_metro', demo: true },
    { id: 'ing_chips', name: 'Chips', unit: 'portion', costCents: 800, onHand: 8, reorderLevel: 15, supplierId: 'sup_fresh', demo: true },
    { id: 'ing_bun', name: 'Burger bun', unit: 'each', costCents: 400, onHand: 24, reorderLevel: 16, supplierId: 'sup_fresh', demo: true },
    { id: 'ing_pap', name: 'Pap', unit: 'portion', costCents: 300, onHand: 50, reorderLevel: 10, supplierId: 'sup_metro', demo: true },
    { id: 'ing_juice', name: 'Juice', unit: 'carton', costCents: 900, onHand: 18, reorderLevel: 12, supplierId: 'sup_fresh', demo: true },
    { id: 'ing_coffee', name: 'Coffee', unit: 'cup', costCents: 400, onHand: 40, reorderLevel: 10, supplierId: 'sup_metro', demo: true },
    { id: 'ing_salad', name: 'Salad mix', unit: 'box', costCents: 1500, onHand: 0, reorderLevel: 6, supplierId: 'sup_fresh', demo: true },
  ];

  const recipes = [
    { menuItemId: 'campus-burger', ingredientId: 'ing_bun', qty: 1 },
    { menuItemId: 'campus-burger', ingredientId: 'ing_chips', qty: 1 },
    { menuItemId: 'chips', ingredientId: 'ing_chips', qty: 1 },
    { menuItemId: 'beef-stew', ingredientId: 'ing_beef', qty: 1 },
    { menuItemId: 'beef-stew', ingredientId: 'ing_pap', qty: 1 },
    { menuItemId: 'juice', ingredientId: 'ing_juice', qty: 1 },
    { menuItemId: 'coffee-tea', ingredientId: 'ing_coffee', qty: 1 },
    { menuItemId: 'chicken-2pc', ingredientId: 'ing_chicken', qty: 2 },
    { menuItemId: 'salad-box', ingredientId: 'ing_salad', qty: 1 },
  ];

  const yesterday = addCivilDays(todayParts, todayParts.dow === 1 ? -3 : -1);
  const yIso = zonedDate(yesterday.year, yesterday.month, yesterday.day, 16, 0).toISOString();

  return {
    version: 1,
    demo: true,
    demoLabel: 'Sample demo data — not live sales',
    students,
    ledger,
    orders,
    payTokens: [],
    specials,
    soldOut: { 'salad-box': true },
    portions: { 'salad-box': 0, juice: 4, 'campus-burger': 20 },
    suppliers,
    ingredients,
    recipes,
    movements: [
      {
        id: 'mov_demo_receive',
        ingredientId: 'ing_beef',
        qtyDelta: 10,
        reason: 'receive',
        note: 'Demo delivery',
        createdAt: yIso,
        demo: true,
      },
    ],
    goodsReceived: [
      {
        id: 'grn_demo',
        ingredientId: 'ing_beef',
        name: 'Beef stew portion',
        qty: 10,
        costCents: 28000,
        note: 'Demo delivery',
        createdAt: yIso,
        demo: true,
      },
    ],
    waste: [
      {
        id: 'wst_demo',
        ingredientId: 'ing_salad',
        name: 'Salad mix',
        qty: 2,
        unit: 'box',
        costCents: 3000,
        reason: 'Wilted — demo sample',
        createdAt: yIso,
        demo: true,
      },
    ],
    stockTakes: [
      {
        id: 'stk_demo',
        note: 'Demo count',
        createdAt: yIso,
        demo: true,
        lines: [{ ingredientId: 'ing_chips', name: 'Chips', expectedQty: 10, countedQty: 8, variance: -2 }],
      },
    ],
    settings: mergeSettings({}),
    automationRuns: [
      {
        id: 'job_demo_nudge',
        job: 'chef-nudge',
        status: 'skipped',
        detail: 'Demo sample — WhatsApp keys unset. Would remind the chef to send today\'s special.',
        createdAt: now.toISOString(),
        demo: true,
      },
      {
        id: 'job_demo_balance',
        job: 'low-balance',
        status: 'skipped',
        detail: 'Demo sample — would WhatsApp students under R50. No message sent.',
        createdAt: now.toISOString(),
        demo: true,
      },
      {
        id: 'job_demo_recon',
        job: 'reconcile',
        status: 'flagged',
        detail: 'Demo sample — 1 Yoco amount mismatch flagged. Not a live payment.',
        createdAt: now.toISOString(),
        demo: true,
      },
    ],
    notifications: [],
    paymentIntents: orders
      .filter((order) => order.paymentMethod === 'card' && order.paymentStatus === 'paid')
      .slice(0, 8)
      .map((order) => ({
        id: `pay_${order.id}`,
        provider: 'stub',
        reference: order.id,
        amountCents: order.totalCents,
        status: 'paid',
        kind: 'order',
        orderId: order.id,
        demo: true,
        createdAt: order.createdAt,
      })),
    reconciliationFlags: [
      {
        id: 'rec_demo',
        reference: 'demo-yoco-mismatch',
        kind: 'amount',
        localCents: 6900,
        providerCents: 6800,
        provider: 'yoco',
        detail: 'Sample demo mismatch — not a live payment',
        createdAt: now.toISOString(),
        demo: true,
      },
    ],
    ratings: [],
    forecasts: [],
    sessionStudentId: null,
    lowBalanceAlerted: [],
  };
}
