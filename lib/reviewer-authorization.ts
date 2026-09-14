/**
 * The authoritative answer to "may this request read a manuscript?"
 *
 * `lib/reviewer-access.ts` decides whether a cookie is *genuine*: correctly
 * signed, unexpired, ours. This module decides whether the person it names may
 * read anything *right now*, which is a different question and a changing one.
 * It asks the configured roster store on every call, so the answer follows the
 * roster rather than the cookie.
 *
 * Why the split exists at all:
 *
 *   The request boundary (`middleware.ts`) runs on the Edge runtime. Since the
 *   roster became runtime state in a private blob store, reading it needs a
 *   storage driver and a credential, which is not something to do on the Edge
 *   on every request -- and an outage there would fail every request to the
 *   whole area rather than one page.
 *
 *   So the boundary now verifies the token's integrity only, and turns away
 *   anything unsigned, tampered or expired before a manuscript module is ever
 *   loaded. This module is the enforcement point, and it runs in the Node
 *   runtime inside every page and every route handler under `/review` -- which
 *   is exactly where those checks already were. Nothing about the reader trusts
 *   the boundary to have decided anything.
 *
 * Revocation is therefore immediate in the only sense that matters: a reviewer
 * revoked, re-scoped, or re-issued a code fails their very next request to any
 * page or endpoint that serves manuscript text, with no cookie to wait out and
 * no deployment to trigger.
 */

import {
  bindingMatchesReviewer,
  identifyReviewerIn,
  verifyReviewerClaims,
  type Reviewer,
} from './reviewer-access.ts'
import { reviewerReadableBookSlugs } from './manuscript.ts'
import {
  createRosterStore,
  mutateRoster,
  type RosterDocument,
  type RosterReviewer,
} from './reviewer-roster.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/reviewer-authorization is server-only and must not be imported by a client component',
  )
}

/**
 * How stale a `lastAccessAt` may be before it is rewritten: one hour.
 *
 * The dashboard wants to show roughly when someone last opened their reading,
 * not to trace it. Writing on every request would turn every page view into a
 * roster write; writing once an hour answers the question Mike is actually
 * asking and keeps the store quiet. It is also why the field is documented as
 * accurate "to the hour" rather than to the second.
 */
export const LAST_ACCESS_GRANULARITY_MS = 60 * 60 * 1000

/**
 * The roster entry, reduced to what the reader needs.
 *
 * The reader is given a `Reviewer` -- id, name, books, codeHash -- and never
 * the entry's email, status or timestamps. Those are administration's business,
 * and the reader has no use for them.
 *
 * **Entitlements are intersected with what a reviewer may be offered at all.**
 * `viewer.books` is what every downstream rule consults -- the library listing,
 * `viewerMayReadBook`, `canViewAnnotation`, `canAccessOwnedRecord`, every route
 * handler -- so narrowing it here narrows all of them at once, from one place,
 * rather than asking each of them to remember. A book whose manifest does not
 * say `"audience": "reviewers"` is dropped even if the roster names it, so a
 * hand-edited roster, a stale entry written before the book was loaded, or a
 * restored backup cannot re-open a manuscript that is now author-only. This is
 * the first of two independent refusals; the second is in `lib/reading-service.ts`,
 * which re-checks the book itself and does not depend on this one having run.
 */
export function toReviewer(entry: RosterReviewer): Reviewer {
  const offerable = new Set(reviewerReadableBookSlugs())
  return {
    id: entry.id,
    name: entry.name,
    books: entry.books.filter((slug) => offerable.has(slug)),
    codeHash: entry.codeHash,
  }
}

/** Active reviewers only. A revoked entry is treated exactly as an absent one. */
export function activeReviewers(doc: RosterDocument): RosterReviewer[] {
  return doc.reviewers.filter((entry) => entry.status === 'active')
}

/**
 * Identify the one active reviewer whose access code was submitted, or null.
 *
 * The comparison itself lives in `lib/reviewer-access.ts` and is unchanged:
 * every entry is fingerprinted and compared with no early exit, and two matches
 * are refused as an ambiguous roster rather than resolved. This wrapper only
 * supplies the roster from the runtime store and drops revoked entries before
 * the comparison, so a revoked code is indistinguishable from an unknown one.
 */
export async function identifyReviewerFromStore(
  submittedCode: string,
): Promise<Reviewer | null> {
  const doc = await createRosterStore().load()
  return identifyReviewerIn(activeReviewers(doc).map(toReviewer), submittedCode)
}

/**
 * The full check: a genuine token, naming a reviewer who is on the roster and
 * active, whose code has not been replaced since the token was minted.
 *
 * Returns null on every failure -- no secret, bad token, unknown reviewer,
 * revoked reviewer, replaced code -- so a caller cannot accidentally treat a
 * refusal as a reviewer.
 *
 * A store that cannot be reached *throws*, and callers let it: refusing to
 * answer is correct when the roster is unknown. Reporting an outage as "not
 * authorized" would be a smaller lie than reporting it as "authorized", but it
 * would still be a lie, and it would send a legitimate reviewer to the sign-in
 * page to enter a code that would also fail.
 */
export async function authorizeReviewer(
  token: string | null | undefined,
  nowMs: number = Date.now(),
): Promise<Reviewer | null> {
  const claims = await verifyReviewerClaims(token, nowMs)
  if (!claims) return null

  const store = createRosterStore()
  const doc = await store.load()

  const entry = doc.reviewers.find((row) => row.id === claims.reviewerId)
  if (!entry) return null
  if (entry.status !== 'active') return null

  const reviewer = toReviewer(entry)
  if (!(await bindingMatchesReviewer(reviewer, claims.binding))) return null

  await touchLastAccess(entry, nowMs)

  return reviewer
}

/**
 * Record that this reviewer was seen, at most once an hour.
 *
 * Everything here is best-effort and deliberately swallowed. A read-only
 * driver, a conflicting concurrent write, or a store hiccup must never turn
 * into a refusal: this reviewer has already been authorised, and failing to
 * write down *when* is not a reason to stop them reading. The one thing it
 * must not do is throw, which would do exactly that.
 */
async function touchLastAccess(entry: RosterReviewer, nowMs: number): Promise<void> {
  const store = createRosterStore()
  if (!store.writable) return

  const previous = entry.lastAccessAt ? Date.parse(entry.lastAccessAt) : 0
  if (Number.isFinite(previous) && nowMs - previous < LAST_ACCESS_GRANULARITY_MS) return

  try {
    /*
     * Derived from whatever document is actually stored, and written back
     * conditionally on that exact revision -- so this bookkeeping write cannot
     * clobber a revocation, an entitlement change or an address change that
     * landed in between. On a conflict it re-reads and re-decides, and if the
     * reviewer has been revoked by then it simply declines to write.
     */
    await mutateRoster((current) => {
      const target = current.reviewers.find((row) => row.id === entry.id)
      if (!target || target.status !== 'active') return null

      const seen = target.lastAccessAt ? Date.parse(target.lastAccessAt) : 0
      if (Number.isFinite(seen) && nowMs - seen < LAST_ACCESS_GRANULARITY_MS) return null

      return {
        reviewers: current.reviewers.map((row) =>
          row.id === entry.id ? { ...row, lastAccessAt: new Date(nowMs).toISOString() } : row,
        ),
        // Not an administrative act, and never has been audited: seeing a
        // reviewer read is bookkeeping, not a change to what anybody may do.
        event: null,
        result: null,
      }
    }, store)
  } catch {
    // Deliberately ignored. See above.
  }
}

/**
 * True only when a reviewer could possibly sign in: a signing secret is
 * configured and the roster names at least one active reviewer.
 *
 * The sign-in endpoint uses this to tell "nobody has been set up" apart from
 * "that code is wrong", because the first is worth saying plainly to a reviewer
 * and the second must never be.
 */
export async function isReviewerAccessLive(): Promise<boolean> {
  if (!(process.env.REVIEWER_AUTH_SECRET ?? '').trim()) return false
  try {
    const doc = await createRosterStore().load()
    return activeReviewers(doc).length > 0
  } catch {
    return false
  }
}
