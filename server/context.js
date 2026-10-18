import webpush from 'web-push';
import { loadConfig, isPlaceholder } from './config.js';
import { generateRsa } from './crypto.js';
import { one, openDatabase, run, seed } from './db.js';

function ensureVapid(ctx) {
  if (!isPlaceholder(ctx.config.vapidPublic) && !isPlaceholder(ctx.config.vapidPrivate)) {
    return { publicKey: ctx.config.vapidPublic, privateKey: ctx.config.vapidPrivate };
  }
  const existing = one(ctx.db, `SELECT value FROM app_secrets WHERE key = 'vapid'`);
  if (existing) return JSON.parse(existing.value);
  const keys = webpush.generateVAPIDKeys();
  run(ctx.db, `INSERT INTO app_secrets (key, value) VALUES ('vapid', ?)`, JSON.stringify(keys));
  return keys;
}

export function createContext(opts = {}) {
  const config = opts.config || loadConfig(opts.env || process.env);
  const now = opts.now || (() => new Date());
  const db = openDatabase(opts.dbPath || config.dbPath);
  seed(db, now().toISOString());
  const ctx = {
    db,
    config,
    keys: opts.keys || generateRsa(),
    now,
    issuer: config.issuer || 'https://auth.thefood-court.co.za',
    vapid: null,
  };
  ctx.vapid = ensureVapid(ctx);
  return ctx;
}
