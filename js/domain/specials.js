import { partsInTZ } from '../lib/hours.js';
import { sastDate } from './dates.js';
import { randsToCents } from '../lib/money.js';

const DAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const DAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function parseSpecialCaption(caption, now = new Date()) {
  const text = String(caption || '').replace(/\s+/g, ' ').trim();
  const match = text.match(
    /^(?:(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today)\s+)?special\s*:\s*(.+?)\s+R\s*(\d+(?:[.,]\d{1,2})?)\s*$/i,
  );
  if (!match) return null;
  const word = (match[1] || 'today').toLowerCase();
  const name = match[2].trim();
  const priceCents = randsToCents(match[3].replace(',', '.'));
  if (!name || priceCents <= 0) return null;
  const today = partsInTZ(now);
  const dow = word === 'today' ? today.dow : DAY_INDEX[word];
  return {
    name,
    priceCents,
    dow,
    dayLabel: DAY_NAME[dow],
    specialDate: sastDate(now),
    caption: text,
  };
}

/**
 * A missing chef photo never blanks the board — fall back to the printed menu specials.
 */
export function resolveTodaySpecial({ specials = [], menuItems = [], now = new Date() } = {}) {
  const today = sastDate(now);
  const dow = partsInTZ(now).dow;
  const published = specials.find((row) => row.specialDate === today && row.status !== 'removed') || null;
  const menuFallback = menuItems.filter((item) => item.specialOn?.includes(dow));
  if (published) return { source: 'chef', published, menuFallback, today, dow };
  if (menuFallback.length) return { source: 'menu', published: null, menuFallback, today, dow };
  return { source: 'regular', published: null, menuFallback: [], today, dow };
}

export function extractInboundMessages(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      for (const message of change.value?.messages || []) {
        out.push({
          from: message.from || '',
          type: message.type || '',
          caption: message.image?.caption || message.text?.body || '',
          mediaId: message.image?.id || null,
          mime: message.image?.mime_type || '',
        });
      }
    }
  }
  return out;
}

export function weekdayStamp(dow) {
  return DAY_NAME[dow] || '';
}

export { DAY_NAME };

export function specialDateLabel(dateStr) {
  const [y, m, d] = String(dateStr || '').split('-');
  if (!y || !m || !d) return dateStr;
  return `${d} ${['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m)] || m} ${y}`;
}
