import { randomId } from './crypto.js';
import { all, one, run } from './db.js';
import { HttpError } from './errors.js';

export function postJournal(db, { entityId, memo, refType, refId, lines, now }) {
  const debits = lines.reduce((sum, line) => sum + Number(line.debitCents || 0), 0);
  const credits = lines.reduce((sum, line) => sum + Number(line.creditCents || 0), 0);
  if (!lines.length || debits !== credits || debits < 0) {
    throw new HttpError(500, 'Journal entry is not balanced.');
  }
  const id = randomId();
  run(
    db,
    `INSERT INTO journal_entries (id, entity_id, memo, ref_type, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    entityId,
    memo || '',
    refType || '',
    refId || '',
    now,
  );
  for (const line of lines) {
    run(
      db,
      `INSERT INTO journal_lines (id, entry_id, account, debit_cents, credit_cents) VALUES (?, ?, ?, ?, ?)`,
      randomId(),
      id,
      line.account,
      Math.round(line.debitCents || 0),
      Math.round(line.creditCents || 0),
    );
  }
  return id;
}

export function accountBalance(db, account, entityId) {
  const row = one(
    db,
    `SELECT
       COALESCE(SUM(l.credit_cents), 0) AS credits,
       COALESCE(SUM(l.debit_cents), 0) AS debits
     FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account = ? AND e.entity_id = ?`,
    account,
    entityId,
  );
  return Number(row?.credits || 0) - Number(row?.debits || 0);
}

export function trialBalance(db, entityId) {
  const row = one(
    db,
    `SELECT COALESCE(SUM(l.debit_cents), 0) AS debit, COALESCE(SUM(l.credit_cents), 0) AS credit
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE e.entity_id = ?`,
    entityId,
  );
  const debit = Number(row?.debit || 0);
  const credit = Number(row?.credit || 0);
  return { debitCents: debit, creditCents: credit, balanced: debit === credit };
}

export function walletAccount(studentNumber) {
  return `liability:wallet:${studentNumber}`;
}

export function walletBalance(db, studentNumber, entityId = 'food-court') {
  return accountBalance(db, walletAccount(studentNumber), entityId);
}

export function statement(db, studentNumber, entityId = 'food-court') {
  const account = walletAccount(studentNumber);
  const lines = all(
    db,
    `SELECT e.id AS entry_id, e.memo, e.ref_type, e.ref_id, e.created_at, l.debit_cents, l.credit_cents
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account = ? AND e.entity_id = ?
     ORDER BY e.created_at ASC, e.id ASC`,
    account,
    entityId,
  );
  let running = 0;
  return lines.map((line) => {
    running += Number(line.credit_cents) - Number(line.debit_cents);
    return { ...line, balanceCents: running };
  });
}

export function spendInRange(db, studentNumber, entityId, fromIso, toIso) {
  const account = walletAccount(studentNumber);
  const row = one(
    db,
    `SELECT
       COALESCE(SUM(CASE WHEN e.ref_type = 'food_sale' THEN l.debit_cents ELSE 0 END), 0) AS spent,
       COALESCE(SUM(CASE WHEN e.ref_type = 'refund' THEN l.credit_cents ELSE 0 END), 0) AS refunded
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account = ? AND e.entity_id = ? AND e.created_at >= ? AND e.created_at < ?`,
    account,
    entityId,
    fromIso,
    toIso,
  );
  return Number(row?.spent || 0) - Number(row?.refunded || 0);
}
