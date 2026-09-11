/**
 * Private author-review access control for `mikeramseyjr.com`.
 *
 * This is the only place reviewer identity is decided. It is deliberately
 * self-contained -- it imports nothing from this repository -- so that the same
 * implementation runs unchanged in the Edge request boundary, in server
 * components, in route handlers, and under `node --test`. There is one check,
 * so the boundary and the pages cannot drift apart.
 *
 * The model, in one paragraph: every reviewer has their own high-entropy access
 * code. The code itself is never stored anywhere -- not in this repository, not
 * in the roster, not in a log, not in the browser. What is stored is a keyed
 * fingerprint of it (`codeHash`), an HMAC under a key derived from
 * `REVIEWER_AUTH_SECRET`. A submitted code is fingerprinted the same way and
 * compared against the roster; a match identifies exactly one reviewer, who is
 * then issued a signed, HttpOnly cookie that names them. Because the
 * fingerprint is keyed rather than a bare hash, possession of the roster alone
 * reveals nothing that could be turned back into a code.
 *
 * Everything is built on Web Crypto rather than `node:crypto` so the Edge
 * runtime and the Node runtime share one implementation.
 *
 * Fail-closed is the rule at every branch. A missing secret, an unparseable
 * roster, a malformed token, an expired token, an unknown reviewer, a token
 * minted against a since-rotated code, and an ambiguous roster all resolve to
 * "not authorized" rather than to an error a caller might ignore.
 */

/** Cookie name. Namespaced so it can never collide with anything else on the domain. */
export const REVIEWER_COOKIE_NAME = 'mrj_reviewer'

/**
 * Token format version. Changing it invalidates every outstanding cookie at
 * once. It must never contain a `.`: token fields are dot-separated.
 */
const TOKEN_VERSION = 'rv1'

/**
 * Domain-separation label. The signing key is derived from the environment
 * secret through this label, so a reviewer token can never be produced by, or
 * mistaken for, any other token signed with the same secret.
 */
const KEY_LABEL = 'mikeramseyjr/author-reader/v1'

/**
 * How long a reviewer stays signed in on one device: one year.
 *
 * A reviewer opens and re-opens a manuscript over months, so the cookie is
 * deliberately long-lived rather than session-length. Nothing here binds a
 * reviewer to a device: clearing cookies, private browsing, a different browser
 * or profile, or signing out all end it early. Rotating that reviewer's entry
 * in the roster revokes their cookie immediately and affects no one else.
 */
export const REVIEWER_SESSION_SECONDS = 365 * 24 * 60 * 60

/** Reviewer ids are used inside a dot-separated token, so their shape is constrained. */
const REVIEWER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Book slugs appear in URLs and on disk, so their shape is constrained too. */
const BOOK_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

const encoder = new TextEncoder()

export type Reviewer = {
  /** Stable, non-secret identifier. Appears in the cookie and on feedback rows. */
  id: string
  /** Display name shown to that reviewer only. */
  name: string
  /** Book slugs this reviewer may open. Absent slugs are simply not visible. */
  books: string[]
  /** Keyed fingerprint of this reviewer's access code. Never the code itself. */
  codeHash: string
}

function trimmed(raw: string | undefined): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

/*
 * Both values are read through a literal `process.env.NAME` reference rather
 * than a computed key. The Edge runtime only carries variables a build can see
 * statically; a dynamic lookup would read as absent there and shut the reader
 * to everyone.
 */
function authSecret(): string {
  return trimmed(process.env.REVIEWER_AUTH_SECRET)
}

function rosterSource(): string {
  return trimmed(process.env.REVIEWER_ROSTER)
}

/**
 * Normalize a typed access code.
 *
 * Reviewers receive their code out of band and type it on a phone, so case,
 * spaces and the dashes used to group it are all discarded before comparison.
 * The generator applies exactly this function before fingerprinting, so a code
 * typed with its grouping dashes verifies identically to the same code typed
 * as one unbroken run of characters.
 */
export function normalizeAccessCode(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return ''
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

async function signingKey(): Promise<CryptoKey | null> {
  const secret = authSecret()
  if (!secret) return null

  // Derive a reader-specific key from the environment secret. The derivation is
  // what separates this domain from every other use of that secret; the raw
  // secret never signs a reviewer token directly.
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
  // Indexed rather than iterated: this project's `tsconfig` sets no `target`,
  // so iterating a typed array would not compile.
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Byte comparison with no early exit, over two digests of known length. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  }
  return diff === 0
}

/**
 * The keyed fingerprint stored in the roster for one access code.
 *
 * Exported because the code generator has to produce exactly this value, and
 * because the tests verify that the generator and the gate agree. It returns
 * null when no signing secret is configured, so a caller can never mint an
 * unbound fingerprint.
 */
export async function fingerprintAccessCode(rawCode: string): Promise<string | null> {
  const key = await signingKey()
  if (!key) return null

  const normalized = normalizeAccessCode(rawCode)
  if (!normalized) return null

  return toBase64Url(await mac(key, `code|${normalized}`))
}

/**
 * Parse `REVIEWER_ROSTER` into reviewers.
 *
 * The roster is JSON in an environment variable rather than a file, so that no
 * fingerprint and no reviewer name is ever committed to source control. Any
 * malformed entry disqualifies the whole roster rather than being skipped: a
 * roster that does not parse exactly as written is a configuration error, and
 * silently serving a partial roster could hand a reviewer the wrong
 * entitlements. Duplicate ids and duplicate fingerprints are rejected for the
 * same reason.
 */
export function loadRoster(): Reviewer[] {
  const source = rosterSource()
  if (!source) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return []
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return []

  const reviewers: Reviewer[] = []
  const seenIds = new Set<string>()
  const seenHashes = new Set<string>()

  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) return []
    const entry = raw as Record<string, unknown>

    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    const codeHash = typeof entry.codeHash === 'string' ? entry.codeHash.trim() : ''
    const books = entry.books

    if (!REVIEWER_ID_PATTERN.test(id)) return []
    if (!name) return []
    if (!codeHash) return []
    if (!Array.isArray(books)) return []

    const bookSlugs: string[] = []
    for (const slug of books) {
      if (typeof slug !== 'string' || !BOOK_SLUG_PATTERN.test(slug.trim())) return []
      bookSlugs.push(slug.trim())
    }

    if (seenIds.has(id)) return []
    if (seenHashes.has(codeHash)) return []
    seenIds.add(id)
    seenHashes.add(codeHash)

    reviewers.push({ id, name, books: bookSlugs, codeHash })
  }

  return reviewers
}

/** True only when every input the gate depends on is present and well-formed. */
export function isReviewerAccessConfigured(): boolean {
  return Boolean(authSecret()) && loadRoster().length > 0
}

/**
 * Identify the one reviewer whose access code was submitted, or null.
 *
 * Every roster entry is compared, with no early exit, so how long this takes
 * does not reveal which reviewer matched or whether an early entry matched.
 * Two matches mean the roster is ambiguous, which is a configuration error and
 * is refused rather than resolved: no reviewer may ever be handed another
 * reviewer's identity because of it.
 */
export async function identifyReviewer(submittedCode: string): Promise<Reviewer | null> {
  return identifyReviewerIn(loadRoster(), submittedCode)
}

/**
 * The same identification, against a roster supplied by the caller.
 *
 * Separated so the runtime roster store can pass its own active entries without
 * this module having to know that storage drivers exist. The comparison rules
 * below are the whole point and are shared by both entry points: no early exit,
 * and an ambiguous roster is refused rather than resolved.
 */
export async function identifyReviewerIn(
  roster: Reviewer[],
  submittedCode: string,
): Promise<Reviewer | null> {
  const key = await signingKey()
  if (!key) return null

  if (roster.length === 0) return null

  const normalized = normalizeAccessCode(submittedCode)
  if (!normalized) return null

  const candidate = toBase64Url(await mac(key, `code|${normalized}`))
  const candidateBytes = encoder.encode(candidate)

  let matched: Reviewer | null = null
  let matches = 0

  for (const reviewer of roster) {
    if (equalBytes(candidateBytes, encoder.encode(reviewer.codeHash))) {
      matched = reviewer
      matches += 1
    }
  }

  if (matches !== 1) return null
  return matched
}

/**
 * The per-reviewer binding carried inside the cookie.
 *
 * It covers the reviewer's id together with their current code fingerprint, so
 * re-issuing one reviewer's code invalidates that reviewer's cookie and only
 * that reviewer's cookie. It is truncated because it is a tripwire, not a
 * signature: the token's own signature is what proves authenticity.
 */
async function reviewerBinding(key: CryptoKey, reviewer: Reviewer): Promise<string> {
  return toBase64Url(await mac(key, `bind|${reviewer.id}|${reviewer.codeHash}`)).slice(0, 32)
}

/**
 * Mint a signed, time-limited token naming one reviewer. Returns null when the
 * gate is not configured, so an unbound token can never be produced.
 */
export async function mintReviewerToken(
  reviewer: Reviewer,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const key = await signingKey()
  if (!key) return null
  if (!REVIEWER_ID_PATTERN.test(reviewer.id)) return null

  const binding = await reviewerBinding(key, reviewer)
  const expiresAt = Math.floor(nowMs / 1000) + REVIEWER_SESSION_SECONDS
  const claims = `${TOKEN_VERSION}.${reviewer.id}.${expiresAt}.${binding}`
  const signature = toBase64Url(await mac(key, claims))

  return `${claims}.${signature}`
}

/**
 * What a validly signed cookie asserts, before anyone has checked whether the
 * reviewer it names still exists.
 */
export type ReviewerClaims = {
  reviewerId: string
  /** The code-fingerprint binding this token was minted against. */
  binding: string
}

/**
 * Verify a token's own integrity, and nothing else.
 *
 * Shape, version, signature and expiry -- all decidable from the token and the
 * signing secret alone, with no roster and no I/O. That is what makes this the
 * check the Edge request boundary can run: it needs no storage driver, no
 * credential beyond the signing secret, and no network.
 *
 * It deliberately does NOT decide authorization. A token can be perfectly
 * signed and name a reviewer who was revoked a second ago. Answering that
 * question requires the live roster, which is `authorizeReviewer()` in
 * `lib/reviewer-authorization.ts`, and every page and route handler under
 * `/review` calls it.
 */
export async function verifyReviewerClaims(
  token: string | null | undefined,
  nowMs: number = Date.now(),
): Promise<ReviewerClaims | null> {
  if (!token || typeof token !== 'string') return null

  const parts = token.split('.')
  if (parts.length !== 5) return null

  const [version, reviewerId, expiresRaw, binding, signature] = parts
  if (version !== TOKEN_VERSION) return null
  if (!REVIEWER_ID_PATTERN.test(reviewerId)) return null

  const expiresAt = Number(expiresRaw)
  if (!Number.isInteger(expiresAt) || expiresAt <= 0) return null
  if (Math.floor(nowMs / 1000) >= expiresAt) return null

  const key = await signingKey()
  if (!key) return null

  const expected = toBase64Url(await mac(key, `${version}.${reviewerId}.${expiresRaw}.${binding}`))
  if (!equalBytes(encoder.encode(signature), encoder.encode(expected))) return null

  return { reviewerId, binding }
}

/**
 * Does this reviewer's *current* code fingerprint still match the binding the
 * token was minted against?
 *
 * This is what makes replacing a code end that reviewer's existing sessions
 * immediately: the new fingerprint produces a new binding, and every cookie
 * carrying the old one stops verifying on its very next request.
 */
export async function bindingMatchesReviewer(
  reviewer: Reviewer,
  binding: string,
): Promise<boolean> {
  const key = await signingKey()
  if (!key) return false
  const current = await reviewerBinding(key, reviewer)
  return equalBytes(encoder.encode(binding), encoder.encode(current))
}

/**
 * Resolve a cookie value to the reviewer it names, against the environment
 * roster, or null.
 *
 * A token is accepted only when it is well-formed, correctly signed, unexpired,
 * names a reviewer who is still on the roster right now, and carries a binding
 * that still matches that reviewer's current code fingerprint. Every other
 * path -- absent secret, wrong shape, wrong version, tampered id, bad
 * signature, expiry, removed reviewer, rotated code -- returns null.
 *
 * Because the reviewer is re-read from the roster on every request rather than
 * trusted from the token, revoking or re-scoping a reviewer takes effect on
 * their very next request without waiting for a cookie to expire.
 *
 * This reads `REVIEWER_ROSTER` specifically. Since the roster became runtime
 * state, the check callers actually want is `authorizeReviewer()` in
 * `lib/reviewer-authorization.ts`, which asks the configured roster store --
 * whatever driver that is -- and treats a revoked reviewer as absent. This one
 * remains because the environment roster is still a supported driver and
 * because it is the narrowest statement of the rule.
 */
export async function verifyReviewerToken(
  token: string | null | undefined,
  nowMs: number = Date.now(),
): Promise<Reviewer | null> {
  const claims = await verifyReviewerClaims(token, nowMs)
  if (!claims) return null

  // The signature is good, so these claims are ours. The reviewer is still
  // looked up fresh: a token is a claim about who someone is, never a grant of
  // what they may see.
  const reviewer = loadRoster().find((entry) => entry.id === claims.reviewerId)
  if (!reviewer) return null

  if (!(await bindingMatchesReviewer(reviewer, claims.binding))) return null

  return reviewer
}

/** True when this reviewer is entitled to the given book. */
export function reviewerMayRead(reviewer: Reviewer, bookSlug: string): boolean {
  return reviewer.books.includes(bookSlug)
}

/**
 * An opaque, per-reviewer namespace for this browser's own reading state.
 *
 * The reader keeps its appearance settings, its last position and its bookmark
 * in `localStorage`. Those keys are namespaced by this value so that two
 * reviewers sharing one browser profile cannot see or resume each other's
 * place. It is derived from the reviewer's id under the same domain-separated
 * key, so it is stable for that reviewer, opaque to the browser, and reveals
 * neither the reviewer's identity nor anything about their access code.
 */
export async function reviewerStorageNamespace(reviewer: Reviewer): Promise<string> {
  const key = await signingKey()
  if (!key) return 'anonymous'
  return toBase64Url(await mac(key, `storage|${reviewer.id}`)).slice(0, 16)
}

type CookieAttributes = {
  name: string
  value: string
  httpOnly: true
  secure: boolean
  sameSite: 'lax'
  path: '/review'
  maxAge: number
}

/**
 * Attributes for the reviewer cookie. HttpOnly so no script on the page can
 * read it, scoped to `/review` so it is never presented to any other route on
 * the domain, and Secure outside development so it is never sent in the clear.
 */
export function reviewerCookie(
  value: string,
  maxAge: number = REVIEWER_SESSION_SECONDS,
): CookieAttributes {
  return {
    name: REVIEWER_COOKIE_NAME,
    value,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/review',
    maxAge,
  }
}

/** Attributes that clear the reviewer cookie. Used by Sign out. */
export function clearedReviewerCookie(): CookieAttributes {
  return reviewerCookie('', 0)
}
