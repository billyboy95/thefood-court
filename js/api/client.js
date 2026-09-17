import { createMockOrderApi } from './mockBackend.js';
import { createHttpOrderApi } from './httpBackend.js';
import { getLocalStorage } from '../lib/dom.js';

/**
 * Set window.FOODCOURT_API_URL (or this default) to point at a live API.
 * Leave empty to use the localStorage mock kitchen.
 */
export const DEFAULT_API_URL = '';

export function createOrderApi({
  baseUrl = DEFAULT_API_URL,
  storage = getLocalStorage(),
} = {}) {
  const liveUrl =
    baseUrl ||
    (typeof globalThis !== 'undefined' && globalThis.FOODCOURT_API_URL) ||
    '';
  if (liveUrl) return createHttpOrderApi(liveUrl);
  return createMockOrderApi(storage);
}
