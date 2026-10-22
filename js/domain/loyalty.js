/**
 * 10th meal is free: one unit of the highest-priced line.
 * Stamps reset when that meal is redeemed.
 */
export function quoteLoyalty({ stamps = 0, lines = [], target = 10 } = {}) {
  const current = Math.max(0, Math.trunc(Number(stamps) || 0));
  const goal = Math.max(2, Math.trunc(Number(target) || 10));
  if (current + 1 < goal) {
    return {
      redeem: false,
      stampsAfter: current + 1,
      discountCents: 0,
      lines,
      freeItemId: null,
    };
  }

  let bestIndex = -1;
  let bestPrice = -1;
  lines.forEach((line, index) => {
    const unit = Number(line.unitPriceCents) || 0;
    if (unit > bestPrice) {
      bestPrice = unit;
      bestIndex = index;
    }
  });

  if (bestIndex < 0 || bestPrice <= 0) {
    return { redeem: true, stampsAfter: 0, discountCents: 0, lines, freeItemId: null };
  }

  const nextLines = lines.map((line, index) => {
    if (index !== bestIndex) return line;
    return {
      ...line,
      lineTotalCents: Math.max(0, Number(line.lineTotalCents) - bestPrice),
      loyaltyFreeQty: 1,
    };
  });

  return {
    redeem: true,
    stampsAfter: 0,
    discountCents: bestPrice,
    lines: nextLines,
    freeItemId: lines[bestIndex].itemId || null,
  };
}

export function reverseLoyalty(stamps, order, target = 10) {
  const current = Math.max(0, Math.trunc(Number(stamps) || 0));
  const goal = Math.max(2, Math.trunc(Number(target) || 10));
  if (order?.loyaltyRedeemed) return goal - 1;
  return Math.max(0, current - 1);
}

export function loyaltyLabel(stamps, target = 10) {
  const goal = Math.max(2, Math.trunc(Number(target) || 10));
  const current = Math.max(0, Math.trunc(Number(stamps) || 0));
  if (current >= goal - 1) return `${current} / ${goal} · your next meal is free`;
  const left = goal - current;
  return `${current} / ${goal} · ${left} to a free meal`;
}
