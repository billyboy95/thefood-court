const CLOSED = new Set(['cancelled', 'no_show']);

export function slotBookedCount(orders, iso) {
  return (orders || []).filter((order) => order.pickupTime === iso && !CLOSED.has(order.status)).length;
}

export function annotateSlots(slots, orders, capacity) {
  const cap = Math.max(1, Math.trunc(Number(capacity) || 1));
  return (slots || []).map((slot) => {
    const booked = slotBookedCount(orders, slot.iso);
    const remaining = Math.max(0, cap - booked);
    return { ...slot, booked, remaining, capacity: cap, full: remaining === 0 };
  });
}

export function nextFreeSlot(annotated) {
  return (annotated || []).find((slot) => !slot.full) || null;
}

export function assertSlotOpen(annotated, iso) {
  const slot = (annotated || []).find((item) => item.iso === iso);
  if (!slot) throw new Error('Choose a pickup time from the list.');
  if (slot.full) {
    const next = nextFreeSlot(annotated);
    const hint = next ? ` Next free slot is ${next.label || next.displayTime}.` : '';
    throw new Error(`That pickup slot is full.${hint}`);
  }
  return slot;
}
