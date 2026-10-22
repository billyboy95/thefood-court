import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { md5 } from '../js/domain/md5.js';
import { postLedger, parsePayPayload, makePayToken, tokenUsable } from '../js/domain/wallet.js';
import { quoteLoyalty, reverseLoyalty } from '../js/domain/loyalty.js';
import { assertSlotOpen, annotateSlots, nextFreeSlot } from '../js/domain/slots.js';
import { parseSpecialCaption, resolveTodaySpecial } from '../js/domain/specials.js';
import { createCheckout, payfastSignature, selectPaymentProvider } from '../js/domain/payments.js';
import { sendWhatsApp } from '../js/domain/notify.js';
import { sendEmail } from '../js/domain/email.js';
import { buildFinanceReport, financeToCsv } from '../js/domain/reports.js';
import { applyStockTake, deductIngredients, reorderSuggestions } from '../js/domain/stock.js';
import { planLowBalance, planNoShows, planSpecialDeadline } from '../js/domain/automations.js';
import { reconcilePayments } from '../js/domain/reconcile.js';
import { paymentHandoff } from '../js/lib/payRedirect.js';
import { mergeSettings } from '../js/domain/settings.js';

describe('wallet and loyalty', () => {
  it('rejects a debit that would go negative', () => {
    assert.throws(
      () => postLedger({ balanceCents: 100 }, { amountCents: -250, kind: 'order', id: 'a', createdAt: '2026-10-22T10:00:00.000Z' }),
      /Insufficient wallet balance/,
    );
  });

  it('makes the 10th meal one free unit of the dearest line', () => {
    const quote = quoteLoyalty({
      stamps: 9,
      target: 10,
      lines: [
        { itemId: 'juice', unitPriceCents: 2000, lineTotalCents: 2000, qty: 1 },
        { itemId: 'campus-burger', unitPriceCents: 6900, lineTotalCents: 6900, qty: 1 },
      ],
    });
    assert.equal(quote.redeem, true);
    assert.equal(quote.discountCents, 6900);
    assert.equal(quote.stampsAfter, 0);
    assert.equal(quote.lines[1].lineTotalCents, 0);
    assert.equal(reverseLoyalty(0, { loyaltyRedeemed: true }, 10), 9);
  });

  it('builds a short-lived FC1 pay code', () => {
    const token = makePayToken('stu', new Date('2026-10-22T10:00:00.000Z'), { random: () => 0 });
    assert.match(token.payload, /^FC1\./);
    assert.equal(parsePayPayload(token.payload), token.token);
    assert.equal(tokenUsable(token, new Date('2026-10-22T10:00:30.000Z')), true);
    assert.equal(tokenUsable(token, new Date('2026-10-22T10:01:00.000Z')), false);
  });
});

describe('slots, specials, providers', () => {
  it('closes a full slot and names the next free one', () => {
    const slots = [
      { iso: 'a', label: '12:00' },
      { iso: 'b', label: '12:15' },
    ];
    const orders = Array.from({ length: 2 }, () => ({ pickupTime: 'a', status: 'received' }));
    const annotated = annotateSlots(slots, orders, 2);
    assert.equal(annotated[0].full, true);
    assert.equal(nextFreeSlot(annotated).label, '12:15');
    assert.throws(() => assertSlotOpen(annotated, 'a'), /Next free slot is 12:15/);
  });

  it('parses a chef caption and keeps the printed special when none is published', () => {
    const parsed = parseSpecialCaption('Monday special: Burgers R55', new Date('2026-10-19T08:00:00.000Z'));
    assert.equal(parsed.name, 'Burgers');
    assert.equal(parsed.priceCents, 5500);
    const board = resolveTodaySpecial({
      specials: [],
      menuItems: [{ id: 'beef-stew', name: 'Beef stew & pap', specialOn: [1] }],
      now: new Date('2026-10-19T08:00:00.000Z'),
    });
    assert.equal(board.source, 'menu');
    assert.equal(board.menuFallback[0].id, 'beef-stew');
  });

  it('does not call providers when keys are unset', async () => {
    assert.equal(selectPaymentProvider({}), 'stub');
    const payment = await createCheckout({ amountCents: 5000, reference: 'top', kind: 'topup', fetchImpl: () => { throw new Error('network'); } });
    assert.equal(payment.status, 'paid');
    assert.equal(payment.demo, true);
    const whatsapp = await sendWhatsApp({ to: '+27821234567', text: 'hello', fetchImpl: () => { throw new Error('network'); } });
    assert.equal(whatsapp.skipped, true);
    const email = await sendEmail({ to: 'manager@eastc.test', subject: 'week', text: 'csv' });
    assert.equal(email.skipped, true);
    assert.equal(paymentHandoff(payment), null);
    assert.deepEqual(paymentHandoff({ status: 'pending', redirectUrl: 'https://pay.example/1' }), {
      type: 'redirect',
      url: 'https://pay.example/1',
    });
  });

  it('matches known MD5 vectors used by PayFast', () => {
    assert.equal(md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
    assert.equal(md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
    const signature = payfastSignature({ merchant_id: '1', amount: '10.00' }, 'secret');
    assert.equal(signature, md5('merchant_id=1&amount=10.00&passphrase=secret'));
  });
});

describe('reports, stock, automations', () => {
  it('splits revenue and writes a csv', () => {
    const report = buildFinanceReport({
      from: '2026-10-22',
      to: '2026-10-22',
      orders: [
        {
          createdAt: '2026-10-22T10:00:00.000Z',
          status: 'collected',
          paymentStatus: 'paid',
          paymentMethod: 'wallet',
          totalCents: 6900,
          items: [{ itemId: 'campus-burger', name: 'Campus burger & chips', qty: 1, lineTotalCents: 6900 }],
        },
      ],
      ledger: [{ createdAt: '2026-10-22T09:00:00.000Z', kind: 'topup', amountCents: 10000 }],
      students: [{ balanceCents: 3100 }],
      ingredients: [{ onHand: 2, costCents: 500 }],
      recipes: [],
      waste: [],
      specials: [],
    });
    assert.equal(report.byMethod.wallet.revenueCents, 6900);
    assert.equal(report.wallet.outstandingLiabilityCents, 3100);
    assert.equal(report.stockValueCents, 1000);
    assert.match(financeToCsv(report), /wallet,1,6900/);
  });

  it('deducts a recipe, suggests a reorder, and records a count variance', () => {
    const ingredients = [{ id: 'ing_bun', name: 'Burger bun', unit: 'each', costCents: 400, onHand: 2, reorderLevel: 4, supplierId: 'sup' }];
    const recipes = [{ menuItemId: 'campus-burger', ingredientId: 'ing_bun', qty: 1 }];
    const sold = deductIngredients(ingredients, recipes, [{ itemId: 'campus-burger', qty: 1 }]);
    assert.equal(sold.ingredients[0].onHand, 1);
    assert.equal(reorderSuggestions(sold.ingredients)[0].suggestQty >= 4, true);
    const count = applyStockTake(sold.ingredients, [{ ingredientId: 'ing_bun', countedQty: 3 }]);
    assert.equal(count.variances[0].variance, 2);
    assert.equal(count.ingredients[0].onHand, 3);
  });

  it('plans low balance, no-show, and the default menu', () => {
    const settings = mergeSettings({});
    const due = planLowBalance({
      students: [{ id: 's', phone: '+27820000000', balanceCents: 3500, autoTopup: false }],
      settings,
      alertedIds: [],
    });
    assert.equal(due.length, 1);
    assert.match(due[0].text, /R35/);
    const actions = planNoShows({
      now: new Date('2026-10-22T12:40:00.000Z'),
      settings,
      orders: [{ id: 'o', status: 'ready', pickupTime: '2026-10-22T12:00:00.000Z', phone: '+27820000000', reminderSentAt: null }],
    });
    assert.equal(actions[0].type, 'no-show-reminder');
    assert.equal(planSpecialDeadline({ hasSpecialToday: false }).keptDefaultMenu, true);
    assert.equal(reconcilePayments({ local: [], remote: null }).skipped, true);
  });
});
