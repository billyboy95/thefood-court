import {
  formatKitchenWhatsApp,
  kitchenWhatsAppDigits,
  whatsappProvidersConfigured,
} from '../../js/api/orderService.js';

function e164(digits) {
  return digits ? `+${digits}` : '';
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
    To: `whatsapp:${e164(digits)}`,
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
    throw new Error(`Twilio WhatsApp ${res.status}: ${detail.slice(0, 200)}`);
  }
}

async function sendCallMeBot(env, text, digits, fetchImpl) {
  const url = new URL('https://api.callmebot.com/whatsapp.php');
  url.searchParams.set('phone', digits);
  url.searchParams.set('text', text);
  url.searchParams.set('apikey', env.CALLMEBOT_APIKEY);
  const res = await fetchImpl(url.toString(), {
    headers: { Accept: 'text/plain,application/json' },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`CallMeBot ${res.status}: ${detail.slice(0, 200)}`);
  }
}

/**
 * Ping the kitchen WhatsApp. Fail soft: never throw to the order caller.
 * Prefer Twilio when fully configured; otherwise CallMeBot.
 */
export async function notifyKitchenWhatsApp(env, order, { fetchImpl = fetch } = {}) {
  const cfg = whatsappProvidersConfigured(env);
  if (!cfg.phone) {
    return { sent: false, skipped: true, reason: 'KITCHEN_WHATSAPP is not set' };
  }
  const text = formatKitchenWhatsApp(order);
  try {
    if (cfg.twilio) {
      await sendTwilio(env, text, cfg.phone, fetchImpl);
      return { sent: true, provider: 'twilio' };
    }
    if (cfg.callmebot) {
      await sendCallMeBot(env, text, cfg.phone, fetchImpl);
      return { sent: true, provider: 'callmebot' };
    }
    return { sent: false, skipped: true, reason: 'No WhatsApp provider secrets' };
  } catch (err) {
    console.error('kitchen WhatsApp failed', err);
    return { sent: false, skipped: false, error: String(err?.message || err) };
  }
}

export function whatsappEnabled(env) {
  const cfg = whatsappProvidersConfigured(env);
  return Boolean(cfg.twilio || cfg.callmebot);
}
