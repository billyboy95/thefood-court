import { formatZAR } from '../lib/money.js';
import { formatSaPhone } from '../lib/phone.js';
import { kitchenWhatsAppDigits } from '../api/orderService.js';

export function providerPlan(env = {}, to) {
  const digits = kitchenWhatsAppDigits(to);
  const meta = Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);
  const twilio = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM);
  if (!digits) return { send: false, skipped: true, reason: 'WhatsApp number is not set' };
  if (meta) return { send: true, skipped: false, provider: 'meta', digits };
  if (twilio) return { send: true, skipped: false, provider: 'twilio', digits };
  return { send: false, skipped: true, reason: 'WhatsApp provider keys are not set', digits };
}

export function whatsappConfigured(env = {}) {
  return Boolean(
    (env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) ||
      (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM),
  );
}

async function sendMeta(env, text, digits, fetchImpl) {
  const url = `https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: digits,
      type: 'text',
      text: { body: text },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`WhatsApp Cloud ${res.status}: ${detail.slice(0, 180)}`);
  }
}

async function sendTwilio(env, text, digits, fetchImpl) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  let from = String(env.TWILIO_WHATSAPP_FROM || '').trim();
  if (!from.startsWith('whatsapp:')) {
    from = `whatsapp:${from.startsWith('+') ? from : `+${from.replace(/\D/g, '')}`}`;
  }
  const body = new URLSearchParams({
    From: from,
    To: `whatsapp:+${digits}`,
    Body: text,
  });
  const auth = btoa(`${sid}:${token}`);
  const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Twilio WhatsApp ${res.status}: ${detail.slice(0, 180)}`);
  }
}

/** Meta Cloud API first, Twilio second. No-op when the number or keys are unset. */
export async function sendWhatsApp({ env = {}, to, text, fetchImpl = fetch } = {}) {
  const plan = providerPlan(env, to);
  if (!plan.send) {
    return { sent: false, skipped: true, reason: plan.reason, provider: null };
  }
  try {
    if (plan.provider === 'meta') await sendMeta(env, text, plan.digits, fetchImpl);
    else await sendTwilio(env, text, plan.digits, fetchImpl);
    return { sent: true, skipped: false, provider: plan.provider };
  } catch (err) {
    return { sent: false, skipped: false, provider: plan.provider, error: String(err?.message || err) };
  }
}

export function numberAllowed(from, allowlist) {
  const digits = kitchenWhatsAppDigits(from);
  if (!digits) return false;
  const list = String(allowlist || '')
    .split(/[\s,;]+/)
    .map((value) => kitchenWhatsAppDigits(value))
    .filter(Boolean);
  if (!list.length) return false;
  return list.includes(digits);
}

export function metaVerify(params, token) {
  if (!token) return null;
  const mode = params?.['hub.mode'] || params?.hub_mode;
  const verify = params?.['hub.verify_token'] || params?.hub_verify_token;
  const challenge = params?.['hub.challenge'] || params?.hub_challenge;
  if (mode === 'subscribe' && verify === token) return String(challenge ?? '');
  return null;
}

export function formatReadyWhatsApp(order) {
  return [
    `Food Court: ${order.orderNumber} is ready.`,
    'Collect at the counter now.',
    order.pickupLabel ? `Slot ${order.pickupLabel}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatLowBalanceWhatsApp(student, thresholdCents) {
  return `Food Court wallet: your balance is ${formatZAR(student.balanceCents)}, under ${formatZAR(thresholdCents)}. Top up before the lunch rush.`;
}

export function formatNoShowReminder(order) {
  return `Food Court: ${order.orderNumber} is still waiting. Your slot was ${order.pickupLabel || 'earlier'}. Collect it or reply to the till.`;
}

export function formatChefNudge(dayLabel) {
  return `Food Court: send today's special. Reply with a photo and a caption like "${dayLabel} special: Burgers R55".`;
}

export function formatSpecialLive(special) {
  return `Special is live: ${special.name} — ${formatZAR(special.priceCents)} (${special.dayLabel || 'today'}).`;
}

export function formatSpecialRejected(reason) {
  return `Food Court could not publish that special. ${reason} Send a photo with a caption like "Monday special: Burgers R55".`;
}

export function formatLowStock(name, onHand, unit) {
  return `Food Court stock: ${name} is low (${onHand} ${unit}). Check the reorder list.`;
}

export function formatSoldOut(name) {
  return `Food Court: ${name} is sold out and hidden from the board.`;
}

export function formatRatingAlert(order, score) {
  return `Food Court rating ${score}/5 for ${order.orderNumber} (${order.customerName || 'student'}).`;
}

export function formatEodSummary({ date, revenueCents, topItems, wasteCents, cashToBankCents }) {
  const tops = (topItems || []).slice(0, 3).map((item) => `${item.qty}× ${item.name}`);
  return [
    `Food Court end of day ${date}`,
    `Revenue ${formatZAR(revenueCents)}`,
    tops.length ? `Top: ${tops.join(', ')}` : 'Top: none',
    `Waste ${formatZAR(wasteCents)}`,
    `Cash to bank ${formatZAR(cashToBankCents)}`,
  ].join('\n');
}

export function paymentLabel(order) {
  if (order?.loyaltyRedeemed && order.totalCents === 0) return 'Free meal · loyalty';
  if (order?.paymentMethod === 'wallet') return 'Paid from wallet';
  if (order?.paymentMethod === 'card') return 'Paid by card';
  if (order?.paymentStatus === 'paid') return 'Paid on collection';
  return 'Pay at counter';
}

export function formatPhone(phone) {
  return formatSaPhone(phone);
}
