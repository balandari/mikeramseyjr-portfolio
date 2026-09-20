/**
 * The brake on the endpoints a stranger can reach.
 *
 * Before this work, `/review/api/unlock` was the only unauthenticated write on
 * the whole site. Reviewer requests and sign-in links add two more, and both of
 * them send email, so an unthrottled one is a way to make this site mail
 * somebody repeatedly. That is the thing this file exists to prevent.
 *
 * ## Where the brake is, in production
 *
 * **Here, in this application, and it is primary.** A Vercel WAF rate-limit rule
 * is a worthwhile *backstop* in front of it — coarse, keyed on IP or JA4, and
 * blind to which email address was typed — but it is not a replacement, and this
 * file no longer offers a way to say that it is.
 *
 * That way used to exist. `RATE_LIMIT_UPSTREAM` took precedence over everything
 * below: setting it reported `upstream`, and every caller then stopped counting.
 * The rules at `RULES` include two keyed on the **address** — three requests per
 * day, five sign-in links per hour — and no rule keyed on a client address can
 * stand in for those. So declaring the backstop disabled the stronger control,
 * silently, in the name of not duplicating work. **The variable is gone.** There
 * is no application flag that announces the WAF, nothing reads one, and
 * configuring a Firewall rule cannot turn off the local client and address
 * limits. The WAF sits in front and absorbs floods; this counts.
 *
 * The one remaining variable, `RATE_LIMIT_TRUST_STORE=1`, makes a narrow and
 * different claim, and it is the claim the production deployment makes after the
 * live Blob proof: *this store's create-if-absent has been demonstrated atomic
 * under concurrency on this deployment, so the application may count for
 * itself.* See `limiterStatus()`.
 *
 * ## Why the in-application limiter claims only the one primitive it needs
 *
 * The obvious design — one counter object per window, read it, add one, write
 * it back — is **not safe**: two requests can read the same number and write the
 * same number back, and the store offers no compare-and-swap that has been
 * proven from here.
 *
 * A previous design in this file avoided the counter but replaced it with
 * something no better founded: every hit created a uniquely-named object, and a
 * caller then listed the window and admitted itself if its own name sorted
 * within the first `limit`. That needs two properties nobody here can
 * demonstrate — that a just-created object is immediately visible to a
 * subsequent `list()`, and that every caller derives the same global order —
 * **and it was wrong even on the filesystem**, where both hold. Two hits in the
 * same millisecond are ordered by a random suffix, so a later hit whose suffix
 * sorts earlier takes a rank already handed out. With `limit: 1`, two
 * sequential calls were both admitted; that was reproduced against this module
 * before it was replaced.
 *
 * What is here now needs **create-if-absent and nothing else**. A window holds
 * `limit` numbered slots, and a caller is admitted if and only if it manages to
 * create one:
 *
 *     auth/v2/limits/<scope>/<window>/<key>/slot-0001.json … slot-<limit>.json
 *
 * Each slot is created by exactly one caller, because create-if-absent is
 * atomic; a caller that finds every slot taken is refused. No listing, no
 * ordering, no visibility assumption, and no counter. It is also naturally
 * bounded: a key can never cause more than `limit` objects in a window however
 * hard it is hammered, so there is no hard cap to tune and no write
 * amplification to guard against.
 *
 * ## Why it still refuses to run on an unproven store
 *
 * On Vercel Blob, create-if-absent is `put(..., { allowOverwrite: false })`.
 * The installed SDK documents that it throws when the object exists, and the
 * roster's audit log already relies on it — but whether the live service
 * enforces it under real concurrency is a property of the service rather than of
 * its documentation, and it has to be watched happening.
 *
 * Every other guarantee in this feature degrades gracefully if that assumption
 * is weaker than documented: a credential consumed twice signs the same person
 * into the same account twice. This one does not — it is the guarantee that has
 * to hold against somebody actively attacking it. So until that proof exists,
 * `limiterStatus()` reports `unproven` on a Blob store, the two mail-sending
 * endpoints treat anything but `ready` as unavailable, and they fail closed.
 * `RATE_LIMIT_TRUST_STORE=1` is how a deployment records that the proof was run
 * against it — `scripts/blob-probe.mjs --live`, V1 through V9, green — and it is
 * the only thing that can open those endpoints on Blob.
 *
 * ## Two policies, and which endpoint gets which
 *
 * **Fail closed** on `/review/api/request` and `/review/api/signin`: they cause
 * email, so an unthrottled one is an abuse channel, and refusing is the safe
 * direction.
 *
 * **Fail open** on `/review/api/credential` and `/review/api/unlock`: both spend
 * a credential — 256 bits of randomness, or an access code of the same order —
 * so guessing is not the threat the limiter holds back, and refusing every
 * attempt because the counter is unavailable would lock out exactly the people
 * the system exists for. Neither sends mail. `allowCredentialAttempt()` is that
 * policy written once, so the two cannot drift apart; `/review/api/unlock` had
 * no limiter at all until this pass, and performed two roster-backed reads for
 * every invalid submission.
 *
 * Nothing here stores an address of any kind. The bucket is named by a keyed,
 * non-reversible label of the email address or the client address; the object
 * inside it holds a timestamp and nothing else; and the whole window is
 * meaningless once it has passed.
 */

import { createPrivateStore, pathLabel, type PrivateStore } from './private-store.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/rate-limit is server-only and must not be imported by a client component',
  )
}

/** `v2`, moving with the keyed label's change to a real HMAC. */
export const LIMITS_ROOT = 'auth/v2/limits'

/**
 * `ready`       this application's own limiter is enforcing the rules below.
 * `unproven`    a store whose create-if-absent has not been demonstrated. Treated
 *               exactly as `unavailable` by every caller.
 * `unavailable` no store to count in.
 *
 * There is deliberately no status meaning "something in front of us is
 * counting". A WAF rule is a backstop, it cannot see an email address, and the
 * ability to make it replace these rules is what this pass removed.
 */
export type LimiterStatus = 'ready' | 'unproven' | 'unavailable'

export type RateLimitRule = {
  /** Names the bucket. Appears in pathnames, so it is a plain slug. */
  scope: string
  limit: number
  windowMs: number
}

/** The rules, in one place, so they can be read without reading the handlers. */
export const RULES = {
  /** A prospective reviewer asking for access. */
  requestByAddress: { scope: 'request-address', limit: 3, windowMs: 24 * 60 * 60 * 1000 },
  requestByClient: { scope: 'request-client', limit: 5, windowMs: 60 * 60 * 1000 },
  /** Asking for a sign-in link. */
  signinByAddress: { scope: 'signin-address', limit: 5, windowMs: 60 * 60 * 1000 },
  signinByClient: { scope: 'signin-client', limit: 20, windowMs: 60 * 60 * 1000 },
  /** Presenting a credential. Bounds guessing, well above any honest use. */
  credentialByClient: { scope: 'credential-client', limit: 10, windowMs: 60 * 60 * 1000 },
} satisfies Record<string, RateLimitRule>

/**
 * Whether this application can count, and therefore whether the fail-closed
 * endpoints may open.
 *
 * Nothing outside this application is consulted, and nothing outside it can
 * change the answer. A Firewall rule in front of the deployment is a backstop
 * and is invisible here on purpose: being able to make it change this answer is
 * precisely what silently disabled the per-address limits.
 */
export function limiterStatus(store: PrivateStore = createPrivateStore()): LimiterStatus {
  if (!store.writable) return 'unavailable'
  if (store.provenAtomic) return 'ready'
  const trusted = (process.env.RATE_LIMIT_TRUST_STORE ?? '').trim() === '1'
  return trusted ? 'ready' : 'unproven'
}

/** True only when this application is actually throttling. */
export function limiterReady(store: PrivateStore = createPrivateStore()): boolean {
  return limiterStatus(store) === 'ready'
}

function windowPrefix(rule: RateLimitRule, keyLabel: string, nowMs: number): string {
  const windowId = Math.floor(nowMs / rule.windowMs)
  return `${LIMITS_ROOT}/${rule.scope}/${windowId}/${keyLabel}/`
}

function slotName(index: number): string {
  return `slot-${String(index).padStart(4, '0')}.json`
}

export type RateLimitOutcome = {
  allowed: boolean
  /**
   * The slot this hit claimed, 1-based; `rule.limit` when every slot was
   * already taken. Never a count of attempts, and never derived from a listing.
   */
  used: number
}

/**
 * Record one hit against a rule and say whether it is allowed.
 *
 * Correct given one property of the store and no others: that `create()` is
 * atomic create-if-absent, so exactly one caller can create any given path.
 * Every admitted caller holds a slot no other caller holds, so at most `limit`
 * callers are admitted per key per window — under any interleaving, with no
 * assumption about listing, caching, clocks or ordering.
 *
 * A storage failure **propagates**. The callers turn that into the same "not
 * available right now" a missing store produces: with no brake, the endpoint
 * does not open.
 */
export async function recordAndCheck(
  rule: RateLimitRule,
  key: string,
  store: PrivateStore = createPrivateStore(),
  nowMs: number = Date.now(),
): Promise<RateLimitOutcome> {
  const label = pathLabel(`ratelimit|${rule.scope}`, key)
  const prefix = windowPrefix(rule, label, nowMs)
  const body = `${JSON.stringify({ schema: 1, at: new Date(nowMs).toISOString() })}\n`

  /*
   * One cheap read before the probing, so a key that is already at its limit
   * costs one round trip rather than `limit` failed writes. It is an
   * optimisation and nothing rests on it: if it is stale in either direction
   * the loop below still decides, and the loop is the part that is atomic.
   */
  if (rule.limit > 1 && (await store.read(`${prefix}${slotName(rule.limit)}`)) !== null) {
    return { allowed: false, used: rule.limit }
  }

  for (let index = 1; index <= rule.limit; index += 1) {
    if ((await store.create(`${prefix}${slotName(index)}`, body)).created) {
      return { allowed: true, used: index }
    }
  }

  return { allowed: false, used: rule.limit }
}

/**
 * The client's address, as a string to be hashed — never stored, never logged.
 *
 * `x-forwarded-for` is set by Vercel's proxy and is the only trustworthy source
 * there; its first entry is the client. Locally there is often nothing, and
 * everything then shares one bucket, which is correct for a machine where
 * "everything" is one person.
 */
/**
 * The availability policy shared by the two endpoints that **spend** a
 * credential: `/review/api/credential` and `/review/api/unlock`.
 *
 * One function, because two copies of a security policy is one copy too many and
 * the unlock route spent this whole feature's development with no copy at all.
 *
 * What it promises, and each half matters:
 *
 *   - **When the limiter is trustworthy, it throttles — first.** The caller must
 *     invoke this before any roster read, so that a caller at or beyond the
 *     limit costs the store **at most the limiter's one read, no writes, and no
 *     roster read at all.** That bound is a property of `recordAndCheck`: a key
 *     whose last slot already exists returns on that single read without
 *     attempting a single `create()`.
 *   - **When it is not, it admits.** A missing store, an unproven one, or a
 *     limiter that throws are all noise here rather than a security failure:
 *     what these endpoints receive is 256 bits of randomness (or an access code
 *     of the same order), guessing is not the threat being held back, and
 *     neither endpoint sends mail. Locking out a legitimate code holder because
 *     a counter is unavailable is the worse of the two failures, by a distance.
 *
 * Contrast `/review/api/request` and `/review/api/signin`, which fail closed:
 * they cause email, and an unthrottled mail trigger is an abuse channel.
 *
 * Returns true when the attempt may proceed.
 */
export async function allowCredentialAttempt(
  headers: Headers,
  store: PrivateStore | null,
): Promise<boolean> {
  if (!store) return true
  if (!limiterReady(store)) return true
  try {
    const outcome = await recordAndCheck(RULES.credentialByClient, clientKey(headers), store)
    return outcome.allowed
  } catch {
    // A limiter that cannot answer does not get to refuse a real reviewer.
    return true
  }
}

export function clientKey(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  const real = headers.get('x-real-ip')
  if (real && real.trim()) return real.trim()
  return 'unknown-client'
}
