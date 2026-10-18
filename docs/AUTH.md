# EASTC sign-in

Staff, managers, and the owner sign in once. The server issues a short access token (about 15 minutes) and a rotating refresh token (30 days, or 90 days when "remember this device" is on). Cookies are `fc_access`, `fc_refresh`, and `fc_device` (HttpOnly). The apps also send the access token as a bearer header.

| Who | Endpoint |
| --- | --- |
| Student or educator login | `POST /api/auth/member/login` |
| Student signup | `POST /api/auth/student/register` |
| Educator / staff signup | `POST /api/auth/educator/register` |
| Parent | `POST /api/auth/parent/login` and `/api/auth/parent/register` |
| POS and kitchen | `POST /api/auth/staff/login` |
| Refresh | `POST /api/auth/refresh` |
| Current person | `GET /api/auth/me` (anonymous visitors get `{ "authenticated": false }`) |
| Sign out | `POST /api/auth/logout` |
| Owner switches entity | `POST /api/auth/entity` with `{ "entityId": "eastc-foundation" }` |

Roles are stored per entity. A cashier at the food court is not automatically a cashier at the varsity. The owner has the owner role on every entity and can switch without signing in again. A cashier cannot switch to Holdings.

Signup requires the POPIA checkbox. Unknown numbers and a second account for the same number are rejected.

## Passkeys

Optional WebAuthn on the same user:

- `POST /api/auth/passkey/register/options`
- `POST /api/auth/passkey/register/verify`
- `POST /api/auth/passkey/login/options`
- `POST /api/auth/passkey/login/verify`

The demo does not require a passkey.

## Plug in another EASTC site or the CRM

This server is an OIDC-style issuer for first-party EASTC apps.

Discovery: `GET /.well-known/openid-configuration`

It publishes the authorize, token, userinfo, and JWKS URLs. Codes are PKCE S256. Signing is RS256. `GET /oauth/jwks` is the public key.

Seeded client:

| Field | Value |
| --- | --- |
| `client_id` | `eastc-crm` |
| Redirects | `http://localhost:5173/oauth/callback` and `https://crm.eastc.example/auth/callback` |

Authorize URL shape:

```text
/oauth/authorize?client_id=eastc-crm&redirect_uri=https://crm.eastc.example/auth/callback&code_challenge=CODE_CHALLENGE&code_challenge_method=S256&state=STATE
```

The person must already have a session (the POS login is the demo sign-in). The redirect comes back with `code` and `state`. Exchange it:

`POST /oauth/token` with `code`, `client_id`, `redirect_uri`, and `code_verifier`.

Then `GET /oauth/userinfo` with the access token. The payload includes the person, the active entity, and the per-entity roles. Another EASTC site should trust this issuer, keep its own local profile if it needs one, and send the person back here to sign in. Set `AUTH_ISSUER` and `AUTH_COOKIE_DOMAIN` when the apps share a parent domain.

CRM roster sync is separate from login. A manager posts the roster to `POST /api/crm/sync`. The body is stored. It is forwarded only when `CRM_SYNC_URL` is a real URL rather than the placeholder.
