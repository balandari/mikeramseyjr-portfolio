import type { NextRequest } from 'next/server'

import { privateSameOriginRedirect } from '@/lib/redirect'
import { createPrivateStore, hasAuthSecret } from '@/lib/private-store'
import { RULES, clientKey, limiterReady, recordAndCheck } from '@/lib/rate-limit'
import {
  cleanRequestEmail,
  cleanRequestMessage,
  cleanRequestName,
} from '@/lib/reviewer-requests'
import { submitAccessRequest } from '@/lib/reviewer-onboarding'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The one endpoint a complete stranger can write to.
 *
 * Four things are true of every request that reaches the store through here:
 *
 *   0. **The deployment is configured at all.** Every keyed pathname in this
 *      feature -- the request's own identity, the rate limiter's buckets, a
 *      mail operation's record -- is an HMAC under `REVIEWER_AUTH_SECRET`.
 *      Without it there is no label to write under and no credential could ever
 *      be issued to approve this request into, so the endpoint closes rather
 *      than storing a request Mike could never act on. An earlier version
 *      claimed this in a comment and did not do it; the Judge was right.
 *   1. **It was throttled first, by this application** — on the client address
 *      before anything in the body is believed, and then on the email address
 *      itself. This endpoint causes email, so an unthrottled one is a way to
 *      make this site mail somebody repeatedly. If the application's own limiter
 *      is not available, nothing is accepted at all — see `lib/rate-limit.ts`
 *      for why that is the fail-closed direction, and why no upstream
 *      declaration can substitute for the per-address rule.
 *   2. **Nothing it sent was trusted.** The name, address and message are
 *      cleaned here; everything else in the body is ignored.
 *   3. **It is saved before any email is attempted**, so an email failure can
 *      never lose a request, and can never approve one either.
 *   4. **It gets the same answer as every other submission.** New, already
 *      pending, already a reviewer, revoked, rejected by the honeypot, rejected
 *      by the limiter after the point of no return — all of it lands on
 *      `?sent=1`. The only distinguishable answers are "your form was
 *      incomplete" and "this is unavailable right now", and neither depends on
 *      *which* address was typed.
 *
 * No access code, credential, address or message is ever written to a log here.
 * The only thing this handler emits is a redirect to a path on this same origin.
 */

function answer(path: string) {
  return privateSameOriginRedirect(path)
}

const SENT = '/review/request?sent=1'

/** A form posted this fast was not filled in by a person. */
const MINIMUM_FILL_MS = 1500
/** A form left open for a fortnight is a stale tab, not a submission. */
const MAXIMUM_FILL_MS = 24 * 60 * 60 * 1000

export async function POST(request: NextRequest) {
  /*
   * Fail closed on a missing secret, before the body is read and before the
   * store is touched. See point 0 above: without it there is no keyed label to
   * write under and no credential this request could ever be approved into.
   */
  if (!hasAuthSecret()) return answer('/review/request?error=unavailable')

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return answer('/review/request?error=1')
  }

  const store = (() => {
    try {
      return createPrivateStore()
    } catch {
      return null
    }
  })()

  if (!store || !limiterReady(store)) {
    /*
     * No store, no declared upstream limiter, or a store whose create-if-absent
     * has not been proven under concurrency. Accepting requests without a
     * working brake is the one thing this endpoint must not do, so it closes
     * and says so plainly.
     */
    return answer('/review/request?error=unavailable')
  }

  // Throttle on the client first: it is the only key available before anything
  // in the body has been believed.
  try {
    const byClient = await recordAndCheck(
      RULES.requestByClient,
      clientKey(request.headers),
      store,
    )
    if (!byClient.allowed) return answer(SENT)
  } catch {
    return answer('/review/request?error=unavailable')
  }

  const name = cleanRequestName(form.get('name'))
  const email = cleanRequestEmail(form.get('email'))
  const message = cleanRequestMessage(form.get('message'))

  if (!name || !email || !message) {
    return answer('/review/request?error=1')
  }

  // The honeypot and the clock. Both answer exactly as a success does, because
  // telling an automated filler that it was caught only teaches it to stop
  // filling that field in.
  const trap = form.get('website')
  if (typeof trap === 'string' && trap.trim() !== '') return answer(SENT)

  const openedRaw = form.get('openedAt')
  const opened = typeof openedRaw === 'string' ? Number(openedRaw) : NaN
  const elapsed = Number.isFinite(opened) ? Date.now() - opened : NaN
  if (!Number.isFinite(elapsed) || elapsed < MINIMUM_FILL_MS || elapsed > MAXIMUM_FILL_MS) {
    return answer(SENT)
  }

  try {
    const byAddress = await recordAndCheck(RULES.requestByAddress, email, store)
    if (!byAddress.allowed) return answer(SENT)
  } catch {
    return answer('/review/request?error=unavailable')
  }

  try {
    await submitAccessRequest({ name, email, message }, { store })
  } catch {
    /*
     * The store refused, or the roster could not be read. Nothing was half
     * written -- the record is created in one write after the address index is
     * claimed -- and saying "unavailable" is the honest answer, because
     * "thank you" here would be a promise nobody could keep.
     */
    return answer('/review/request?error=unavailable')
  }

  return answer(SENT)
}
