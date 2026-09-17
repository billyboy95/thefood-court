/** Venue facts for The Food Court on EASTC campus. */
export const venue = {
  name: 'The Food Court',
  shortName: 'Food Court',
  campus: 'EASTC Technocentric Varsity',
  address: '43 Maxwell Street, Kempton Park',
  area: 'EASTC campus parking, Maxwell Street',
  phone: '011 394 1488',
  phoneHref: 'tel:+27113941488',
  timezone: 'Africa/Johannesburg',
  /** Africa/Johannesburg is UTC+2 with no DST. */
  utcOffset: '+02:00',
  prepMinutes: 20,
  slotMinutes: 15,
  lastPickupBeforeCloseMinutes: 15,
  hours: {
    1: { open: '07:00', close: '17:30' },
    2: { open: '07:00', close: '17:30' },
    3: { open: '07:00', close: '17:30' },
    4: { open: '07:00', close: '17:30' },
    5: { open: '07:00', close: '17:30' },
    6: { open: '08:00', close: '15:00' },
    0: null,
  },
  hoursLabel: [
    { days: 'Mon–Fri', time: '07:00–17:30' },
    { days: 'Saturday', time: '08:00–15:00' },
    { days: 'Sunday', time: 'Kitchen closed' },
  ],
};

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
