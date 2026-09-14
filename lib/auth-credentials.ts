/**
 * One-use, expiring credentials: the activation link that opens a new
 * reviewer's account, and the sign-in link that opens it again on another
 * device.
 *
 * This is the only module in the codebase that mints a credential a person
 * receives, apart from `lib/reviewer-code.ts`. It follows the same rule that
 * one does, and follows it harder:
 *
 *   **The credential exists in plaintext for exactly as long as it takes to put
 *   it in an email.** It is never stored, never logged, never returned to the
 *   dashboard, never placed in a query string, and cannot be recovered from
 *   anything this system keeps. What is stored is `HMAC(secret, purpose|token)`
 *   -- and it is stored *as the pathname*, so a full dump of the store yields no
 *   usable credential and nothing to reverse.
 *
 * ## There is no current-credential pointer, and that is the whole design
 *
 * Three review rounds each found the next interleaving in this file, and every
 * one of them lived in the same object: a mutable `auth/v1/current/...` pointer
 * whose only job was to make "only the newest email works" true. That rule
 * required an ordering to hold across three independent systems -- the object
 * store, the process, and the mail provider -- and there is no transaction
 * across them, so each repair narrowed a window rather than closing a class.
 *
 * The rule is gone. **Every unexpired, unused credential stays valid until it
 * is used or expires**, and each one is individually single-use. The pointer,
 * the generation claims, `readCurrent`, `liveCurrent`, `isCurrentCredential`,
 * `retireCurrent`, `retireIssued` and the `superseded` outcome are all deleted
 * rather than repaired, because with nothing mutable in the credential path
 * there is nothing for an interleaving to corrupt.
 *
 * What this costs, honestly: a leaked older link is no longer killed
 * automatically by the reviewer asking for a new one. That exposure is narrow
 * -- it needs a leaked, unused, older link that is not also a mailbox
 * compromise, and the attacker has to win the single use before the reviewer
 * and before expiry -- and it is bounded by the TTL, by single use, by the
 * roster's status at the moment of use, by address binding, by the activation
 * rule, and by an epoch Mike can advance deliberately. What it buys is that the
 * whole class of ordering failures stops existing.
 *
 * ## The two objects, and what each one is for
 *
 *   `auth/v2/cred/<purpose>/<hash>.json`   what this credential is for
 *   `auth/v2/used/<purpose>/<hash>.json`   created once, by whoever spent it
 *
 * Both are created with create-if-absent and **neither is ever rewritten or
 * removed**. The prefix is `v2` because the layout changed and because
 * `pathLabel` became a real HMAC: no object written under the old scheme is
 * ever read under this one.
 *
 * ## What a credential is bound to
 *
 * Three things, all recorded at issue and all compared at use:
 *
 *   `reviewerId`       whose account this opens
 *   `emailLabel`       a keyed, non-reversible label of the address the message
 *                      was **sent to**. No address is stored. If Mike changes
 *                      the address, the label stops matching and the link dies.
 *   `credentialEpoch`  the reviewer's integer epoch at the moment of issue.
 *                      Mike advances it -- inside the same conditional roster
 *                      mutation that performs the change -- on revocation, on an
 *                      email change, and on an explicit "invalidate outstanding
 *                      links". Consumption requires **equality**, never
 *                      "greater than", so any advance kills every credential
 *                      issued before it, with no clock and no skew.
 *
 * The epoch is what makes the A-to-B-and-back-to-A case safe: the address label
 * matches again, but the epoch has moved twice, so a link sent to the first A
 * is still refused.
 *
 * ## Spending is a fence, not an authorization
 *
 * `spendCredential()` creates the used marker. Whichever caller's create returns
 * true has **permanently spent** the credential, and every other caller -- now
 * or later -- is refused. That is the linearization point for single use.
 *
 * It is deliberately *not* the authorization decision. After the marker exists,
 * the caller must still confirm the reviewer's current roster state before it
 * mints anything, and where an administrative change has landed in between, the
 * credential stays spent and **no session is minted**. Where a credential
 * consumption and an administrative security action are concurrent, the
 * administrative action wins; that is the fail-closed direction. The ordering
 * lives in `lib/reviewer-onboarding.ts`, which is the only place that holds
 * both the credential and the roster.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { authSecret, createPrivateStore, pathLabel, type PrivateStore } from './private-store.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/auth-credentials is server-only and must not be imported by a client component',
  )
}

/** Layout version. A later layout is a new prefix, never a reinterpretation. */
export const AUTH_PREFIX_VERSION = 'v2'
export const AUTH_ROOT = `auth/${AUTH_PREFIX_VERSION}`

export type CredentialPurpose = 'activation' | 'signin'

/** Activation: long enough to survive a weekend in somebody's inbox. */
export const ACTIVATION_TTL_MS = 72 * 60 * 60 * 1000
/** Returning sign-in: long enough to walk to the other device, and no longer. */
export const SIGNIN_TTL_MS = 15 * 60 * 1000

/** 32 bytes, base64url. 256 bits, against the access code's ~78. */
const TOKEN_BYTES = 32
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

const SUBJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Bytes of the mail-operation identity. Not a credential; not secret. */
const OPERATION_ID_BYTES = 12

/**
 * Domain separation, per purpose. An activation credential can never be
 * presented as a sign-in credential or the other way round: the same bytes hash
 * to a different pathname under each label, so the wrong purpose simply finds
 * nothing.
 *
 * The labels carry `v2` for the same reason the prefix does.
 */
const LABELS: Record<CredentialPurpose, string> = {
  activation: 'mikeramseyjr/activation/v2',
  signin: 'mikeramseyjr/signin/v2',
}

export type CredentialRecord = {
  schema: 1
  purpose: CredentialPurpose
  /** The roster id this credential signs in. */
  reviewerId: string
  /** The access request it came from, when it came from one. */
  requestId: string | null
  /**
   * This credential's mail-operation identity.
   *
   * Random, unrelated to the token, and worth nothing to anybody holding it: it
   * identifies *which message* carried *which credential*, so two different
   * messages can never share one idempotency key.
   */
  operationId: string
  /**
   * A keyed, non-reversible label of the address this credential was sent to.
   * No address is stored anywhere in this record.
   */
  emailLabel: string
  /** The reviewer's epoch at the moment of issue. Compared for equality at use. */
  credentialEpoch: number
  issuedAt: string
  expiresAt: string
}

/** What `issueCredential` hands back. The token is in here and nowhere else. */
export type IssuedCredential = {
  /** Plaintext. Goes into one email and is then gone. Never stored, never logged. */
  token: string
  tokenHash: string
  /** See `CredentialRecord.operationId`. Not a secret. */
  operationId: string
  expiresAt: string
}

/* ----------------------------------------------------------------- helpers */

function toBase64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * The stored fingerprint of one credential.
 *
 * Hex, because it becomes a pathname. Keyed, because a bare hash of a token
 * would let anybody holding the store confirm a guessed token; with the key
 * they cannot.
 */
export function fingerprint(purpose: CredentialPurpose, token: string): string | null {
  const key = authSecret()
  if (!key) return null
  if (!TOKEN_PATTERN.test(token)) return null
  return createHmac('sha256', key).update(`${LABELS[purpose]}|${token}`, 'utf8').digest('hex')
}

/**
 * The keyed label of one address, as a credential records it.
 *
 * The caller passes an address already normalised the way the roster normalises
 * it, so that two spellings of one mailbox are two labels exactly as they are
 * two roster entries.
 */
export function credentialEmailLabel(normalizedEmail: string): string {
  return pathLabel('cred-email', normalizedEmail)
}

/** Byte comparison with no early exit, for two hex labels of equal length. */
export function sameLabel(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function credentialPath(purpose: CredentialPurpose, hash: string): string {
  return `${AUTH_ROOT}/cred/${purpose}/${hash}.json`
}

export function usedPath(purpose: CredentialPurpose, hash: string): string {
  return `${AUTH_ROOT}/used/${purpose}/${hash}.json`
}

/**
 * Legacy values parse as zero, following the `emailVerifiedAt` precedent: an
 * entry written before epochs existed has never had one advanced, and zero is
 * exactly what that means. There is no schema bump.
 */
export function asEpoch(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function parseCredential(raw: string | null): CredentialRecord | null {
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const row = value as Record<string, unknown>
    if (row.schema !== 1) return null
    if (row.purpose !== 'activation' && row.purpose !== 'signin') return null
    if (typeof row.reviewerId !== 'string' || !SUBJECT_PATTERN.test(row.reviewerId)) return null
    if (typeof row.expiresAt !== 'string' || Number.isNaN(Date.parse(row.expiresAt))) return null
    if (typeof row.operationId !== 'string' || !/^[a-f0-9]{24}$/.test(row.operationId)) return null
    if (typeof row.emailLabel !== 'string' || !/^[a-f0-9]{32}$/.test(row.emailLabel)) return null
    return {
      schema: 1,
      purpose: row.purpose,
      reviewerId: row.reviewerId,
      requestId: typeof row.requestId === 'string' ? row.requestId : null,
      operationId: row.operationId,
      emailLabel: row.emailLabel,
      credentialEpoch: asEpoch(row.credentialEpoch),
      issuedAt: typeof row.issuedAt === 'string' ? row.issuedAt : '',
      expiresAt: row.expiresAt,
    }
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------- the API */

/**
 * Mint one credential and hand back the plaintext.
 *
 * Nothing is retired, nothing is superseded, and nothing else in the store is
 * touched: this is **one create-if-absent of one immutable object**. Two
 * simultaneous issues for the same reviewer therefore have nothing to race on,
 * and both credentials work, once each, until they expire.
 *
 * `emailLabel` and `credentialEpoch` come from the caller's single read of the
 * roster, so the credential records the state it was issued under. An
 * administrative change that commits after that read advances the epoch, and
 * the credential is refused at use.
 */
export async function issueCredential(
  purpose: CredentialPurpose,
  input: {
    reviewerId: string
    requestId?: string | null
    /** From `credentialEmailLabel()`, of the address the message will go to. */
    emailLabel: string
    credentialEpoch: number
    ttlMs?: number
  },
  store: PrivateStore = createPrivateStore(),
  nowMs: number = Date.now(),
): Promise<IssuedCredential | null> {
  if (!authSecret()) return null
  if (!SUBJECT_PATTERN.test(input.reviewerId)) return null
  if (!/^[a-f0-9]{32}$/.test(input.emailLabel)) return null

  const token = toBase64Url(randomBytes(TOKEN_BYTES))
  const tokenHash = fingerprint(purpose, token)
  if (!tokenHash) return null

  const ttl = input.ttlMs ?? (purpose === 'activation' ? ACTIVATION_TTL_MS : SIGNIN_TTL_MS)
  const operationId = randomBytes(OPERATION_ID_BYTES).toString('hex')

  const record: CredentialRecord = {
    schema: 1,
    purpose,
    reviewerId: input.reviewerId,
    requestId: input.requestId ?? null,
    operationId,
    emailLabel: input.emailLabel,
    credentialEpoch: asEpoch(input.credentialEpoch),
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttl).toISOString(),
  }

  // Create-only: a pathname collision would mean the same 256-bit token twice,
  // which is not a thing to overwrite through.
  const created = await store.create(
    credentialPath(purpose, tokenHash),
    `${JSON.stringify(record, null, 2)}\n`,
  )
  if (!created.created) return null

  return { token, tokenHash, operationId, expiresAt: record.expiresAt }
}

/** The record for one credential hash, or null. Never contains the token. */
export async function readCredential(
  purpose: CredentialPurpose,
  tokenHash: string,
  store: PrivateStore = createPrivateStore(),
): Promise<CredentialRecord | null> {
  if (!/^[a-f0-9]{64}$/.test(tokenHash)) return null
  return parseCredential(await store.read(credentialPath(purpose, tokenHash)))
}

/** Whether a `used` marker has been created for this exact credential. */
export async function isSpent(
  purpose: CredentialPurpose,
  tokenHash: string,
  store: PrivateStore = createPrivateStore(),
): Promise<boolean> {
  return (await store.read(usedPath(purpose, tokenHash))) !== null
}

/**
 * Spend a credential, permanently, exactly once.
 *
 * Returns true for the one caller whose create landed, and false for every
 * other -- concurrent or later. **True does not mean the attempt is
 * authenticated**; it means this credential can never be used again. See the
 * header comment, and `activateWithCredential` / `signinWithCredential` in
 * `lib/reviewer-onboarding.ts` for what has to happen afterwards.
 */
export async function spendCredential(
  purpose: CredentialPurpose,
  tokenHash: string,
  store: PrivateStore = createPrivateStore(),
  nowMs: number = Date.now(),
): Promise<boolean> {
  const claimed = await store.create(
    usedPath(purpose, tokenHash),
    `${JSON.stringify({ schema: 1, at: new Date(nowMs).toISOString(), reason: 'used' }, null, 2)}\n`,
  )
  return claimed.created
}

/**
 * Whether a credential is still outstanding: it exists, it has not expired, it
 * has not been spent, and its epoch still matches the reviewer's.
 *
 * This is what the dashboard's "an access email is outstanding" indicator asks.
 * It reads a record holding a hash, two labels, an integer and two timestamps,
 * and nothing that could be used to sign in.
 */
export async function isOutstanding(
  purpose: CredentialPurpose,
  tokenHash: string,
  currentEpoch: number,
  store: PrivateStore = createPrivateStore(),
  nowMs: number = Date.now(),
): Promise<boolean> {
  const record = await readCredential(purpose, tokenHash, store)
  if (!record) return false
  if (Date.parse(record.expiresAt) <= nowMs) return false
  if (record.credentialEpoch !== asEpoch(currentEpoch)) return false
  return !(await isSpent(purpose, tokenHash, store))
}

/**
 * Turn a submitted token into the hash and record it names, without spending
 * anything.
 *
 * Every refusal is reported by name **to the server**, because the server has
 * to behave differently for an expired credential than for a forged one. What
 * the visitor is shown is one generic page: see `app/review/activate`.
 */
export type CredentialLookup =
  | { ok: true; tokenHash: string; record: CredentialRecord }
  | { ok: false; reason: 'malformed' | 'unconfigured' | 'unknown' | 'expired' }

export async function lookupCredential(
  purpose: CredentialPurpose,
  token: string,
  store: PrivateStore = createPrivateStore(),
  nowMs: number = Date.now(),
): Promise<CredentialLookup> {
  if (!authSecret()) return { ok: false, reason: 'unconfigured' }
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    return { ok: false, reason: 'malformed' }
  }

  const tokenHash = fingerprint(purpose, token)
  if (!tokenHash) return { ok: false, reason: 'unconfigured' }

  const record = await readCredential(purpose, tokenHash, store)
  if (!record) return { ok: false, reason: 'unknown' }
  if (Date.parse(record.expiresAt) <= nowMs) return { ok: false, reason: 'expired' }

  return { ok: true, tokenHash, record }
}
