import webpush from 'web-push';
import { randomId } from './crypto.js';
import { all, run } from './db.js';
import { isPlaceholder } from './config.js';

export function providerReady(config) {
  const name = config.whatsappProvider;
  if (name === 'cloud') {
    return !isPlaceholder(config.whatsappCloudToken) && !isPlaceholder(config.whatsappCloudPhoneId);
  }
  if (name === 'bird') {
    return !isPlaceholder(config.birdApiKey) && !isPlaceholder(config.birdChannelId);
  }
  if (name === 'twilio') {
    return !isPlaceholder(config.twilioSid) && !isPlaceholder(config.twilioToken) && !isPlaceholder(config.twilioFrom);
  }
  return false;
}

async function dispatch(config, message, fetchImpl) {
  if (!providerReady(config)) {
    return { provider: 'mock', delivered: false };
  }
  const provider = config.whatsappProvider;
  try {
    if (provider === 'twilio') {
      const from = String(config.twilioFrom).startsWith('whatsapp:')
        ? config.twilioFrom
        : `whatsapp:${config.twilioFrom}`;
      const to = message.channel === 'sms' ? message.to : `whatsapp:${message.to}`;
      const body = new URLSearchParams({ From: from, To: to, Body: message.body });
      const auth = Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString('base64');
      const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${config.twilioSid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!res.ok) throw new Error(`Twilio ${res.status}`);
      return { provider: 'twilio', delivered: true };
    }
    if (provider === 'cloud') {
      const res = await fetchImpl(
        `https://graph.facebook.com/v20.0/${config.whatsappCloudPhoneId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.whatsappCloudToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: String(message.to).replace(/\D/g, ''),
            type: 'text',
            text: { body: message.body },
          }),
        },
      );
      if (!res.ok) throw new Error(`WhatsApp Cloud ${res.status}`);
      return { provider: 'cloud', delivered: true };
    }
    if (provider === 'bird') {
      const res = await fetchImpl(`https://api.bird.com/workspaces/placeholder/channels/${config.birdChannelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `AccessKey ${config.birdApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ receiver: { contacts: [{ identifierValue: message.to }] }, body: { type: 'text', text: { text: message.body } } }),
      });
      if (!res.ok) throw new Error(`Bird ${res.status}`);
      return { provider: 'bird', delivered: true };
    }
  } catch (err) {
    console.error('WhatsApp provider failed', err.message);
    return { provider, delivered: false, error: err.message };
  }
  return { provider: 'mock', delivered: false };
}

export async function recordMessage(ctx, message, fetchImpl = fetch) {
  const result = await dispatch(ctx.config, message, fetchImpl);
  const id = randomId();
  run(
    ctx.db,
    `INSERT INTO notifications (
      id, entity_id, order_id, user_id, audience, channel, event, to_address, body, provider, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    message.entityId || 'food-court',
    message.orderId || null,
    message.userId || null,
    message.audience,
    message.channel,
    message.event,
    message.to || '',
    message.body,
    result.provider,
    ctx.now().toISOString(),
  );
  return { id, ...result };
}

export function listOutbox(db, entityId, { orderId, audience, userId } = {}) {
  const clauses = ['entity_id = ?'];
  const params = [entityId];
  if (orderId) {
    clauses.push('order_id = ?');
    params.push(orderId);
  }
  if (audience) {
    clauses.push('audience = ?');
    params.push(audience);
  }
  if (userId) {
    clauses.push('user_id = ?');
    params.push(userId);
  }
  return all(
    db,
    `SELECT * FROM notifications WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,
    ...params,
  );
}

export async function pushToUser(ctx, userId, title, body) {
  const now = ctx.now().toISOString();
  run(
    ctx.db,
    `INSERT INTO inapp_notifications (id, user_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)`,
    randomId(),
    userId,
    title,
    body,
    now,
  );
  const subs = all(ctx.db, 'SELECT * FROM push_subscriptions WHERE user_id = ?', userId);
  if (!subs.length) return;
  const vapid = ctx.vapid;
  if (!vapid?.publicKey || !vapid?.privateKey) return;
  webpush.setVapidDetails(ctx.config.vapidSubject, vapid.publicKey, vapid.privateKey);
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: JSON.parse(sub.keys_json) },
        JSON.stringify({ title, body }),
      );
    } catch (err) {
      console.error('Web push failed', err.message);
    }
  }
}
