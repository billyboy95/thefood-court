import { venue, WEEKDAY_SHORT } from '../data/venue.js';

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function parseHM(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

export function formatMins(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

/** Read calendar parts in Africa/Johannesburg. */
export function partsInTZ(date = new Date(), timeZone = venue.timezone) {
  const fmt = new Intl.DateTimeFormat('en-ZA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const map = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday: map.weekday,
    dow: weekdayMap[map.weekday] ?? 0,
  };
}

export function zonedDate(year, month, day, hour, minute, offset = venue.utcOffset) {
  return new Date(
    `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:00${offset}`,
  );
}

export function addCivilDays(parts, days) {
  const noon = zonedDate(parts.year, parts.month, parts.day, 12, 0);
  return partsInTZ(new Date(noon.getTime() + days * 24 * 60 * 60 * 1000));
}

export function kitchenStatus(now = new Date()) {
  const p = partsInTZ(now);
  const hours = venue.hours[p.dow];
  const mins = p.hour * 60 + p.minute;
  if (!hours) {
    return { open: false, label: 'Kitchen closed · Sunday', code: 'closed' };
  }
  const open = parseHM(hours.open);
  const close = parseHM(hours.close);
  const lastPickup = close - venue.lastPickupBeforeCloseMinutes;
  if (mins < open) {
    return { open: false, label: `Opens at ${hours.open}`, code: 'before' };
  }
  if (mins >= close) {
    return { open: false, label: 'Kitchen closed for today', code: 'after' };
  }
  return {
    open: true,
    label: `Kitchen open · last pickup ${formatMins(lastPickup)}`,
    code: 'open',
  };
}

/**
 * Same-day remaining slots, or the next open day's full slot list.
 * Each slot: { iso, label, dow, minutes, dateLabel }
 */
export function getPickupSlots(now = new Date()) {
  const nowP = partsInTZ(now);
  const minStart = nowP.hour * 60 + nowP.minute + venue.prepMinutes;

  for (let offset = 0; offset < 8; offset += 1) {
    const day = offset === 0 ? nowP : addCivilDays(nowP, offset);
    const hours = venue.hours[day.dow];
    if (!hours) continue;

    const open = parseHM(hours.open);
    const close = parseHM(hours.close);
    const last = close - venue.lastPickupBeforeCloseMinutes;
    let t = open;
    if (offset === 0) {
      t = Math.max(open, Math.ceil(minStart / venue.slotMinutes) * venue.slotMinutes);
    }

    const slots = [];
    for (; t <= last; t += venue.slotMinutes) {
      const hour = Math.floor(t / 60);
      const minute = t % 60;
      const date = zonedDate(day.year, day.month, day.day, hour, minute);
      const time = formatMins(t);
      const dateLabel = offset === 0 ? 'Today' : `${WEEKDAY_SHORT[day.dow]} ${pad2(day.day)}/${pad2(day.month)}`;
      slots.push({
        iso: date.toISOString(),
        value: date.toISOString(),
        label: offset === 0 ? time : `${WEEKDAY_SHORT[day.dow]} ${time}`,
        displayTime: time,
        dateLabel,
        dow: day.dow,
        minutes: t,
      });
    }
    if (slots.length) return slots;
  }
  return [];
}

const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function dayLabel(dow) {
  return WEEKDAY_LONG[dow] ?? 'that day';
}

/** Pickup weekday for the next offered slot (or “now” if none). */
export function pickupDow(slots, now = new Date()) {
  if (slots?.length) return slots[0].dow;
  return partsInTZ(now).dow;
}

export function isItemAvailableOnDay(item, dow) {
  if (!item?.availableDays?.length) return true;
  return item.availableDays.includes(dow);
}

export function isItemAvailable(item, slots, now = new Date()) {
  return isItemAvailableOnDay(item, pickupDow(slots, now));
}

export function availableDaysLabel(item) {
  if (!item?.availableDays?.length) return 'every open day';
  return item.availableDays.map(dayLabel).join(', ');
}

export function unavailableLines(lines, dow) {
  return (lines ?? []).filter((line) => {
    const item = line.item;
    return item && !isItemAvailableOnDay(item, dow);
  });
}

export function unavailableOrderError(items, dow) {
  const pickupDay = dayLabel(dow);
  if (!items.length) return '';
  if (items.length === 1) {
    const item = items[0];
    return `${item.name} is only available on ${availableDaysLabel(item)}, not for ${pickupDay} pickup. Remove it from your cart or choose a matching pickup day.`;
  }
  const names = items.map((item) => item.name).join(', ');
  return `${names} are not available for ${pickupDay} pickup. Remove them from your cart or choose a matching pickup day.`;
}

export function todaysSpecials(now = new Date()) {
  const dow = partsInTZ(now).dow;
  return { dow, weekday: WEEKDAY_SHORT[dow] };
}
