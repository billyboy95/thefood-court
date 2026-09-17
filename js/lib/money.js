/** Integer cents keep ZAR math exact. */
export function randsToCents(rands) {
  return Math.round(Number(rands) * 100);
}

export function formatZAR(cents) {
  const value = Number(cents) / 100;
  if (!Number.isFinite(value)) return 'R0';
  if (Number.isInteger(value)) return `R${value}`;
  return `R${value.toFixed(2)}`;
}

export function cartTotals(lines, getItem) {
  let itemCount = 0;
  let totalCents = 0;
  const detailed = [];
  for (const line of lines) {
    const item = getItem(line.itemId);
    if (!item || line.qty < 1) continue;
    const qty = Math.floor(line.qty);
    const lineTotal = item.priceCents * qty;
    itemCount += qty;
    totalCents += lineTotal;
    detailed.push({ ...line, qty, item, lineTotal });
  }
  return { lines: detailed, itemCount, totalCents };
}
