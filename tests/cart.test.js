import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cartTotals, formatZAR, randsToCents } from '../js/lib/money.js';
import { createCart } from '../js/lib/cart.js';
import { memoryStorage } from '../js/lib/dom.js';

const menu = {
  burger: { id: 'burger', priceCents: randsToCents(69) },
  chips: { id: 'chips', priceCents: randsToCents(30) },
};

function getItem(id) {
  return menu[id] ?? null;
}

describe('money', () => {
  it('formats whole rands without decimals', () => {
    assert.equal(formatZAR(6800), 'R68');
    assert.equal(formatZAR(0), 'R0');
  });

  it('sums cart lines from the menu, not the client', () => {
    const totals = cartTotals(
      [
        { itemId: 'burger', qty: 2 },
        { itemId: 'chips', qty: 1 },
        { itemId: 'ghost', qty: 9 },
      ],
      getItem,
    );
    assert.equal(totals.itemCount, 3);
    assert.equal(totals.totalCents, 6900 * 2 + 3000);
  });
});

describe('cart store', () => {
  it('persists add / qty / clear in storage', () => {
    const storage = memoryStorage();
    const cart = createCart({ storage, getItem });
    cart.add('burger', 1);
    cart.add('burger', 1);
    cart.add('chips');
    assert.equal(cart.snapshot().itemCount, 3);
    assert.equal(cart.snapshot().totalCents, 16800);
    cart.setQty('chips', 0);
    assert.equal(cart.snapshot().itemCount, 2);
    const again = createCart({ storage, getItem });
    assert.equal(again.snapshot().itemCount, 2);
    cart.clear();
    assert.equal(cart.snapshot().itemCount, 0);
  });

  it('removeMany drops selected lines in one write', () => {
    const storage = memoryStorage();
    const cart = createCart({ storage, getItem });
    cart.add('burger');
    cart.add('chips');
    cart.removeMany(['chips', 'ghost']);
    assert.equal(cart.snapshot().itemCount, 1);
    assert.equal(cart.snapshot().lines[0].itemId, 'burger');
  });
});
