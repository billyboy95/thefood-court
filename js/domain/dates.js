import { pad2, partsInTZ } from '../lib/hours.js';

export function sastDate(date = new Date()) {
  const p = partsInTZ(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function dateInRange(iso, from, to) {
  if (!iso) return false;
  const day = sastDate(new Date(iso));
  return day >= from && day <= to;
}

export function rangeForPreset(preset, now = new Date()) {
  const today = sastDate(now);
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'week') {
    const p = partsInTZ(now);
    const mondayOffset = p.dow === 0 ? 6 : p.dow - 1;
    const start = new Date(now.getTime() - mondayOffset * 24 * 60 * 60 * 1000);
    return { from: sastDate(start), to: today };
  }
  if (preset === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  return { from: today, to: today };
}

export function isoWeekKey(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((dt.getTime() - firstThursday.getTime()) / 604800000);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
