import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getPickupSlots, isItemAvailable, kitchenStatus, partsInTZ } from '../js/lib/hours.js';
import { getMenuItem } from '../js/data/menu.js';
import { isValidSaPhone, normalizeSaPhone } from '../js/lib/phone.js';
import { makeOrderNumber } from '../js/lib/ids.js';

describe('kitchen hours (Africa/Johannesburg)', () => {
  it('is open late morning on a weekday', () => {
    const now = new Date('2026-09-16T10:00:00+02:00');
    const status = kitchenStatus(now);
    assert.equal(status.open, true);
    assert.equal(partsInTZ(now).dow, 3);
  });

  it('offers same-day slots after prep time', () => {
    const now = new Date('2026-09-16T10:00:00+02:00');
    const slots = getPickupSlots(now);
    assert.ok(slots.length > 0);
    assert.equal(slots[0].dow, 3);
    assert.equal(slots[0].displayTime, '10:30');
    assert.ok(slots.every((slot) => slot.iso.endsWith('Z')));
  });

  it('rolls to Monday when Sunday is closed', () => {
    const now = new Date('2026-09-20T11:00:00+02:00');
    assert.equal(kitchenStatus(now).open, false);
    const slots = getPickupSlots(now);
    assert.ok(slots.length > 0);
    assert.equal(slots[0].dow, 1);
    assert.equal(slots[0].displayTime, '07:00');
  });

  it('rolls to Saturday after Friday close', () => {
    const now = new Date('2026-09-18T18:00:00+02:00');
    const slots = getPickupSlots(now);
    assert.equal(slots[0].dow, 6);
    assert.equal(slots[0].displayTime, '08:00');
  });

  it('hides Saturday-only brunch on a weekday pickup day', () => {
    const brunch = getMenuItem('full-brunch');
    const thu = getPickupSlots(new Date('2026-09-17T10:00:00+02:00'));
    const sat = getPickupSlots(new Date('2026-09-19T10:00:00+02:00'));
    assert.equal(isItemAvailable(brunch, thu), false);
    assert.equal(isItemAvailable(brunch, sat), true);
    assert.equal(isItemAvailable(getMenuItem('campus-burger'), thu), true);
  });
});

describe('phone + order numbers', () => {
  it('normalizes local and +27 numbers', () => {
    assert.equal(normalizeSaPhone('082 123 4567'), '+27821234567');
    assert.equal(normalizeSaPhone('+27 11 394 1488'), '+27113941488');
    assert.equal(isValidSaPhone('123'), false);
  });

  it('builds FC-ddxxx order numbers', () => {
    const n = makeOrderNumber(new Date('2026-09-17T12:00:00+02:00'), () => 0);
    assert.equal(n, 'FC-17100');
  });
});
