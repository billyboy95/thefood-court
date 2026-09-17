import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { getMenuItem } from '../js/data/menu.js';
import { getPickupSlots } from '../js/lib/hours.js';
import { cartTotals } from '../js/lib/money.js';
import { renderCartPage } from '../js/views.js';

describe('quantity tap targets', () => {
  it('sizes +/− buttons at least 44×44 CSS px', () => {
    const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
    const block = css.match(/\.qty button\s*\{[^}]+\}/)?.[0] ?? '';
    assert.match(block, /min-width:\s*44px/);
    assert.match(block, /min-height:\s*44px/);
  });
});

describe('cart availability', () => {
  it('disables Saturday-only lines on a weekday pickup day', () => {
    const now = new Date('2026-09-17T10:00:00+02:00');
    const slots = getPickupSlots(now);
    const totals = cartTotals(
      [
        { itemId: 'campus-burger', qty: 1 },
        { itemId: 'full-brunch', qty: 1 },
      ],
      getMenuItem,
    );
    const html = renderCartPage({
      cart: { ...totals, qty: (id) => totals.lines.find((l) => l.itemId === id)?.qty ?? 0 },
      slots,
      now,
    });
    assert.match(html, /Not on for Thursday pickup/);
    assert.match(html, /data-strip-unavailable/);
    assert.match(html, /Continue without unavailable items/);
    assert.match(html, /data-inc="full-brunch"[^>]*disabled/);
    assert.doesNotMatch(html, /data-inc="campus-burger"[^>]*disabled/);
  });
});
