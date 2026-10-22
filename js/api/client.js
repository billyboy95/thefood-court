import { SUPABASE_ANON_KEY as CONFIG_ANON_KEY, SUPABASE_URL as CONFIG_URL } from '../config.js';
import { getLocalStorage } from '../lib/dom.js';
import { createMockOrderApi } from './mockBackend.js';
import { createSupabaseOrderApi } from './supabaseBackend.js';

export function resolveSupabaseConfig() {
  const host = typeof globalThis !== 'undefined' ? globalThis : {};
  const url = String(host.SUPABASE_URL || CONFIG_URL || '').trim().replace(/\/$/, '');
  const anonKey = String(host.SUPABASE_ANON_KEY || CONFIG_ANON_KEY || '').trim();
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export function createOrderApi({
  storage = getLocalStorage(),
  nowFn,
  staffPin,
  seedDemo = true,
} = {}) {
  const live = resolveSupabaseConfig();
  if (live) return createSupabaseOrderApi(live);
  return createMockOrderApi(storage, { nowFn, staffPin, seedDemo });
}
