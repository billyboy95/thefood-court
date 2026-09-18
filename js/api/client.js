import { FOODCOURT_API_URL as CONFIG_API_URL } from '../config.js';
import { getLocalStorage } from '../lib/dom.js';
import { createHttpOrderApi } from './httpBackend.js';
import { createMockOrderApi } from './mockBackend.js';

/**
 * Set window.FOODCOURT_API_URL, js/config.js FOODCOURT_API_URL, or this default
 * to point at the Cloudflare Worker. Leave empty to use the localStorage mock.
 */
export const DEFAULT_API_URL = '';

export function resolveApiUrl(baseUrl = DEFAULT_API_URL) {
  const fromWindow =
    typeof globalThis !== 'undefined' && globalThis.FOODCOURT_API_URL
      ? String(globalThis.FOODCOURT_API_URL)
      : '';
  return String(baseUrl || fromWindow || CONFIG_API_URL || '').replace(/\/$/, '');
}

export function createOrderApi({
  baseUrl = DEFAULT_API_URL,
  storage = getLocalStorage(),
  nowFn,
  staffPin,
} = {}) {
  const liveUrl = resolveApiUrl(baseUrl);
  if (liveUrl) return createHttpOrderApi(liveUrl);
  return createMockOrderApi(storage, { nowFn, staffPin });
}
