/** Operational thresholds. Provider keys never live here. */

export const DEFAULT_SETTINGS = {
  lowBalanceCents: 5000,
  autoTopupCents: 10000,
  noShowReminderMinutes: 30,
  noShowActionMinutes: 90,
  noShowAction: 'refund',
  slotCapacity: 8,
  loyaltyTarget: 10,
  ratingAlertMax: 2,
  portionLowThreshold: 5,
  chefNudgeHour: 7,
  specialDeadlineHour: 9,
  eodHour: 17,
  forecastHour: 6,
  managerWhatsapp: '',
  kitchenWhatsapp: '',
  chefWhatsappAllowlist: '',
  managerEmail: '',
  reportsEmail: '',
};

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function mergeSettings(raw) {
  const next = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return next;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (raw[key] !== undefined && raw[key] !== null) next[key] = raw[key];
  }
  next.lowBalanceCents = clampInt(next.lowBalanceCents, 0, 1_000_000, DEFAULT_SETTINGS.lowBalanceCents);
  next.autoTopupCents = clampInt(next.autoTopupCents, 0, 1_000_000, DEFAULT_SETTINGS.autoTopupCents);
  next.noShowReminderMinutes = clampInt(next.noShowReminderMinutes, 5, 24 * 60, DEFAULT_SETTINGS.noShowReminderMinutes);
  next.noShowActionMinutes = clampInt(
    next.noShowActionMinutes,
    next.noShowReminderMinutes,
    48 * 60,
    DEFAULT_SETTINGS.noShowActionMinutes,
  );
  next.slotCapacity = clampInt(next.slotCapacity, 1, 200, DEFAULT_SETTINGS.slotCapacity);
  next.loyaltyTarget = clampInt(next.loyaltyTarget, 2, 50, DEFAULT_SETTINGS.loyaltyTarget);
  next.ratingAlertMax = clampInt(next.ratingAlertMax, 1, 5, DEFAULT_SETTINGS.ratingAlertMax);
  next.portionLowThreshold = clampInt(next.portionLowThreshold, 0, 500, DEFAULT_SETTINGS.portionLowThreshold);
  next.chefNudgeHour = clampInt(next.chefNudgeHour, 0, 23, DEFAULT_SETTINGS.chefNudgeHour);
  next.specialDeadlineHour = clampInt(next.specialDeadlineHour, 0, 23, DEFAULT_SETTINGS.specialDeadlineHour);
  next.eodHour = clampInt(next.eodHour, 0, 23, DEFAULT_SETTINGS.eodHour);
  next.forecastHour = clampInt(next.forecastHour, 0, 23, DEFAULT_SETTINGS.forecastHour);
  next.noShowAction = next.noShowAction === 'write_off' ? 'write_off' : 'refund';
  for (const key of [
    'managerWhatsapp',
    'kitchenWhatsapp',
    'chefWhatsappAllowlist',
    'managerEmail',
    'reportsEmail',
  ]) {
    next[key] = String(next[key] ?? '').trim();
  }
  return next;
}

/** Env destination numbers override the settings page when they are set. */
export function resolveDestinations(settings, env = {}) {
  const s = mergeSettings(settings);
  return {
    ...s,
    managerWhatsapp: String(env.MANAGER_WHATSAPP || s.managerWhatsapp || '').trim(),
    kitchenWhatsapp: String(env.KITCHEN_WHATSAPP || s.kitchenWhatsapp || '').trim(),
    chefWhatsappAllowlist: String(env.CHEF_WHATSAPP_ALLOWLIST || s.chefWhatsappAllowlist || '').trim(),
    managerEmail: String(env.MANAGER_EMAIL || s.managerEmail || '').trim(),
    reportsEmail: String(env.REPORTS_EMAIL || env.MANAGER_EMAIL || s.reportsEmail || s.managerEmail || '').trim(),
  };
}
