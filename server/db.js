import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { menuItems } from '../js/data/menu.js';
import { hashPin } from './crypto.js';

export const ENTITIES = [
  { id: 'holdings', name: 'Holdings' },
  { id: 'eastc-varsity', name: 'EASTC Technocentric Varsity' },
  { id: 'eastech-institute', name: 'EASTECH Institute' },
  { id: 'eastc-tech-school', name: 'EASTC Technical School' },
  { id: 'eastc-foundation', name: 'EASTC Foundation' },
  { id: 'food-court', name: 'Food Court' },
];

export const DEMO = {
  students: [
    { number: 'STU1001', name: 'Thabo Mokoena', phone: '+27821001001', pin: '1001', account: true },
    { number: 'STU1002', name: 'Lerato Dlamini', phone: '+27821001002', pin: '1002', account: true },
    { number: 'STU1003', name: 'Ayesha Khan', phone: '+27821001003', pin: '1003', account: true },
    { number: 'STU1004', name: 'Johan Botha', phone: '+27821001004', pin: null, account: false },
    { number: 'STU1005', name: 'Naledi Khumalo', phone: '+27821001005', pin: '1005', account: true },
  ],
  educators: [
    {
      number: 'EDU2001',
      name: 'Thandi Nkosi',
      phone: '+27822002001',
      pin: '2001',
      title: 'Educator',
      salaryCents: 2500000,
      account: true,
    },
    {
      number: 'EDU2002',
      name: 'Mark Jacobs',
      phone: '+27822002002',
      pin: null,
      title: 'Educator',
      salaryCents: 1800000,
      account: false,
    },
  ],
  parent: {
    username: 'parent.stu1001',
    name: 'Kelebogile Mokoena',
    phone: '+27821001101',
    pin: '1010',
    studentNumber: 'STU1001',
  },
  staff: [
    { username: 'billy', name: 'Billy', pin: '0000', role: 'owner', till: null },
    { username: 'cashier1', name: 'Amahle Cashier', pin: '1111', role: 'cashier', till: 'till-1' },
    { username: 'cashier2', name: 'Pieter Cashier', pin: '2222', role: 'cashier', till: 'till-2' },
    { username: 'kitchen1', name: 'Sipho Kitchen', pin: '3333', role: 'kitchen', till: null },
    { username: 'supervisor', name: 'Nomsa Supervisor', pin: '4444', role: 'supervisor', till: null },
    { username: 'manager', name: 'Lindiwe Manager', pin: '5555', role: 'manager', till: null },
    { username: 'finance', name: 'Ravi Finance', pin: '6666', role: 'finance', till: null },
  ],
};

export function one(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

export function all(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      username TEXT UNIQUE,
      student_number TEXT UNIQUE,
      staff_number TEXT UNIQUE,
      linked_student_number TEXT,
      name TEXT NOT NULL,
      phone TEXT,
      pin_hash TEXT,
      popia_accepted_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      role TEXT NOT NULL,
      till_id TEXT,
      PRIMARY KEY (user_id, entity_id, role)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      refresh_hash TEXT NOT NULL,
      device_id TEXT,
      remember INTEGER NOT NULL DEFAULT 0,
      active_entity TEXT NOT NULL,
      user_agent TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT
    );
    CREATE TABLE IF NOT EXISTS passkeys (
      credential_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webauthn_challenges (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      kind TEXT NOT NULL,
      challenge TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      redirect_uris TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT,
      entity_id TEXT,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS student_registry (
      student_number TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      phone TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS menu_items (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      price_cents INTEGER NOT NULL,
      cost_cents INTEGER NOT NULL,
      image TEXT,
      stock_qty INTEGER NOT NULL,
      available INTEGER NOT NULL DEFAULT 1,
      available_days TEXT,
      popular INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      order_number TEXT NOT NULL UNIQUE,
      channel TEXT NOT NULL,
      student_number TEXT,
      member_number TEXT,
      member_kind TEXT,
      customer_name TEXT NOT NULL,
      phone TEXT,
      notes TEXT,
      pickup_time TEXT,
      pickup_label TEXT,
      payment_status TEXT NOT NULL,
      payment_method TEXT,
      fulfillment TEXT NOT NULL,
      kitchen_visible INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL,
      till_id TEXT,
      created_by_staff_id TEXT,
      paid_by_staff_id TEXT,
      paid_at TEXT,
      tendered_cents INTEGER,
      change_cents INTEGER,
      expires_at TEXT,
      collected_at TEXT,
      collected_via TEXT,
      yoco_reference TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      name TEXT NOT NULL,
      qty INTEGER NOT NULL,
      unit_price_cents INTEGER NOT NULL,
      unit_cost_cents INTEGER NOT NULL,
      line_total_cents INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_intents (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      method TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'ZAR',
      status TEXT NOT NULL,
      payer_user_id TEXT,
      student_number TEXT,
      order_id TEXT,
      reference TEXT,
      yoco_reference TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journal_entries (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      memo TEXT,
      ref_type TEXT,
      ref_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journal_lines (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      account TEXT NOT NULL,
      debit_cents INTEGER NOT NULL DEFAULT 0,
      credit_cents INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS staff_registry (
      staff_number TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      phone TEXT,
      title TEXT,
      monthly_salary_cents INTEGER,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS wallet_accounts (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      member_number TEXT NOT NULL,
      member_kind TEXT NOT NULL,
      user_id TEXT,
      daily_limit_cents INTEGER NOT NULL,
      monthly_limit_cents INTEGER NOT NULL,
      low_balance_cents INTEGER NOT NULL,
      daily_allowance_enabled INTEGER NOT NULL DEFAULT 0,
      monthly_budget_cents INTEGER,
      allowance_cents INTEGER,
      allowance_day INTEGER,
      last_allowance_reminder TEXT,
      last_low_alert TEXT,
      UNIQUE (entity_id, member_number)
    );
    CREATE TABLE IF NOT EXISTS salary_allocations (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      staff_number TEXT NOT NULL,
      mode TEXT NOT NULL,
      amount_cents INTEGER,
      percent INTEGER,
      declared_salary_cents INTEGER,
      payday_day INTEGER NOT NULL,
      consent_at TEXT NOT NULL,
      consent_text TEXT NOT NULL,
      status TEXT NOT NULL,
      cancelled_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payroll_instructions (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      allocation_id TEXT NOT NULL,
      staff_number TEXT NOT NULL,
      period TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      adapter TEXT NOT NULL,
      detail_json TEXT,
      created_at TEXT NOT NULL,
      applied_at TEXT,
      UNIQUE (allocation_id, period)
    );
    CREATE TABLE IF NOT EXISTS tap_nonces (
      nonce TEXT PRIMARY KEY,
      student_number TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      order_id TEXT,
      user_id TEXT,
      audience TEXT NOT NULL,
      channel TEXT NOT NULL,
      event TEXT NOT NULL,
      to_address TEXT,
      body TEXT NOT NULL,
      provider TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inapp_notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      read_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      keys_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      actor_id TEXT,
      actor_role TEXT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_ref TEXT,
      reason TEXT,
      detail_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      name TEXT NOT NULL,
      contact TEXT,
      phone TEXT
    );
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      supplier_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      received_at TEXT
    );
    CREATE TABLE IF NOT EXISTS purchase_lines (
      id TEXT PRIMARY KEY,
      po_id TEXT NOT NULL,
      item_id TEXT,
      description TEXT,
      qty INTEGER NOT NULL,
      unit_cost_cents INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      category TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      note TEXT,
      receipt_path TEXT,
      status TEXT NOT NULL,
      created_by TEXT,
      approved_by TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tills (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cashups (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      till_id TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      business_date TEXT NOT NULL,
      opening_cents INTEGER NOT NULL,
      cash_sales_cents INTEGER NOT NULL,
      expected_cents INTEGER NOT NULL,
      counted_cents INTEGER NOT NULL,
      variance_cents INTEGER NOT NULL,
      notes TEXT,
      closed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rate_events (
      id TEXT PRIMARY KEY,
      student_number TEXT NOT NULL,
      action TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      entity_id TEXT PRIMARY KEY,
      kitchen_starts TEXT NOT NULL,
      cash_expire_minutes INTEGER NOT NULL,
      unpaid_cash_cap INTEGER NOT NULL,
      order_rate_per_10_min INTEGER NOT NULL,
      low_balance_cents INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhook_receipts (
      id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crm_inbox (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_secrets (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function seed(db, nowIso) {
  if (one(db, 'SELECT id FROM entities LIMIT 1')) return;
  const now = nowIso;
  for (const entity of ENTITIES) {
    run(db, 'INSERT INTO entities (id, name) VALUES (?, ?)', entity.id, entity.name);
  }
  run(
    db,
    `INSERT INTO settings (entity_id, kitchen_starts, cash_expire_minutes, unpaid_cash_cap, order_rate_per_10_min, low_balance_cents)
     VALUES ('food-court', 'after_cash', 20, 2, 8, 5000)`,
  );
  run(db, `INSERT INTO tills (id, entity_id, name) VALUES ('till-1', 'food-court', 'Till 1')`);
  run(db, `INSERT INTO tills (id, entity_id, name) VALUES ('till-2', 'food-court', 'Till 2')`);

  for (const item of menuItems) {
    run(
      db,
      `INSERT INTO menu_items (
        id, entity_id, category, name, description, price_cents, cost_cents, image, stock_qty, available, available_days, popular
      ) VALUES (?, 'food-court', ?, ?, ?, ?, ?, ?, 40, 1, ?, ?)`,
      item.id,
      item.category,
      item.name,
      item.description,
      item.priceCents,
      Math.round(item.priceCents * 0.4),
      item.image,
      item.availableDays ? JSON.stringify(item.availableDays) : null,
      item.popular ? 1 : 0,
    );
  }

  for (const student of DEMO.students) {
    run(
      db,
      'INSERT INTO student_registry (student_number, full_name, phone, active) VALUES (?, ?, ?, 1)',
      student.number,
      student.name,
      student.phone,
    );
    run(
      db,
      `INSERT INTO wallet_accounts (
        id, entity_id, member_number, member_kind, user_id, daily_limit_cents, monthly_limit_cents, low_balance_cents,
        daily_allowance_enabled, monthly_budget_cents, allowance_cents, allowance_day, last_allowance_reminder
      ) VALUES (?, 'food-court', ?, 'student', ?, 30000, 200000, 5000, ?, ?, ?, 1, ?)`,
      `wal-${student.number}`,
      student.number,
      student.account ? `user-${student.number.toLowerCase()}` : null,
      student.number === 'STU1001' ? 1 : 0,
      student.number === 'STU1001' ? 200000 : null,
      student.number === 'STU1001' ? 200000 : null,
      now.slice(0, 7),
    );
    if (!student.account) continue;
    const id = `user-${student.number.toLowerCase()}`;
    run(
      db,
      `INSERT INTO users (id, kind, username, student_number, name, phone, pin_hash, popia_accepted_at, created_at)
       VALUES (?, 'student', ?, ?, ?, ?, ?, ?, ?)`,
      id,
      student.number.toLowerCase(),
      student.number,
      student.name,
      student.phone,
      hashPin(student.pin),
      now,
      now,
    );
    run(
      db,
      `INSERT INTO user_roles (user_id, entity_id, role, till_id) VALUES (?, 'food-court', 'student', NULL)`,
      id,
    );
  }

  for (const educator of DEMO.educators) {
    run(
      db,
      `INSERT INTO staff_registry (staff_number, full_name, phone, title, monthly_salary_cents, active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      educator.number,
      educator.name,
      educator.phone,
      educator.title,
      educator.salaryCents,
    );
    const userId = educator.account ? `user-${educator.number.toLowerCase()}` : null;
    run(
      db,
      `INSERT INTO wallet_accounts (
        id, entity_id, member_number, member_kind, user_id, daily_limit_cents, monthly_limit_cents, low_balance_cents,
        daily_allowance_enabled, monthly_budget_cents, allowance_day, last_allowance_reminder
      ) VALUES (?, 'food-court', ?, 'staff', ?, 50000, 250000, 5000, 1, 200000, 25, ?)`,
      `wal-${educator.number}`,
      educator.number,
      userId,
      now.slice(0, 7),
    );
    if (!educator.account) continue;
    run(
      db,
      `INSERT INTO users (id, kind, username, staff_number, name, phone, pin_hash, popia_accepted_at, created_at)
       VALUES (?, 'educator', ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      educator.number.toLowerCase(),
      educator.number,
      educator.name,
      educator.phone,
      hashPin(educator.pin),
      now,
      now,
    );
    run(
      db,
      `INSERT INTO user_roles (user_id, entity_id, role, till_id) VALUES (?, 'food-court', 'educator', NULL)`,
      userId,
    );
    run(
      db,
      `INSERT INTO salary_allocations (
        id, entity_id, user_id, staff_number, mode, percent, declared_salary_cents, payday_day, consent_at, consent_text, status, created_at
      ) VALUES ('alloc-edu2001', 'food-court', ?, ?, 'percent', 10, ?, 25, ?, ?, 'active', ?)`,
      userId,
      educator.number,
      educator.salaryCents,
      now,
      'I consent to a payroll deduction instruction of 10% of my declared monthly salary into my EASTC food wallet each payday. I can cancel this at any time.',
      now,
    );
  }

  const parent = DEMO.parent;
  run(
    db,
    `INSERT INTO users (id, kind, username, linked_student_number, name, phone, pin_hash, popia_accepted_at, created_at)
     VALUES ('user-parent-stu1001', 'parent', ?, ?, ?, ?, ?, ?, ?)`,
    parent.username,
    parent.studentNumber,
    parent.name,
    parent.phone,
    hashPin(parent.pin),
    now,
    now,
  );
  run(
    db,
    `INSERT INTO user_roles (user_id, entity_id, role, till_id) VALUES ('user-parent-stu1001', 'food-court', 'parent', NULL)`,
  );

  for (const staff of DEMO.staff) {
    const id = `user-${staff.username}`;
    run(
      db,
      `INSERT INTO users (id, kind, username, name, phone, pin_hash, created_at)
       VALUES (?, 'staff', ?, ?, ?, ?, ?)`,
      id,
      staff.username,
      staff.name,
      '+27113941488',
      hashPin(staff.pin),
      now,
    );
    if (staff.role === 'owner') {
      for (const entity of ENTITIES) {
        run(
          db,
          `INSERT INTO user_roles (user_id, entity_id, role, till_id) VALUES (?, ?, 'owner', NULL)`,
          id,
          entity.id,
        );
      }
    } else {
      run(
        db,
        `INSERT INTO user_roles (user_id, entity_id, role, till_id) VALUES (?, 'food-court', ?, ?)`,
        id,
        staff.role,
        staff.till,
      );
    }
  }

  run(
    db,
    `INSERT INTO oauth_clients (client_id, name, redirect_uris) VALUES (?, ?, ?)`,
    'eastc-crm',
    'EASTC CRM',
    JSON.stringify(['https://crm.eastc.example/auth/callback', 'http://localhost:5173/oauth/callback']),
  );
  run(
    db,
    `INSERT INTO suppliers (id, entity_id, name, contact, phone) VALUES ('sup-fresh', 'food-court', 'Fresh Farm Stall', 'Jabu', '+27821110000')`,
  );
}
