import { escapeHtml } from './lib/dom.js';
import { formatZAR } from './lib/money.js';
import { qrSvg } from './lib/qr.js';
import { paymentLabel } from './domain/notify.js';
import { specialDateLabel } from './domain/specials.js';
import { WEEKDAY_SHORT } from './data/venue.js';

function banner(text) {
  return text ? `<p class="demo-banner">${escapeHtml(text)}</p>` : '';
}

function shell(title, body, { back = '/' } = {}) {
  return `
    <header class="top">
      <a class="icon-btn" data-link href="${escapeHtml(back)}" aria-label="Back">←</a>
      <div class="brand"><strong>${escapeHtml(title)}</strong><span>The Food Court</span></div>
      <a class="icon-btn wallet-link" data-link href="/wallet" aria-label="Wallet">W</a>
    </header>
    ${body}`;
}

export function renderWallet({ wallet, error = '', notice = '', pending = false } = {}) {
  if (!wallet?.student) {
    return shell(
      'Wallet',
      `
      ${banner('Demo sign-in: student 20240001, 20240002 or 20240003, PIN 1234. Email code is 000000.')}
      ${error ? `<p class="alert" role="alert">${escapeHtml(error)}</p>` : ''}
      <section class="panel">
        <h2 class="section-title">Student number</h2>
        <form id="wallet-login" class="checkout-form">
          <label><span>Student number</span><input name="studentNumber" inputmode="numeric" autocomplete="username" required placeholder="20240001"></label>
          <label><span>PIN</span><input name="pin" type="password" inputmode="numeric" autocomplete="current-password" required minlength="4"></label>
          <button class="btn btn-gold btn-block" type="submit" ${pending ? 'disabled' : ''}>Sign in</button>
        </form>
      </section>
      <section class="panel">
        <h2 class="section-title">Email code</h2>
        <p class="muted">Magic link style. In demo mode no email is sent.</p>
        <form id="wallet-email" class="checkout-form">
          <label><span>Email</span><input name="email" type="email" autocomplete="email" required placeholder="thabo@eastc.test"></label>
          <label><span>Code</span><input name="code" inputmode="numeric" placeholder="000000"></label>
          <button class="btn btn-ghost btn-block" type="submit" name="intent" value="send">Send code</button>
          <button class="btn btn-gold btn-block" type="submit" name="intent" value="verify">Verify code</button>
        </form>
      </section>
      <section class="panel">
        <h2 class="section-title">New wallet</h2>
        <form id="wallet-register" class="checkout-form">
          <label><span>Student number</span><input name="studentNumber" inputmode="numeric" required></label>
          <label><span>Name</span><input name="fullName" required></label>
          <label><span>Phone</span><input name="phone" type="tel" required placeholder="082 000 0000"></label>
          <label><span>PIN</span><input name="pin" type="password" inputmode="numeric" required minlength="4"></label>
          <label><span>Email <em>(optional)</em></span><input name="email" type="email"></label>
          <button class="btn btn-gold btn-block" type="submit">Create wallet</button>
        </form>
      </section>`,
    );
  }

  const student = wallet.student;
  const token = wallet.token;
  return shell(
    'Wallet',
    `
    ${banner(wallet.demoLabel || (wallet.demo ? 'Sample demo data — not live sales' : ''))}
    ${error ? `<p class="alert" role="alert">${escapeHtml(error)}</p>` : ''}
    ${notice ? `<p class="k-flash" role="status">${escapeHtml(notice)}</p>` : ''}
    ${wallet.lowBalance ? `<p class="alert" role="status">${escapeHtml(wallet.warning || 'Balance is under the top-up threshold.')}</p>` : ''}
    <section class="panel wallet-hero">
      <p class="eyebrow">${escapeHtml(student.fullName)}</p>
      <h2 class="section-title">${formatZAR(student.balanceCents)}</h2>
      <p>Student ${escapeHtml(student.studentNumber)}</p>
      <p class="muted">${escapeHtml(wallet.loyaltyText || '')}</p>
      ${
        token
          ? `<div class="qr-wrap" aria-label="Pay code">${qrSvg(token.payload)}</div>
             <p class="pay-code">${escapeHtml(token.payload)}</p>
             <p class="muted">Code changes every 45 seconds. Show it at the till.</p>`
          : ''
      }
      <button type="button" class="btn btn-ghost btn-block" data-nfc-link ${typeof globalThis.NDEFReader === 'function' ? '' : 'hidden'}>Link a student card (NFC)</button>
      <p class="muted">${student.nfcUid ? `Card linked · ${escapeHtml(student.nfcUid)}` : 'NFC tap works on Android Chrome. Other phones use the QR code.'}</p>
    </section>
    <section class="panel">
      <h2 class="section-title">Top up</h2>
      <p class="muted">Yoco, then PayFast. Demo mode adds credit without charging a card.</p>
      <form id="wallet-topup" class="checkout-form">
        <div class="btn-row">
          ${[5000, 10000, 20000].map((cents) => `<button class="btn btn-gold" type="submit" name="amountCents" value="${cents}">${formatZAR(cents)}</button>`).join('')}
        </div>
      </form>
      <form id="wallet-auto" class="checkout-form">
        <label class="pay-option"><input type="checkbox" name="enabled" ${student.autoTopup ? 'checked' : ''}> Auto top-up when I drop under the threshold</label>
        <button class="btn btn-ghost btn-block" type="submit">Save auto top-up</button>
      </form>
      <button type="button" class="btn btn-ghost btn-block" data-sign-out>Sign out</button>
    </section>
    <section class="panel">
      <h2 class="section-title">Orders</h2>
      ${(wallet.orders || []).length
        ? wallet.orders
            .map(
              (order) => `
            <a class="history-row" data-link href="/order/${escapeHtml(order.id)}">
              <span><strong>${escapeHtml(order.orderNumber)}</strong><br><em>${escapeHtml(order.pickupLabel || '')} · ${escapeHtml(paymentLabel(order))}</em></span>
              <strong>${formatZAR(order.totalCents)}</strong>
            </a>`,
            )
            .join('')
        : '<p class="muted">No orders yet.</p>'}
    </section>
    <section class="panel">
      <h2 class="section-title">Wallet transactions</h2>
      ${(wallet.ledger || []).length
        ? wallet.ledger
            .map(
              (row) => `
            <div class="history-row">
              <span><strong>${escapeHtml(row.kind)}</strong><br><em>${escapeHtml(row.note || '')}</em></span>
              <strong>${row.amountCents > 0 ? '+' : ''}${formatZAR(row.amountCents)}</strong>
            </div>`,
            )
            .join('')
        : '<p class="muted">No transactions yet.</p>'}
    </section>`,
  );
}

export function renderSpecialsPage({ archive, demoLabel = '' } = {}) {
  const groups = new Map();
  for (const row of archive?.specials || []) {
    if (!groups.has(row.specialDate)) groups.set(row.specialDate, []);
    groups.get(row.specialDate).push(row);
  }
  const blocks = [...groups.entries()]
    .map(
      ([date, rows]) => `
      <section class="panel">
        <p class="eyebrow">${escapeHtml(specialDateLabel(date))}</p>
        ${rows
          .map(
            (row) => `
          <article class="item-card">
            <img class="thumb" src="${escapeHtml(row.imageUrl)}" alt="" width="88" height="88">
            <div class="item-body">
              <div class="item-top"><h3>${escapeHtml(row.name)}</h3><span class="price">${formatZAR(row.priceCents)}</span></div>
              <p class="desc">${escapeHtml(row.caption || '')}</p>
              <div class="badges"><span class="badge">${escapeHtml(row.source || 'chef')}</span>${row.demo ? '<span class="badge">Demo</span>' : ''}</div>
            </div>
          </article>`,
          )
          .join('')}
      </section>`,
    )
    .join('');
  return shell(
    'Specials',
    `${banner(demoLabel)}<p class="muted address">Past chef specials. If nobody sends one, the regular menu stays up.</p>${blocks || '<p class="empty">No specials yet.</p>'}`,
  );
}

export function renderChef({ unlocked = false, error = '', notice = '' } = {}) {
  if (!unlocked) {
    return shell(
      'Chef',
      `
      ${banner('Demo chef PIN is 2468.')}
      ${error ? `<p class="alert" role="alert">${escapeHtml(error)}</p>` : ''}
      <section class="panel">
        <h2 class="section-title">Post today’s special</h2>
        <form id="chef-pin" class="checkout-form">
          <label><span>Chef PIN</span><input name="pin" type="password" inputmode="numeric" required></label>
          <button class="btn btn-gold btn-block" type="submit">Continue</button>
        </form>
      </section>`,
    );
  }
  return shell(
    'Chef',
    `
    ${error ? `<p class="alert" role="alert">${escapeHtml(error)}</p>` : ''}
    ${notice ? `<p class="k-flash" role="status">${escapeHtml(notice)}</p>` : ''}
    <section class="panel">
      <p class="muted">Same result as a WhatsApp photo. Caption shape: Monday special: Burgers R55.</p>
      <form id="chef-special" class="checkout-form">
        <label><span>Photo</span><input name="photo" type="file" accept="image/*" required></label>
        <label><span>Caption</span><input name="caption" required placeholder="Monday special: Burgers R55"></label>
        <button class="btn btn-gold btn-block" type="submit">Publish special</button>
      </form>
    </section>`,
  );
}

export function renderCounter({ orders = [], demoLabel = '' } = {}) {
  return `
    <header class="top">
      <div class="mark" aria-hidden="true">FC</div>
      <div class="brand"><strong>Now collecting</strong><span>Food Court counter</span></div>
      <a class="icon-btn" href="/kitchen.html" aria-label="Kitchen">K</a>
    </header>
    ${banner(demoLabel)}
    <section class="panel counter-list">
      ${
        orders.length
          ? orders
              .map(
                (order) => `
            <article class="counter-card">
              <h2>${escapeHtml(order.orderNumber)}</h2>
              <p>${escapeHtml(order.customerName)}</p>
              <p class="muted">${escapeHtml(order.pickupLabel || '')}</p>
            </article>`,
              )
              .join('')
          : '<p class="empty">Nothing is waiting at the counter.</p>'
      }
    </section>`;
}

function moneyCell(cents) {
  return formatZAR(cents || 0);
}

export function renderReports({ report, error = '', from = '', to = '' } = {}) {
  if (!report) {
    return shell(
      'Reports',
      `${error ? `<p class="alert">${escapeHtml(error)}</p>` : ''}<form id="staff-pin" class="checkout-form"><label><span>Manager PIN</span><input name="pin" type="password" inputmode="numeric" required></label><button class="btn btn-gold btn-block" type="submit">Open reports</button></form>`,
      { back: '/kitchen' },
    );
  }
  const methodRows = ['wallet', 'card', 'cash']
    .map((method) => `<tr><td>${method}</td><td>${report.byMethod[method].orders}</td><td>${moneyCell(report.byMethod[method].revenueCents)}</td></tr>`)
    .join('');
  return shell(
    'Reports',
    `
    ${banner(report.demoLabel || (report.demo ? 'Sample demo data — not live sales' : ''))}
    <form id="report-range" class="filters-row">
      <label>From<input type="date" name="from" value="${escapeHtml(from)}"></label>
      <label>To<input type="date" name="to" value="${escapeHtml(to)}"></label>
      <button class="btn btn-gold" type="submit">Apply</button>
      <button class="btn btn-ghost" type="button" data-csv>CSV</button>
    </form>
    <section class="panel">
      <h2 class="section-title">${moneyCell(report.revenueCents)}</h2>
      <p>${report.orderCount} orders · average ${moneyCell(report.averageOrderValueCents)}</p>
      <p>Cost of sales ${moneyCell(report.cogsCents)} · gross margin ${moneyCell(report.grossMarginCents)}</p>
      <p>Stock value ${moneyCell(report.stockValueCents)} · waste ${moneyCell(report.wasteCents)}</p>
      <p>Wallet top-ups ${moneyCell(report.wallet.topupCents)} · spend ${moneyCell(report.wallet.spendCents)} · liability ${moneyCell(report.wallet.outstandingLiabilityCents)}</p>
      <p>Refunds ${report.refunds.count} · ${moneyCell(report.refunds.cents)} · write-offs ${report.writeOffs.count} · ${moneyCell(report.writeOffs.cents)}</p>
    </section>
    <section class="panel"><h2 class="section-title">By payment method</h2><table class="grid"><tr><th>Method</th><th>Orders</th><th>Revenue</th></tr>${methodRows}</table></section>
    <section class="panel"><h2 class="section-title">Daily</h2><table class="grid"><tr><th>Day</th><th>Orders</th><th>Revenue</th></tr>${report.daily.map((row) => `<tr><td>${escapeHtml(row.date)}</td><td>${row.orders}</td><td>${moneyCell(row.revenueCents)}</td></tr>`).join('')}</table></section>
    <section class="panel"><h2 class="section-title">Weekly</h2><table class="grid"><tr><th>Week</th><th>Orders</th><th>Revenue</th></tr>${report.weekly.map((row) => `<tr><td>${escapeHtml(row.week)}</td><td>${row.orders}</td><td>${moneyCell(row.revenueCents)}</td></tr>`).join('')}</table></section>
    <section class="panel"><h2 class="section-title">Monthly</h2><table class="grid"><tr><th>Month</th><th>Orders</th><th>Revenue</th></tr>${report.monthly.map((row) => `<tr><td>${escapeHtml(row.month)}</td><td>${row.orders}</td><td>${moneyCell(row.revenueCents)}</td></tr>`).join('')}</table></section>
    <section class="panel"><h2 class="section-title">Items</h2><table class="grid"><tr><th>Item</th><th>Qty</th><th>Revenue</th></tr>${report.items.slice(0, 20).map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${row.qty}</td><td>${moneyCell(row.revenueCents)}</td></tr>`).join('')}</table></section>
    <section class="panel"><h2 class="section-title">Day of week</h2><table class="grid"><tr><th>Day</th><th>Orders</th><th>Revenue</th></tr>${report.byDow.map((row) => `<tr><td>${escapeHtml(row.label || WEEKDAY_SHORT[row.dow])}</td><td>${row.orders}</td><td>${moneyCell(row.revenueCents)}</td></tr>`).join('')}</table></section>
    <section class="panel"><h2 class="section-title">Hour</h2><table class="grid"><tr><th>Hour</th><th>Orders</th><th>Revenue</th></tr>${report.byHour.map((row) => `<tr><td>${String(row.hour).padStart(2, '0')}:00</td><td>${row.orders}</td><td>${moneyCell(row.revenueCents)}</td></tr>`).join('')}</table></section>
    <section class="panel"><h2 class="section-title">Daily specials</h2><table class="grid"><tr><th>Date</th><th>Special</th><th>Qty</th><th>Revenue</th></tr>${report.specials.map((row) => `<tr><td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.name)}</td><td>${row.qty}</td><td>${moneyCell(row.revenueCents)}</td></tr>`).join('')}</table></section>
    <section class="panel"><h2 class="section-title">Reconciliation</h2>${(report.reconciliation || []).map((row) => `<p>${escapeHtml(row.detail || row.kind)} · local ${moneyCell(row.localCents)} · provider ${row.providerCents == null ? '—' : moneyCell(row.providerCents)}${row.demo ? ' · demo' : ''}</p>`).join('') || '<p class="muted">No mismatches.</p>'}</section>`,
    { back: '/kitchen' },
  );
}

export function renderStock({ stock, error = '', notice = '' } = {}) {
  if (!stock) {
    return shell(
      'Stock',
      `${error ? `<p class="alert">${escapeHtml(error)}</p>` : ''}<form id="staff-pin" class="checkout-form"><label><span>Manager PIN</span><input name="pin" type="password" inputmode="numeric" required></label><button class="btn btn-gold btn-block" type="submit">Open stock</button></form>`,
      { back: '/kitchen' },
    );
  }
  const options = stock.ingredients.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.name)}</option>`).join('');
  return shell(
    'Stock',
    `
    ${banner(stock.demoLabel || '')}
    ${error ? `<p class="alert">${escapeHtml(error)}</p>` : ''}
    ${notice ? `<p class="k-flash">${escapeHtml(notice)}</p>` : ''}
    <p class="muted address">On-hand value ${formatZAR(stock.stockValueCents)}.${stock.demo ? ' Demo figures are a sample snapshot.' : ' Sales deduct recipe quantities.'}</p>
    <section class="panel"><h2 class="section-title">On hand</h2><table class="grid"><tr><th>Item</th><th>On hand</th><th>Reorder</th><th>Cost</th></tr>${stock.ingredients.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${row.onHand} ${escapeHtml(row.unit)}</td><td>${row.reorderLevel}</td><td>${formatZAR(row.costCents)}</td></tr>`).join('')}</table></section>
    <section class="panel"><h2 class="section-title">Suggested order</h2>${stock.suggestions.length ? stock.suggestions.map((row) => `<p>${escapeHtml(row.name)} · order ${row.suggestQty} ${escapeHtml(row.unit)} from ${escapeHtml(row.supplierName || 'supplier')} · ${formatZAR(row.costCents)}</p>`).join('') : '<p class="muted">Nothing to reorder.</p>'}</section>
    <section class="panel"><h2 class="section-title">Goods received</h2><form id="stock-receive" class="checkout-form"><label><span>Item</span><select name="ingredientId">${options}</select></label><label><span>Qty</span><input name="qty" inputmode="decimal" required></label><label><span>Note</span><input name="note"></label><button class="btn btn-gold btn-block" type="submit">Receive</button></form></section>
    <section class="panel"><h2 class="section-title">Waste</h2><form id="stock-waste" class="checkout-form"><label><span>Item</span><select name="ingredientId">${options}</select></label><label><span>Qty</span><input name="qty" inputmode="decimal" required></label><label><span>Reason</span><input name="reason" required></label><button class="btn btn-gold btn-block" type="submit">Log waste</button></form></section>
    <section class="panel"><h2 class="section-title">Stock take</h2><form id="stock-take" class="checkout-form">${stock.ingredients.map((row) => `<label><span>${escapeHtml(row.name)} (${escapeHtml(row.unit)})</span><input name="count_${escapeHtml(row.id)}" inputmode="decimal" value="${escapeHtml(row.onHand)}"></label>`).join('')}<button class="btn btn-gold btn-block" type="submit">Save count</button></form></section>
    <section class="panel"><h2 class="section-title">Recipes</h2>${stock.recipes.map((row) => `<p>${escapeHtml(row.menuItemId)} uses ${row.qty} × ${escapeHtml(stock.ingredients.find((item) => item.id === row.ingredientId)?.name || row.ingredientId)}</p>`).join('')}</section>`,
    { back: '/kitchen' },
  );
}

const SETTING_FIELDS = [
  ['lowBalanceCents', 'Low balance threshold (cents)'],
  ['autoTopupCents', 'Auto top-up amount (cents)'],
  ['noShowReminderMinutes', 'No-show reminder (minutes)'],
  ['noShowActionMinutes', 'No-show refund / write-off (minutes)'],
  ['slotCapacity', 'Orders per pickup slot'],
  ['loyaltyTarget', 'Stamps for a free meal'],
  ['ratingAlertMax', 'Alert manager at or below this score'],
  ['portionLowThreshold', 'Low portion warning'],
  ['chefNudgeHour', 'Chef nudge hour (SAST)'],
  ['specialDeadlineHour', 'Special deadline hour (SAST)'],
  ['eodHour', 'End-of-day summary hour (SAST)'],
  ['forecastHour', 'Prep forecast hour (SAST)'],
  ['managerWhatsapp', 'Manager WhatsApp'],
  ['kitchenWhatsapp', 'Kitchen WhatsApp'],
  ['chefWhatsappAllowlist', 'Chef WhatsApp numbers'],
  ['managerEmail', 'Manager email'],
  ['reportsEmail', 'Weekly CSV email'],
];

export function renderSettings({ settings, error = '', notice = '', runs = [], providers } = {}) {
  if (!settings) {
    return shell(
      'Settings',
      `${error ? `<p class="alert">${escapeHtml(error)}</p>` : ''}<form id="staff-pin" class="checkout-form"><label><span>Manager PIN</span><input name="pin" type="password" inputmode="numeric" required></label><button class="btn btn-gold btn-block" type="submit">Open settings</button></form>`,
      { back: '/kitchen' },
    );
  }
  return shell(
    'Settings',
    `
    ${error ? `<p class="alert">${escapeHtml(error)}</p>` : ''}
    ${notice ? `<p class="k-flash">${escapeHtml(notice)}</p>` : ''}
    <p class="muted address">Provider API keys are environment secrets, not saved here. Payments: ${escapeHtml(providers?.payments || 'stub')}. WhatsApp ${providers?.whatsapp ? 'on' : 'off'}. Email ${providers?.email ? 'on' : 'off'}.</p>
    <form id="settings-form" class="checkout-form">
      <label><span>No-show action</span><select name="noShowAction"><option value="refund" ${settings.noShowAction === 'refund' ? 'selected' : ''}>Auto refund</option><option value="write_off" ${settings.noShowAction === 'write_off' ? 'selected' : ''}>Write off</option></select></label>
      ${SETTING_FIELDS.map(([key, label]) => `<label><span>${escapeHtml(label)}</span><input name="${escapeHtml(key)}" value="${escapeHtml(settings[key] ?? '')}"></label>`).join('')}
      <button class="btn btn-gold btn-block" type="submit">Save settings</button>
    </form>
    <section class="panel">
      <h2 class="section-title">Run a job</h2>
      <div class="btn-row wrap">
        ${['low-balance', 'no-show', 'chef-nudge', 'special-deadline', 'stock', 'eod', 'weekly-csv', 'forecast', 'reconcile', 'all'].map((job) => `<button type="button" class="btn btn-ghost" data-job="${job}">${job}</button>`).join('')}
      </div>
      ${(runs || []).slice(0, 8).map((run) => `<p class="muted">${escapeHtml(run.job)} · ${escapeHtml(run.status)} · ${escapeHtml(run.detail || '')}${run.demo ? ' · demo' : ''}</p>`).join('')}
    </section>`,
    { back: '/kitchen' },
  );
}
