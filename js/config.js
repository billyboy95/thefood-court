/**
 * Shared kitchen API (Cloudflare Worker). Leave empty for localStorage demo mode.
 *
 * After `npx wrangler deploy`, paste the Worker URL here — both the student app
 * and /kitchen.html read this. Example:
 *   "https://thefood-court-api.<your-account>.workers.dev"
 *
 * You can still override at runtime with window.FOODCOURT_API_URL in index.html
 * or kitchen.html (handy for pointing at http://localhost:8787).
 */
export const FOODCOURT_API_URL = '';
