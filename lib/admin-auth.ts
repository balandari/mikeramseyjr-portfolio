/**
 * Administrator identity for `mikeramseyjr.com`.
 *
 * This is the gate in front of the reviewer dashboard, and it is a different
 * gate from the one reviewers use -- deliberately, completely, and at every
 * layer. It shares no secret, no cookie, no token format, no path scope and no
 * code path with reviewer access. A reviewer's access code cannot produce an
 * administrator session and an administrator session cannot open a manuscript;
 * they are two independent mechanisms that happen to live in one deployment.
 *
 * The rule, in one sentence: a successful Google sign-in is not enough. It
 * establishes *which mailbox* somebody controls; authorization is a separate,
 * later question answered only by an exact match against a configured
 * allowlist, on an address Google itself reports as verified. A stranger with a
 * perfectly good Google account gets as far as "that account is not authorised"
 * and no further.
 *
 * What this module does not do: create anything. It reads a client id, a client
 * secret and an allowlist from the environment and fails closed when any of
 * them is missing. No Google project, credential or production configuration is
 * created by this code or by the work that added it -- an unconfigured
 * deployment simply has no dashboard.
 *
 * Web Crypto throughout, matching `lib/reviewer-access.ts`, so one
 * implementation runs in every runtime.
 */

/** Cookie holding the administrator session. Namespaced, and not the reviewer's. */
export const ADMIN_COOKIE_NAME = 'mrj_admin'

/** Cookie holding the OAuth state binding, for the length of one sign-in. */
export const ADMIN_STATE_COOKIE_NAME = 'mrj_admin_state'

/** Token format version. Changing it invalidates every outstanding session. */
const TOKEN_VERSION = 'ad1'

/** State format version. */
const STATE_VERSION = 'st1'

/**
 * Domain-separation label. Distinct from the reviewer label, so even if the two
 * secrets were ever set to the same value, a reviewer token could not be
 * mistaken for -- or forged into -- an administrator one.
 */
const KEY_LABEL = 'mikeramseyjr/admin/v1'

/**
 * How long an administrator stays signed in: twelve hours.
 *
 * Short on purpose, and nothing like the reviewer's year. A reviewer's session
 * is a convenience for reading a book over months; this one holds the authority
 * to revoke access and issue codes, and it should not outlive the sitting in
 * which it was opened.
 */
export const ADMIN_SESSION_SECONDS = 12 * 60 * 60

/** An in-flight sign-in is worth five minutes and no more. */
export const ADMIN_STATE_SECONDS = 5 * 60

const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com'])

const encoder = new TextEncoder()

function trimmed(raw: string | undefined): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

/*
 * Each value is read through a literal `process.env.NAME` reference rather than
 * a computed key, for the same reason the reviewer gate does: a dynamic lookup
 * reads as absent in some runtimes, and "absent" here means the dashboard is
 * shut. Being shut by accident is still being shut, but it should not happen
 * because of how a variable was spelled.
 */
function adminSecret(): string {
  return trimmed(process.env.ADMIN_AUTH_SECRET)
}

function googleClientId(): string {
  return trimmed(process.env.GOOGLE_OAUTH_CLIENT_ID)
}

function googleClientSecret(): string {
  return trimmed(process.env.GOOGLE_OAUTH_CLIENT_SECRET)
}

/**
 * The addresses permitted to administer this site.
 *
 * Comma-separated, normalised the same way reviewer addresses are -- trimmed
 * and lower-cased, with no provider-specific folding. Matching is exact. In
 * practice this holds exactly one address, Mike's; it is a list only so that
 * changing which address that is does not require a code change.
 */
export function adminAllowlist(): string[] {
  const raw = trimmed(process.env.ADMIN_ALLOWED_EMAILS)
  if (!raw) return []
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const email = part.trim().toLowerCase()
    if (email) seen.add(email)
  }
  return Array.from(seen)
}

/**
 * True only when every input the administrator gate depends on is present.
 *
 * An allowlist of nobody counts as unconfigured: a dashboard that authorises
 * no one is not a working dashboard, and saying so plainly is better than
 * rendering a sign-in button that can only ever refuse.
 */
export function isAdminConfigured(): boolean {
  return Boolean(
    adminSecret() && googleClientId() && googleClientSecret() && adminAllowlist().length > 0,
  )
}

/**
 * Is this verified address one of the configured administrators?
 *
 * Exact, case-normalised comparison against the allowlist. This is the check
 * that stands between "Google says this person owns this mailbox" and "this
 * person may revoke a reviewer's access".
 */
export function isAllowedAdminEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase()
  if (!normalized) return false
  return adminAllowlist().includes(normalized)
}

/* -------------------------------------------------------------- primitives */

async function signingKey(): Promise<CryptoKey | null> {
  const secret = adminSecret()
  if (!secret) return null

  const root = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const derived = await crypto.subtle.sign('HMAC', root, encoder.encode(KEY_LABEL))

  return crypto.subtle.importKey(
    'raw',
    derived,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

async function mac(key: CryptoKey, message: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function encodeText(value: string): string {
  return toBase64Url(encoder.encode(value))
}

function decodeText(value: string): string | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/** Byte comparison with no early exit. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

function equalStrings(a: string, b: string): boolean {
  return equalBytes(encoder.encode(a), encoder.encode(b))
}

/* ------------------------------------------------------------- OAuth state */

export type AdminOAuthState = {
  /** Random per-attempt value, echoed through Google and matched on return. */
  nonce: string
  /** Where to land after a successful sign-in. Always an `/admin` path. */
  next: string
}

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return toBase64Url(bytes)
}

/**
 * Only ever redirect within the dashboard, and never to another origin.
 *
 * The boundary is checked precisely rather than by prefix: `/admin` itself, or
 * something that continues with `/`, `?` or `#`. A bare `startsWith('/admin')`
 * would also accept `/adminsomething`, which is a different path that merely
 * begins with the same letters.
 */
export function safeAdminPath(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '/admin'
  // A protocol-relative or absolute URL would leave the site entirely, and a
  // backslash is treated as a separator by some browsers.
  if (raw.startsWith('//') || raw.includes('\\')) return '/admin'
  if (raw === '/admin') return raw
  if (/^\/admin[/?#]/.test(raw)) return raw
  return '/admin'
}

/**
 * Mint the `state` parameter for one sign-in attempt.
 *
 * It is signed, so it cannot be forged or edited in flight, and time-limited,
 * so a stale authorization URL cannot be replayed later. The same nonce is also
 * written to a short-lived cookie; the callback requires both to agree, which
 * is what stops somebody handing Mike a link that signs him into *their*
 * session.
 */
export async function mintAdminState(
  next: string,
  nowMs: number = Date.now(),
): Promise<{ state: string; nonce: string } | null> {
  const key = await signingKey()
  if (!key) return null

  const nonce = randomNonce()
  const expiresAt = Math.floor(nowMs / 1000) + ADMIN_STATE_SECONDS
  const claims = `${STATE_VERSION}.${nonce}.${expiresAt}.${encodeText(safeAdminPath(next))}`
  const signature = toBase64Url(await mac(key, claims))

  return { state: `${claims}.${signature}`, nonce }
}

export async function verifyAdminState(
  state: string | null | undefined,
  nowMs: number = Date.now(),
): Promise<AdminOAuthState | null> {
  if (!state || typeof state !== 'string') return null

  const parts = state.split('.')
  if (parts.length !== 5) return null

  const [version, nonce, expiresRaw, nextRaw, signature] = parts
  if (version !== STATE_VERSION) return null

  const expiresAt = Number(expiresRaw)
  if (!Number.isInteger(expiresAt) || expiresAt <= 0) return null
  if (Math.floor(nowMs / 1000) >= expiresAt) return null

  const key = await signingKey()
  if (!key) return null

  const expected = toBase64Url(await mac(key, `${version}.${nonce}.${expiresRaw}.${nextRaw}`))
  if (!equalStrings(signature, expected)) return null

  const next = decodeText(nextRaw)
  if (next === null) return null

  return { nonce, next: safeAdminPath(next) }
}

/* ------------------------------------------------------- the Google handoff */

/**
 * Where to send somebody to sign in.
 *
 * `openid email` and nothing more: this needs to know one fact about the
 * visitor -- which verified address they control -- and asking for a name, a
 * picture or a profile would be collecting what it has no use for.
 * `prompt=select_account` so signing out and back in as a different account
 * actually offers the choice.
 */
export function googleAuthorizationUrl(redirectUri: string, state: string): string {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT)
  url.searchParams.set('client_id', googleClientId())
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email')
  url.searchParams.set('state', state)
  url.searchParams.set('prompt', 'select_account')
  url.searchParams.set('access_type', 'online')
  // An id token is the whole point; ask Google not to hand back a cached one
  // from an older grant.
  url.searchParams.set('include_granted_scopes', 'false')
  return url.toString()
}

export type GoogleIdentity = {
  /** Normalised, and confirmed by Google to be verified. */
  email: string
}

/**
 * The claims this code is willing to read out of an id token.
 *
 * Nothing else in the token is looked at, and none of it is stored.
 */
type IdTokenClaims = {
  iss?: unknown
  aud?: unknown
  exp?: unknown
  email?: unknown
  email_verified?: unknown
}

/**
 * Decode an id token's payload.
 *
 * The signature is deliberately not checked here, and that is safe for exactly
 * one reason: this token was not handed to us by the browser. It was fetched by
 * the server, over TLS, directly from Google's token endpoint, authenticated
 * with the client secret. OpenID Connect Core says in as many words that a
 * client doing the authorization-code flow may skip id-token signature
 * validation when the token arrives that way, because the TLS channel to the
 * issuer already provides the guarantee a signature would.
 *
 * Everything that does not follow from the channel is still checked below:
 * audience, issuer, expiry, and that Google says the address is verified.
 */
function decodeIdToken(idToken: string): IdTokenClaims | null {
  const parts = idToken.split('.')
  if (parts.length !== 3) return null
  const payload = decodeText(parts[1])
  if (payload === null) return null
  try {
    const parsed = JSON.parse(payload) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as IdTokenClaims
  } catch {
    return null
  }
}

/**
 * Turn an id token into the one fact this system wants, or null.
 *
 * Every branch is a refusal:
 *
 *   wrong issuer          somebody else's token
 *   wrong audience        our client id is not who it was minted for
 *   expired               a replayed token
 *   no email              nothing to match against the allowlist
 *   email_verified false  Google has NOT confirmed this person owns this
 *                         address, and an unverified address is trivially
 *                         claimable -- this is the check that would otherwise
 *                         let anyone assert they are Mike
 */
export function identityFromIdToken(
  idToken: string,
  nowMs: number = Date.now(),
): GoogleIdentity | null {
  const claims = decodeIdToken(idToken)
  if (!claims) return null

  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.has(claims.iss)) return null

  const clientId = googleClientId()
  if (!clientId) return null
  if (typeof claims.aud !== 'string' || !equalStrings(claims.aud, clientId)) return null

  const exp = typeof claims.exp === 'number' ? claims.exp : Number(claims.exp)
  if (!Number.isFinite(exp) || Math.floor(nowMs / 1000) >= exp) return null

  // Google sends this as a boolean, but has historically sent the string
  // "true" as well. Anything that is not unambiguously true is treated as
  // unverified.
  const verified = claims.email_verified === true || claims.email_verified === 'true'
  if (!verified) return null

  if (typeof claims.email !== 'string') return null
  const email = claims.email.trim().toLowerCase()
  if (!email) return null

  return { email }
}

/**
 * Exchange an authorization code for an id token, and read the identity out.
 *
 * The client secret is sent to Google and to nobody else; it is never logged,
 * never returned, and never placed in a redirect. The failure mode is a plain
 * null -- the caller turns that into one generic message, because telling an
 * unauthenticated visitor which step failed maps out the gate for them.
 */
export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
  nowMs: number = Date.now(),
): Promise<GoogleIdentity | null> {
  const clientId = googleClientId()
  const clientSecret = googleClientSecret()
  if (!clientId || !clientSecret || !code) return null

  let response: Response
  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })
  } catch {
    return null
  }

  if (!response.ok) return null

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return null
  }

  if (typeof body !== 'object' || body === null) return null
  const idToken = (body as Record<string, unknown>).id_token
  if (typeof idToken !== 'string') return null

  return identityFromIdToken(idToken, nowMs)
}

/* ------------------------------------------------------ the admin session */

export type AdminSession = {
  email: string
}

/**
 * Mint an administrator session for an address that has already been verified
 * by Google *and* matched against the allowlist.
 *
 * The allowlist is re-checked here rather than assumed, because this is the
 * function that grants authority and it should not be possible to grant it by
 * calling this from somewhere that forgot.
 */
export async function mintAdminToken(
  email: string,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const key = await signingKey()
  if (!key) return null

  const normalized = email.trim().toLowerCase()
  if (!isAllowedAdminEmail(normalized)) return null

  const expiresAt = Math.floor(nowMs / 1000) + ADMIN_SESSION_SECONDS
  const claims = `${TOKEN_VERSION}.${encodeText(normalized)}.${expiresAt}`
  const signature = toBase64Url(await mac(key, claims))

  return `${claims}.${signature}`
}

/**
 * Resolve a cookie value to the administrator it names, or null.
 *
 * The allowlist is consulted again on every request, not just at sign-in. That
 * is what makes removing an address from `ADMIN_ALLOWED_EMAILS` take effect
 * immediately instead of whenever the session happened to expire.
 */
export async function verifyAdminToken(
  token: string | null | undefined,
  nowMs: number = Date.now(),
): Promise<AdminSession | null> {
  if (!token || typeof token !== 'string') return null

  const parts = token.split('.')
  if (parts.length !== 4) return null

  const [version, emailRaw, expiresRaw, signature] = parts
  if (version !== TOKEN_VERSION) return null

  const expiresAt = Number(expiresRaw)
  if (!Number.isInteger(expiresAt) || expiresAt <= 0) return null
  if (Math.floor(nowMs / 1000) >= expiresAt) return null

  const key = await signingKey()
  if (!key) return null

  const expected = toBase64Url(await mac(key, `${version}.${emailRaw}.${expiresRaw}`))
  if (!equalStrings(signature, expected)) return null

  const email = decodeText(emailRaw)
  if (email === null) return null

  // Authority is not carried by the cookie; it is re-derived from configuration
  // on every request.
  if (!isAllowedAdminEmail(email)) return null

  return { email }
}

/* ------------------------------------------------------------------ CSRF */

/**
 * A token bound to one administrator session, required on every mutation.
 *
 * The session cookie is `SameSite=Lax`, which already stops a cross-site form
 * POST from carrying it. This is the second, independent layer: it is derived
 * from the session token under this module's key, so a page that cannot read
 * the session cannot produce it, and it is compared without early exit.
 */
export async function adminCsrfToken(sessionToken: string): Promise<string | null> {
  const key = await signingKey()
  if (!key) return null
  return toBase64Url(await mac(key, `csrf|${sessionToken}`)).slice(0, 32)
}

export async function adminCsrfTokenMatches(
  sessionToken: string,
  submitted: string | null | undefined,
): Promise<boolean> {
  if (typeof submitted !== 'string' || submitted === '') return false
  const expected = await adminCsrfToken(sessionToken)
  if (!expected) return false
  return equalStrings(submitted, expected)
}

/* --------------------------------------------------------------- cookies */

type CookieAttributes = {
  name: string
  value: string
  httpOnly: true
  secure: boolean
  sameSite: 'lax'
  path: string
  maxAge: number
}

/**
 * Attributes for the administrator cookie.
 *
 * HttpOnly so no script can read it, scoped to `/admin` so it is never
 * presented to the public site or to `/review`, and Secure outside development.
 */
export function adminCookie(
  value: string,
  maxAge: number = ADMIN_SESSION_SECONDS,
): CookieAttributes {
  return {
    name: ADMIN_COOKIE_NAME,
    value,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/admin',
    maxAge,
  }
}

export function clearedAdminCookie(): CookieAttributes {
  return adminCookie('', 0)
}

/**
 * The state cookie. Scoped to the callback's own path and thrown away the
 * moment it has been used.
 */
export function adminStateCookie(
  value: string,
  maxAge: number = ADMIN_STATE_SECONDS,
): CookieAttributes {
  return {
    name: ADMIN_STATE_COOKIE_NAME,
    value,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/admin',
    maxAge,
  }
}

export function clearedAdminStateCookie(): CookieAttributes {
  return adminStateCookie('', 0)
}

/**
 * Where Google sends the visitor back to.
 *
 * Taken from configuration when set -- a deployment behind a proxy cannot
 * always infer its own public origin -- and otherwise from the request, so
 * local development needs no configuration at all. It must match a redirect URI
 * registered on the Google client exactly; that registration is Mike's to make,
 * and this code creates nothing.
 */
export function adminRedirectUri(requestUrl: string): string {
  const configured = trimmed(process.env.ADMIN_OAUTH_REDIRECT_URI)
  if (configured) return configured
  return new URL('/admin/api/auth/callback', requestUrl).toString()
}
