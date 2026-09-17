const DIGITS = /[^\d]/g;

/**
 * Accept SA mobile/landline: 0XXXXXXXXX or +27XXXXXXXXX.
 * @returns {string|null} E.164 (+27…)
 */
export function normalizeSaPhone(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const digits = raw.replace(DIGITS, '');
  if (digits.startsWith('27') && digits.length === 11) {
    return `+${digits}`;
  }
  if (digits.startsWith('0') && digits.length === 10) {
    return `+27${digits.slice(1)}`;
  }
  return null;
}

export function isValidSaPhone(input) {
  return Boolean(normalizeSaPhone(input));
}

export function formatSaPhone(e164) {
  const digits = String(e164 ?? '').replace(DIGITS, '');
  if (digits.startsWith('27') && digits.length === 11) {
    const local = `0${digits.slice(2)}`;
    return `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
  }
  return String(e164 ?? '');
}
