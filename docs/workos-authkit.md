# WorkOS AuthKit

WorkOS AuthKit is an optional sign-in provider. Hype Comms keeps its own users, invitations,
workspace capacity, device sessions, cookies, realtime scope, and revocation rules. Magic-link
sign-in remains available when AuthKit is configured or disabled.

## Sign-in flow

1. Electron main creates and protects a desktop PKCE state and verifier.
2. The desktop asks the server to begin an AuthKit authorization. The server creates a second
   WorkOS PKCE transaction and encrypts its verifier.
3. The system browser opens the credential-free WorkOS authorization URL.
4. WorkOS returns to the fixed HTTPS server callback. The server consumes state, exchanges the
   code, and validates the access JWT against WorkOS JWKS, issuer, and client ID.
5. The verified WorkOS subject and email pass Hype Comms admission: an existing subject mapping,
   matching active member, or matching unexpired invitation is required.
6. The server redirects to the desktop callback with a five-minute Hype Comms handoff. Provider
   codes, tokens, errors, and email do not enter the desktop URL.
7. Electron checks its state and exchanges the handoff and verifier once. The server creates the
   same rotating 30-day local device session used by magic-link sign-in.

An interrupted exchange starts a new authorization. Do not retry an unknown handoff result.

![Signed-out Hype Comms desktop showing WorkOS and magic-link choices](screenshots/workos-authkit-sign-in.png)

## WorkOS configuration

Create a WorkOS Application in the same environment as its API key and configure:

- Redirect URI: `https://<public-api-host>/v1/auth/workos/callback`
- Webhook endpoint: `https://<public-api-host>/v1/auth/workos/webhook`
- Webhook event: `session.revoked`
- Application homepage and sign-out redirect: a credential-free HTTPS page

For loopback development, use
`http://127.0.0.1:3000/v1/auth/workos/callback`. It must match
`HYPE_COMMS_PUBLIC_API_URL`. WorkOS never redirects directly to a desktop scheme.

Configure the core values together:

```dotenv
WORKOS_API_KEY=sk_replace-me
WORKOS_CLIENT_ID=client_replace-me
WORKOS_REDIRECT_URI=https://chat-api.example.invalid/v1/auth/workos/callback
HYPE_COMMS_AUTH_ENCRYPTION_KEY=replace-with-43-character-unpadded-base64url
HYPE_COMMS_AUTHKIT_ADMISSION_ENABLED=false
```

Generate the encryption key without saving it to shell history:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Production enablement also requires:

```dotenv
WORKOS_WEBHOOK_SECRET=replace-me
HYPE_COMMS_TRUSTED_PROXIES=172.20.0.0/16
```

Set `WORKOS_JWT_ISSUER` when the WorkOS Application uses a custom authentication domain. It must
be a credential-free HTTPS origin. `WORKOS_API_KEY`,
`HYPE_COMMS_AUTH_ENCRYPTION_KEY`, and `WORKOS_WEBHOOK_SECRET` are server secrets. Do not put
them in desktop build settings, renderer code, logs, screenshots, or client configuration.

`HYPE_COMMS_AUTHKIT_ADMISSION_ENABLED` defaults to `false`. With provider configuration present
and the gate off, the server maintains webhook and session-reconciliation state but does not expose
the AuthKit authorization, callback, or exchange path. The gate cannot be enabled in production
without a webhook secret and trusted-proxy configuration.

## Sessions and admission

AuthKit verifies identity; it does not create public accounts. Invite an email first with the owner
UI or:

```bash
npm run invite --workspace @hype-comms/server -- --email member@example.com
```

A WorkOS subject stays bound to one local human account. A subject whose verified email no longer
matches that account is denied. The app stores the provider and subject, last verified email, and
WorkOS session ID needed for revocation. It discards WorkOS access and refresh tokens.

A signed `session.revoked` webhook revokes matching local device sessions. Startup and hourly
reconciliation also revoke local sessions absent from WorkOS's complete active-session result.
Malformed, partial, or unavailable provider responses keep existing local sessions until a later
successful check. Local logout revokes the Hype Comms device session first, then opens the provider
logout URL when available.

## Deploy

1. Back up PostgreSQL. Add the provider settings, webhook secret, and exact proxy range while
   keeping `HYPE_COMMS_AUTHKIT_ADMISSION_ENABLED=false`.
2. Deploy migration `0017_workos_authkit.sql` and the AuthKit-capable server to every serving
   instance.
3. Verify that `/v1/auth/capabilities` reports `authKit: false` and that the authorization
   routes are unavailable.
4. Verify signed `session.revoked` delivery.
5. Enable the admission gate on every serving instance and verify
   `/v1/auth/capabilities` reports `authKit: true`.
6. Release a capable desktop build. Older clients continue to use magic links.

## Roll back safely

Do not roll an AuthKit-enabled deployment straight back to a pre-AuthKit server. First disable the
admission gate everywhere and drain gate-enabled servers. Revoke provider sessions, stop the
webhook endpoint after in-flight delivery ends, then revoke and remove the local AuthKit state:

```bash
npm run authkit:revoke-all --workspace @hype-comms/server -- \
  --confirm REVOKE-AUTHKIT-SESSIONS
```

For a production Compose container:

```bash
docker compose exec server npm run authkit:revoke-all:dist -- \
  --confirm REVOKE-AUTHKIT-SESSIONS
```

The command revokes AuthKit-created local sessions and removes provider session links,
transactions, handoffs, and webhook-deduplication rows. Run it again and require zero remaining
records before deploying a pre-AuthKit server. Keep the migration and magic-link delivery in place.

## Tests

Provider tests use `@workos/emulate` with real RS256 tokens and JWKS validation. They cover the
authorization-code exchange, active-session listing, deleted-user reconciliation, unverified email,
reused codes, and PKCE mismatches. Fixture tests cover URL validation, pagination failures,
impersonation, sanitized errors, and webhook envelope validation.
