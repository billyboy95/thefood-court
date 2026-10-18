import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { pkceS256, randomId, randomToken, sha256, signJwt, verifyJwt, verifyPin, hashPin } from './crypto.js';
import { all, one, run } from './db.js';
import { HttpError } from './errors.js';

const CONSENT = 'I consent to EASTC keeping my name, number and food-court orders so the kitchen can prepare and hand over my food. I understand this is required by POPIA and I can ask the campus office about my data.';

export function normalizeNumber(value) {
  return String(value || '').trim().toUpperCase();
}

function decorate(db, user, activeEntity) {
  if (!user) return null;
  const roles = all(
    db,
    'SELECT entity_id, role, till_id FROM user_roles WHERE user_id = ? ORDER BY entity_id',
    user.id,
  );
  const entity = activeEntity || roles.find((role) => role.entity_id === 'food-court')?.entity_id || roles[0]?.entity_id;
  const active = roles.find((role) => role.entity_id === entity) || null;
  return {
    id: user.id,
    kind: user.kind,
    username: user.username,
    name: user.name,
    phone: user.phone,
    studentNumber: user.student_number,
    staffNumber: user.staff_number,
    linkedStudentNumber: user.linked_student_number,
    memberNumber: user.student_number || user.staff_number || null,
    popiaAcceptedAt: user.popia_accepted_at,
    entity,
    role: active?.role || null,
    tillId: active?.till_id || null,
    roles: roles.map((role) => ({ entityId: role.entity_id, role: role.role, tillId: role.till_id })),
  };
}

export function memberCanOrder(actor) {
  return actor?.kind === 'student' || actor?.kind === 'educator';
}

export function loadActor(ctx, userId, entity) {
  const user = one(ctx.db, 'SELECT * FROM users WHERE id = ?', userId);
  return decorate(ctx.db, user, entity);
}

function signAccess(ctx, actor) {
  const now = Math.floor(ctx.now().getTime() / 1000);
  return signJwt(
    {
      iss: ctx.issuer,
      sub: actor.id,
      name: actor.name,
      kind: actor.kind,
      role: actor.role,
      entity: actor.entity,
      till: actor.tillId,
      member: actor.memberNumber,
      roles: actor.roles,
      iat: now,
      exp: now + ctx.config.accessTtlSec,
    },
    ctx.keys.privateKey,
  );
}

export function openSession(ctx, userId, { remember = false, deviceId = null, userAgent = '', entity } = {}) {
  const actor = loadActor(ctx, userId, entity);
  if (!actor?.role) throw new HttpError(403, 'This account has no EASTC role.');
  const refresh = randomToken();
  const ttl = remember ? ctx.config.rememberTtlSec : ctx.config.refreshTtlSec;
  const expires = new Date(ctx.now().getTime() + ttl * 1000).toISOString();
  const sessionId = randomId();
  let device = deviceId;
  if (remember) {
    device = device || randomId();
    const existing = one(ctx.db, 'SELECT id FROM devices WHERE id = ?', device);
    if (!existing) {
      run(
        ctx.db,
        'INSERT INTO devices (id, user_id, label, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
        device,
        actor.id,
        String(userAgent).slice(0, 160),
        ctx.now().toISOString(),
        ctx.now().toISOString(),
      );
    } else {
      run(ctx.db, 'UPDATE devices SET last_seen_at = ? WHERE id = ?', ctx.now().toISOString(), device);
    }
  }
  run(
    ctx.db,
    `INSERT INTO sessions (id, user_id, refresh_hash, device_id, remember, active_entity, user_agent, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sessionId,
    actor.id,
    sha256(refresh),
    device,
    remember ? 1 : 0,
    actor.entity,
    String(userAgent).slice(0, 160),
    expires,
    ctx.now().toISOString(),
  );
  return {
    tokenType: 'Bearer',
    accessToken: signAccess(ctx, actor),
    refreshToken: refresh,
    refreshExpiresAt: expires,
    remember: Boolean(remember),
    deviceId: device,
    user: publicUser(actor),
  };
}

export function publicUser(actor) {
  return {
    id: actor.id,
    kind: actor.kind,
    username: actor.username,
    name: actor.name,
    phone: actor.phone,
    studentNumber: actor.studentNumber,
    staffNumber: actor.staffNumber,
    linkedStudentNumber: actor.linkedStudentNumber,
    memberNumber: actor.memberNumber,
    entity: actor.entity,
    role: actor.role,
    tillId: actor.tillId,
    roles: actor.roles,
    popiaAcceptedAt: actor.popiaAcceptedAt,
  };
}

export function actorFromAccess(ctx, token) {
  const payload = verifyJwt(token, ctx.keys.publicKey);
  if (!payload?.sub) return null;
  return loadActor(ctx, payload.sub, payload.entity);
}

export function rotateRefresh(ctx, refreshToken) {
  const row = one(ctx.db, 'SELECT * FROM sessions WHERE refresh_hash = ?', sha256(refreshToken || ''));
  if (!row) throw new HttpError(401, 'Sign in again.');
  if (row.expires_at <= ctx.now().toISOString()) {
    run(ctx.db, 'DELETE FROM sessions WHERE id = ?', row.id);
    throw new HttpError(401, 'Session expired. Sign in again.');
  }
  run(ctx.db, 'DELETE FROM sessions WHERE id = ?', row.id);
  return openSession(ctx, row.user_id, {
    remember: Boolean(row.remember),
    deviceId: row.device_id,
    userAgent: row.user_agent,
    entity: row.active_entity,
  });
}

export function revokeRefresh(ctx, refreshToken) {
  if (!refreshToken) return;
  run(ctx.db, 'DELETE FROM sessions WHERE refresh_hash = ?', sha256(refreshToken));
}

export function switchEntity(ctx, actor, entityId) {
  const allowed = actor.roles.some((role) => role.entityId === entityId);
  if (!allowed) throw new HttpError(403, 'Your account cannot open that EASTC entity.');
  return loadActor(ctx, actor.id, entityId);
}

function assertPopia(accepted) {
  if (!accepted) throw new HttpError(400, 'Accept the POPIA notice to create an account.');
}

export function registerStudent(ctx, input) {
  assertPopia(input?.popiaAccepted);
  const number = normalizeNumber(input?.studentNumber);
  const reg = one(ctx.db, 'SELECT * FROM student_registry WHERE student_number = ? AND active = 1', number);
  if (!reg) throw new HttpError(403, 'That student number is not on the EASTC registry.');
  if (one(ctx.db, 'SELECT id FROM users WHERE student_number = ?', number)) {
    throw new HttpError(409, 'An account already exists for this student number.');
  }
  const pin = String(input?.pin || '');
  if (!/^\d{4,6}$/.test(pin)) throw new HttpError(400, 'Choose a 4 to 6 digit PIN.');
  const id = randomId();
  const now = ctx.now().toISOString();
  run(
    ctx.db,
    `INSERT INTO users (id, kind, username, student_number, name, phone, pin_hash, popia_accepted_at, created_at)
     VALUES (?, 'student', ?, ?, ?, ?, ?, ?, ?)`,
    id,
    number.toLowerCase(),
    number,
    reg.full_name,
    reg.phone,
    hashPin(pin),
    now,
    now,
  );
  run(ctx.db, `INSERT INTO user_roles (user_id, entity_id, role) VALUES (?, 'food-court', 'student')`, id);
  const wallet = one(
    ctx.db,
    `SELECT id FROM wallet_accounts WHERE entity_id = 'food-court' AND member_number = ?`,
    number,
  );
  if (wallet) run(ctx.db, 'UPDATE wallet_accounts SET user_id = ? WHERE id = ?', id, wallet.id);
  else {
    run(
      ctx.db,
      `INSERT INTO wallet_accounts (
        id, entity_id, member_number, member_kind, user_id, daily_limit_cents, monthly_limit_cents, low_balance_cents, daily_allowance_enabled
      ) VALUES (?, 'food-court', ?, 'student', ?, 30000, 200000, 5000, 0)`,
      randomId(),
      number,
      id,
    );
  }
  return openSession(ctx, id, { remember: Boolean(input.remember), userAgent: input.userAgent });
}

export function registerEducator(ctx, input) {
  assertPopia(input?.popiaAccepted);
  const number = normalizeNumber(input?.staffNumber);
  const reg = one(ctx.db, 'SELECT * FROM staff_registry WHERE staff_number = ? AND active = 1', number);
  if (!reg) throw new HttpError(403, 'That staff number is not on the EASTC registry.');
  if (one(ctx.db, 'SELECT id FROM users WHERE staff_number = ?', number)) {
    throw new HttpError(409, 'An account already exists for this staff number.');
  }
  const pin = String(input?.pin || '');
  if (!/^\d{4,6}$/.test(pin)) throw new HttpError(400, 'Choose a 4 to 6 digit PIN.');
  const id = randomId();
  const now = ctx.now().toISOString();
  run(
    ctx.db,
    `INSERT INTO users (id, kind, username, staff_number, name, phone, pin_hash, popia_accepted_at, created_at)
     VALUES (?, 'educator', ?, ?, ?, ?, ?, ?, ?)`,
    id,
    number.toLowerCase(),
    number,
    reg.full_name,
    reg.phone,
    hashPin(pin),
    now,
    now,
  );
  run(ctx.db, `INSERT INTO user_roles (user_id, entity_id, role) VALUES (?, 'food-court', 'educator')`, id);
  const wallet = one(
    ctx.db,
    `SELECT id FROM wallet_accounts WHERE entity_id = 'food-court' AND member_number = ?`,
    number,
  );
  if (wallet) run(ctx.db, 'UPDATE wallet_accounts SET user_id = ? WHERE id = ?', id, wallet.id);
  else {
    run(
      ctx.db,
        `INSERT INTO wallet_accounts (
          id, entity_id, member_number, member_kind, user_id, daily_limit_cents, monthly_limit_cents, low_balance_cents, daily_allowance_enabled
        ) VALUES (?, 'food-court', ?, 'staff', ?, 50000, 250000, 5000, 0)`,
      randomId(),
      number,
      id,
    );
  }
  return openSession(ctx, id, { remember: Boolean(input.remember), userAgent: input.userAgent });
}

export function loginMember(ctx, input) {
  const number = normalizeNumber(input?.number || input?.studentNumber || input?.staffNumber);
  const user = one(
    ctx.db,
    'SELECT * FROM users WHERE student_number = ? OR staff_number = ?',
    number,
    number,
  );
  if (!user || !verifyPin(input?.pin, user.pin_hash)) {
    throw new HttpError(401, 'Number or PIN is not valid.');
  }
  if (user.kind !== 'student' && user.kind !== 'educator') {
    throw new HttpError(403, 'Use the staff POS login for till accounts.');
  }
  return openSession(ctx, user.id, { remember: Boolean(input.remember), userAgent: input.userAgent });
}

export function registerParent(ctx, input) {
  assertPopia(input?.popiaAccepted);
  const number = normalizeNumber(input?.studentNumber);
  const reg = one(ctx.db, 'SELECT * FROM student_registry WHERE student_number = ? AND active = 1', number);
  if (!reg) throw new HttpError(403, 'That student number is not on the EASTC registry.');
  if (one(ctx.db, 'SELECT id FROM users WHERE linked_student_number = ? AND kind = ?', number, 'parent')) {
    throw new HttpError(409, 'A parent account is already linked to this student.');
  }
  const pin = String(input?.pin || '');
  if (!/^\d{4,6}$/.test(pin)) throw new HttpError(400, 'Choose a 4 to 6 digit PIN.');
  const name = String(input?.name || '').trim();
  if (name.length < 2) throw new HttpError(400, 'Enter your name.');
  const id = randomId();
  const username = `parent.${number.toLowerCase()}.${id.slice(0, 4)}`;
  const now = ctx.now().toISOString();
  run(
    ctx.db,
    `INSERT INTO users (id, kind, username, linked_student_number, name, phone, pin_hash, popia_accepted_at, created_at)
     VALUES (?, 'parent', ?, ?, ?, ?, ?, ?, ?)`,
    id,
    username,
    number,
    name,
    reg.phone,
    hashPin(pin),
    now,
    now,
  );
  run(ctx.db, `INSERT INTO user_roles (user_id, entity_id, role) VALUES (?, 'food-court', 'parent')`, id);
  return openSession(ctx, id, { remember: Boolean(input.remember), userAgent: input.userAgent });
}

export function loginParent(ctx, input) {
  const username = String(input?.username || '').trim().toLowerCase();
  const user = one(ctx.db, `SELECT * FROM users WHERE kind = 'parent' AND lower(username) = ?`, username);
  if (!user || !verifyPin(input?.pin, user.pin_hash)) throw new HttpError(401, 'Username or PIN is not valid.');
  return openSession(ctx, user.id, { remember: Boolean(input.remember), userAgent: input.userAgent });
}

export function loginOperator(ctx, input) {
  const username = String(input?.username || '').trim().toLowerCase();
  const user = one(ctx.db, `SELECT * FROM users WHERE kind = 'staff' AND lower(username) = ?`, username);
  if (!user || !verifyPin(input?.pin, user.pin_hash)) throw new HttpError(401, 'Username or PIN is not valid.');
  return openSession(ctx, user.id, {
    remember: Boolean(input.remember),
    userAgent: input.userAgent,
    entity: input.entity,
  });
}

export function popiaText() {
  return CONSENT;
}

export async function passkeyRegisterOptions(ctx, actor, rpID) {
  const options = await generateRegistrationOptions({
    rpName: 'EASTC Food Court',
    rpID,
    userID: new TextEncoder().encode(actor.id),
    userName: actor.username || actor.memberNumber || actor.id,
    userDisplayName: actor.name,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  run(
    ctx.db,
    `INSERT INTO webauthn_challenges (id, user_id, kind, challenge, expires_at) VALUES (?, ?, 'register', ?, ?)`,
    randomId(),
    actor.id,
    options.challenge,
    new Date(ctx.now().getTime() + 5 * 60 * 1000).toISOString(),
  );
  return options;
}

export async function passkeyRegisterVerify(ctx, actor, response, rpID, origin) {
  const row = one(
    ctx.db,
    `SELECT * FROM webauthn_challenges WHERE user_id = ? AND kind = 'register' AND expires_at > ? ORDER BY expires_at DESC LIMIT 1`,
    actor.id,
    ctx.now().toISOString(),
  );
  if (!row) throw new HttpError(400, 'Passkey registration expired. Try again.');
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
  } catch (err) {
    throw new HttpError(400, err.message || 'Passkey was not accepted.');
  }
  if (!verification.verified) throw new HttpError(400, 'Passkey was not accepted.');
  const cred = verification.registrationInfo.credential;
  run(
    ctx.db,
    `INSERT INTO passkeys (credential_id, user_id, public_key, counter, transports, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    cred.id,
    actor.id,
    Buffer.from(cred.publicKey).toString('base64url'),
    cred.counter || 0,
    JSON.stringify(cred.transports || []),
    ctx.now().toISOString(),
  );
  run(ctx.db, 'DELETE FROM webauthn_challenges WHERE id = ?', row.id);
  return { ok: true };
}

export async function passkeyLoginOptions(ctx, rpID) {
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
  run(
    ctx.db,
    `INSERT INTO webauthn_challenges (id, user_id, kind, challenge, expires_at) VALUES (?, NULL, 'login', ?, ?)`,
    randomId(),
    options.challenge,
    new Date(ctx.now().getTime() + 5 * 60 * 1000).toISOString(),
  );
  return options;
}

export async function passkeyLoginVerify(ctx, response, rpID, origin, userAgent) {
  const row = one(
    ctx.db,
    `SELECT * FROM webauthn_challenges WHERE kind = 'login' AND challenge = ? AND expires_at > ?`,
    response?.response ? null : null,
    ctx.now().toISOString(),
  );
  const challenge = one(
    ctx.db,
    `SELECT * FROM webauthn_challenges WHERE kind = 'login' AND expires_at > ? ORDER BY expires_at DESC LIMIT 1`,
    ctx.now().toISOString(),
  );
  if (!challenge) throw new HttpError(400, 'Passkey sign-in expired. Try again.');
  const cred = one(ctx.db, 'SELECT * FROM passkeys WHERE credential_id = ?', response?.id);
  if (!cred) throw new HttpError(401, 'This passkey is not registered.');
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: cred.credential_id,
        publicKey: Buffer.from(cred.public_key, 'base64url'),
        counter: cred.counter,
      },
    });
  } catch (err) {
    throw new HttpError(401, err.message || 'Passkey sign-in failed.');
  }
  if (!verification.verified) throw new HttpError(401, 'Passkey sign-in failed.');
  run(ctx.db, 'UPDATE passkeys SET counter = ? WHERE credential_id = ?', verification.authenticationInfo.newCounter, cred.credential_id);
  run(ctx.db, 'DELETE FROM webauthn_challenges WHERE id = ?', challenge.id);
  return openSession(ctx, cred.user_id, { remember: true, userAgent });
}

export function createAuthCode(ctx, { clientId, redirectUri, userId, codeChallenge, entity }) {
  const client = one(ctx.db, 'SELECT * FROM oauth_clients WHERE client_id = ?', clientId);
  if (!client) throw new HttpError(400, 'Unknown OAuth client.');
  const uris = JSON.parse(client.redirect_uris);
  if (!uris.includes(redirectUri)) throw new HttpError(400, 'Redirect URI is not registered.');
  if (!codeChallenge) throw new HttpError(400, 'PKCE code_challenge is required.');
  const code = randomToken(24);
  run(
    ctx.db,
    `INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, code_challenge, entity_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    code,
    clientId,
    userId,
    redirectUri,
    codeChallenge,
    entity || 'food-court',
    new Date(ctx.now().getTime() + 5 * 60 * 1000).toISOString(),
  );
  return code;
}

export function exchangeAuthCode(ctx, { code, clientId, redirectUri, codeVerifier }) {
  const row = one(ctx.db, 'SELECT * FROM oauth_codes WHERE code = ?', code || '');
  if (!row || row.expires_at <= ctx.now().toISOString()) throw new HttpError(400, 'Authorisation code is not valid.');
  if (row.client_id !== clientId || row.redirect_uri !== redirectUri) throw new HttpError(400, 'OAuth client mismatch.');
  if (pkceS256(codeVerifier || '') !== row.code_challenge) throw new HttpError(400, 'PKCE verifier does not match.');
  run(ctx.db, 'DELETE FROM oauth_codes WHERE code = ?', row.code);
  const actor = loadActor(ctx, row.user_id, row.entity_id);
  const now = Math.floor(ctx.now().getTime() / 1000);
  const accessToken = signJwt(
    {
      iss: ctx.issuer,
      sub: actor.id,
      name: actor.name,
      kind: actor.kind,
      role: actor.role,
      entity: actor.entity,
      roles: actor.roles,
      iat: now,
      exp: now + ctx.config.accessTtlSec,
    },
    ctx.keys.privateKey,
  );
  return { access_token: accessToken, token_type: 'Bearer', expires_in: ctx.config.accessTtlSec, user: publicUser(actor) };
}

export { CONSENT };
