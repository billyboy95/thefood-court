import { md5 } from './md5.js';

export function selectPaymentProvider(env = {}) {
  if (env.YOCO_SECRET_KEY) return 'yoco';
  if (env.PAYFAST_MERCHANT_ID && env.PAYFAST_MERCHANT_KEY && env.PAYFAST_PASSPHRASE) return 'payfast';
  return 'stub';
}

export function payfastSignature(fields, passphrase = '') {
  const pairs = Object.entries(fields)
    .filter(([key, value]) => key !== 'signature' && value !== undefined && value !== null && String(value) !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value)).replace(/%20/g, '+')}`);
  let str = pairs.join('&');
  if (passphrase) str += `&passphrase=${encodeURIComponent(passphrase).replace(/%20/g, '+')}`;
  return md5(str);
}

/**
 * Yoco first, PayFast second. With no keys this is a demo stub that reports paid
 * and never contacts a provider.
 */
export async function createCheckout({
  env = {},
  amountCents,
  reference,
  kind = 'topup',
  successUrl = '',
  cancelUrl = '',
  itemName = 'Food Court',
  fetchImpl = fetch,
} = {}) {
  const amount = Math.trunc(Number(amountCents));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a valid amount.');
  const provider = selectPaymentProvider(env);

  if (provider === 'stub') {
    return {
      provider: 'stub',
      mode: 'stub',
      status: 'paid',
      reference,
      amountCents: amount,
      kind,
      demo: true,
    };
  }

  if (provider === 'yoco') {
    const res = await fetchImpl('https://payments.yoco.com/api/checkouts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.YOCO_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount,
        currency: 'ZAR',
        successUrl,
        cancelUrl,
        failureUrl: cancelUrl,
        metadata: { reference, kind },
        externalId: reference,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Yoco ${res.status}: ${detail.slice(0, 180)}`);
    }
    const body = await res.json();
    return {
      provider: 'yoco',
      mode: 'redirect',
      status: 'pending',
      reference,
      amountCents: amount,
      kind,
      checkoutId: body.id,
      redirectUrl: body.redirectUrl,
      demo: false,
    };
  }

  const fields = {
    merchant_id: env.PAYFAST_MERCHANT_ID,
    merchant_key: env.PAYFAST_MERCHANT_KEY,
    amount: (amount / 100).toFixed(2),
    item_name: itemName,
    m_payment_id: reference,
  };
  fields.signature = payfastSignature(fields, env.PAYFAST_PASSPHRASE);
  const sandbox = String(env.PAYFAST_SANDBOX || '') === '1';
  return {
    provider: 'payfast',
    mode: 'redirect',
    status: 'pending',
    reference,
    amountCents: amount,
    kind,
    url: sandbox ? 'https://sandbox.payfast.co.za/eng/process' : 'https://www.payfast.co.za/eng/process',
    fields,
    demo: false,
  };
}

export async function refundCard({ env = {}, provider, checkoutId, amountCents, fetchImpl = fetch } = {}) {
  if (!env.YOCO_SECRET_KEY || provider !== 'yoco' || !checkoutId) {
    return { refunded: false, skipped: true, reason: 'Card refund keys are not set' };
  }
  const res = await fetchImpl(`https://payments.yoco.com/api/checkouts/${checkoutId}/refund`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.YOCO_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ amount: Math.trunc(Number(amountCents)) }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { refunded: false, skipped: false, error: `Yoco refund ${res.status}: ${detail.slice(0, 180)}` };
  }
  return { refunded: true, skipped: false, provider: 'yoco' };
}

export async function fetchProviderPayments({ env = {}, from, to, fetchImpl = fetch } = {}) {
  const provider = selectPaymentProvider(env);
  if (provider === 'stub') return { skipped: true, reason: 'Payment provider keys are not set', payments: null };
  if (provider === 'yoco') {
    const url = new URL('https://payments.yoco.com/api/checkouts');
    if (from) url.searchParams.set('createdAfter', from);
    if (to) url.searchParams.set('createdBefore', to);
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${env.YOCO_SECRET_KEY}` } });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Yoco list ${res.status}: ${detail.slice(0, 180)}`);
    }
    const body = await res.json();
    const payments = (body.checkouts || body.data || []).map((row) => ({
      reference: row.metadata?.reference || row.externalId || row.id,
      amountCents: Number(row.amount),
      status: row.status,
      provider: 'yoco',
    }));
    return { skipped: false, provider: 'yoco', payments };
  }
  return {
    skipped: true,
    reason: 'PayFast has no transaction-list API in this adapter — import the statement or use Yoco',
    payments: null,
    provider: 'payfast',
  };
}
