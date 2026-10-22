export function postLedger(student, entry) {
  const amount = Math.trunc(Number(entry.amountCents));
  if (!Number.isFinite(amount) || amount === 0) {
    throw new Error('Enter a valid amount.');
  }
  const balance = Math.trunc(Number(student.balanceCents) || 0);
  const next = balance + amount;
  if (next < 0) throw new Error('Insufficient wallet balance.');
  const row = {
    id: entry.id,
    studentId: student.id,
    amountCents: amount,
    balanceAfterCents: next,
    kind: entry.kind,
    paymentMethod: entry.paymentMethod || null,
    orderId: entry.orderId || null,
    provider: entry.provider || null,
    providerRef: entry.providerRef || null,
    note: entry.note || '',
    createdAt: entry.createdAt,
    demo: Boolean(entry.demo || student.demo),
  };
  return {
    student: { ...student, balanceCents: next },
    entry: row,
  };
}

const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makePayToken(studentId, now = new Date(), { ttlMs = 45000, random = Math.random } = {}) {
  let token = '';
  for (let i = 0; i < 8; i += 1) token += TOKEN_ALPHABET[Math.floor(random() * TOKEN_ALPHABET.length)];
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  return {
    token,
    studentId,
    expiresAt,
    consumedAt: null,
    payload: `FC1.${token}`,
    createdAt: now.toISOString(),
  };
}

export function parsePayPayload(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/^FC1\.([A-Z0-9]+)$/i);
  return match ? match[1].toUpperCase() : '';
}

export function tokenUsable(row, now = new Date()) {
  if (!row || row.consumedAt) return false;
  const exp = Date.parse(row.expiresAt);
  return Number.isFinite(exp) && exp > now.getTime();
}
