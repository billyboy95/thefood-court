import { partsInTZ, pad2 } from './hours.js';

export function makeOrderNumber(now = new Date(), random = Math.random) {
  const p = partsInTZ(now);
  const rand = Math.floor(100 + random() * 900);
  return `FC-${pad2(p.day)}${rand}`;
}

export function makeOrderId(now = new Date(), random = Math.random) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ord_${now.getTime().toString(36)}_${Math.floor(random() * 1e9).toString(36)}`;
}
