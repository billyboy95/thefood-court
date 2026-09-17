import { cartTotals } from './money.js';

const DEFAULT_KEY = 'foodcourt.cart.v1';

export function loadCartState(storage, key = DEFAULT_KEY) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return { lines: [] };
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.lines)) return { lines: [] };
    return {
      lines: parsed.lines
        .map((line) => ({
          itemId: String(line.itemId),
          qty: Math.floor(Number(line.qty) || 0),
        }))
        .filter((line) => line.itemId && line.qty > 0),
    };
  } catch {
    return { lines: [] };
  }
}

export function qtyFor(lines, itemId) {
  return lines.find((line) => line.itemId === itemId)?.qty ?? 0;
}

export function createCart({ storage, getItem, key = DEFAULT_KEY }) {
  const listeners = new Set();
  let state = loadCartState(storage, key);

  function persist() {
    storage.setItem(key, JSON.stringify(state));
  }

  function snapshot() {
    return cartTotals(state.lines, getItem);
  }

  function emit() {
    persist();
    const snap = snapshot();
    listeners.forEach((fn) => fn(snap));
    return snap;
  }

  return {
    snapshot,
    subscribe(fn) {
      listeners.add(fn);
      fn(snapshot());
      return () => listeners.delete(fn);
    },
    add(itemId, qty = 1) {
      const addBy = Math.floor(qty);
      if (!itemId || addBy < 1 || !getItem(itemId)) return snapshot();
      const line = state.lines.find((l) => l.itemId === itemId);
      if (line) line.qty += addBy;
      else state.lines.push({ itemId, qty: addBy });
      return emit();
    },
    setQty(itemId, qty) {
      const next = Math.floor(qty);
      if (!itemId) return snapshot();
      if (next <= 0) {
        state.lines = state.lines.filter((l) => l.itemId !== itemId);
        return emit();
      }
      if (!getItem(itemId)) return snapshot();
      const line = state.lines.find((l) => l.itemId === itemId);
      if (line) line.qty = next;
      else state.lines.push({ itemId, qty: next });
      return emit();
    },
    clear() {
      state = { lines: [] };
      return emit();
    },
  };
}
