import crypto from 'node:crypto';

export function randomId() {
  return crypto.randomUUID();
}

export function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

export function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32, { N: 2048, r: 8, p: 1 }).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPin(pin, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const check = crypto.scryptSync(String(pin), salt, 32, { N: 2048, r: 8, p: 1 });
  const left = Buffer.from(hash, 'hex');
  if (left.length !== check.length) return false;
  return crypto.timingSafeEqual(left, check);
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function signJwt(payload, privateKey, kid = 'eastc-1') {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = crypto.sign('sha256', Buffer.from(data), privateKey).toString('base64url');
  return `${data}.${sig}`;
}

export function verifyJwt(token, publicKey) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [h, b, s] = parts;
  let ok = false;
  try {
    ok = crypto.verify('sha256', Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s, 'base64url'));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() / 1000 >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function generateRsa() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { publicKey, privateKey };
}

export function publicJwk(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  jwk.kid = 'eastc-1';
  jwk.use = 'sig';
  jwk.alg = 'RS256';
  return jwk;
}

/** Standard Webhooks (the scheme Yoco Checkout signs with). */
export function webhookKeys(secret) {
  const raw = String(secret || '');
  const keys = [Buffer.from(raw)];
  if (raw.startsWith('whsec_')) {
    try {
      const decoded = Buffer.from(raw.slice(6), 'base64');
      if (decoded.length) keys.push(decoded);
    } catch {
      /* keep the raw key */
    }
  }
  return keys;
}

export function signStandardWebhook(rawBody, secret, { id, timestamp } = {}) {
  const webhookId = id || `evt_${randomToken(12)}`;
  const ts = String(timestamp ?? Math.floor(Date.now() / 1000));
  const content = `${webhookId}.${ts}.${rawBody}`;
  const sig = crypto.createHmac('sha256', webhookKeys(secret)[0]).update(content).digest('base64');
  return {
    rawBody,
    headers: {
      'webhook-id': webhookId,
      'webhook-timestamp': ts,
      'webhook-signature': `v1,${sig}`,
    },
  };
}

export function verifyStandardWebhook(rawBody, headers, secret, nowMs = Date.now()) {
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  const sig = headers['webhook-signature'];
  if (!id || !ts || !sig) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(nowMs / 1000 - tsNum) > 5 * 60) return false;
  const content = `${id}.${ts}.${rawBody}`;
  const presented = String(sig)
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean);
  for (const key of webhookKeys(secret)) {
    const expected = crypto.createHmac('sha256', key).update(content).digest('base64');
    for (const part of presented) {
      const [ver, value] = part.split(',');
      if (ver !== 'v1' || !value) continue;
      const a = Buffer.from(value);
      const b = Buffer.from(expected);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    }
  }
  return false;
}

export function pkceS256(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}
