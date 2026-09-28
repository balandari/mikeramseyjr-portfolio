import type { NextRequest } from 'next/server'

import { privateSameOriginRedirect } from '@/lib/redirect'
import { createPrivateStore, hasAuthSecret } from '@/lib/private-store'
import { RULES, clientKey, limiterReady, recordAndCheck } from '@/lib/rate-limit'
import { cleanRequestEmail } from '@/lib/reviewer-requests'
import { requestSigninLink } from '@/lib/reviewer-onboarding'
import { readBoundedForm, SIGNIN_FORM_LIMIT_BYTES } from '@/lib/request-bounds'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * "Email me a sign-in link."
 *
 * The second endpoint a stranger can make send mail, and it is throttled by this
 * application and fail-closed for exactly the same reason the request form is.
 * The per-address rule here — five links an hour to one mailbox — is the one a
 * coarse IP-keyed backstop cannot express, which is why nothing outside this
 * application is allowed to switch it off.
 *
 * **Every path returns `?sent=1`.** An address belonging to an active reviewer
 * who has proved it, one belonging to somebody who has not, one belonging to a
 * revoked reviewer, one belonging to nobody, one caught by the limiter and one
 * caught by the honeypot are indistinguishable from outside. The only other
 * answers are "that is not an email address" and "not available right now",
 * and neither depends on which address was typed.
 *
 * Nothing is logged. The address is not written to a request record, an audit
 * line, or anywhere else by this handler — it is used to look up a roster entry
 * and then dropped.
 */

const SENT = '/review/signin?sent=1'

const MINIMUM_FILL_MS = 1000
const MAXIMUM_FILL_MS = 24 * 60 * 60 * 1000

export async function POST(request: NextRequest) {
  // Fail closed on a missing `REVIEWER_AUTH_SECRET` before the body is read and
  // before the store is touched, exactly as the request route does: no secret
  // means no keyed label, no limiter bucket, and no credential to mint.
  if (!hasAuthSecret()) return privateSameOriginRedirect('/review/signin?error=unavailable')

  // Bounded and typed before parsing, and before the store or the limiter is
  // reached. See `lib/request-bounds.ts`. Every refusal is the same generic
  // answer this route already gives a body it cannot read.
  const bounded = await readBoundedForm(request, SIGNIN_FORM_LIMIT_BYTES)
  if (!bounded.ok) return privateSameOriginRedirect('/review/signin?error=1')
  const form = bounded.value

  const store = (() => {
    try {
      return createPrivateStore()
    } catch {
      return null
    }
  })()

  if (!store || !limiterReady(store)) {
    return privateSameOriginRedirect('/review/signin?error=unavailable')
  }

  try {
    const byClient = await recordAndCheck(RULES.signinByClient, clientKey(request.headers), store)
    if (!byClient.allowed) return privateSameOriginRedirect(SENT)
  } catch {
    return privateSameOriginRedirect('/review/signin?error=unavailable')
  }

  const email = cleanRequestEmail(form.get('email'))
  if (!email) return privateSameOriginRedirect('/review/signin?error=1')

  const trap = form.get('website')
  if (typeof trap === 'string' && trap.trim() !== '') return privateSameOriginRedirect(SENT)

  const openedRaw = form.get('openedAt')
  const opened = typeof openedRaw === 'string' ? Number(openedRaw) : NaN
  const elapsed = Number.isFinite(opened) ? Date.now() - opened : NaN
  if (!Number.isFinite(elapsed) || elapsed < MINIMUM_FILL_MS || elapsed > MAXIMUM_FILL_MS) {
    return privateSameOriginRedirect(SENT)
  }

  try {
    const byAddress = await recordAndCheck(RULES.signinByAddress, email, store)
    if (!byAddress.allowed) return privateSameOriginRedirect(SENT)
  } catch {
    return privateSameOriginRedirect('/review/signin?error=unavailable')
  }

  try {
    // Sends only for an active reviewer who has proved this exact address.
    // Every other case returns null, and looks identical from here.
    await requestSigninLink(email, { store })
  } catch {
    /*
     * The roster could not be read, or the mail driver threw. Neither is
     * something to report differently: saying "we could not look you up" would
     * be a different answer for a real address than for an invented one.
     */
    return privateSameOriginRedirect(SENT)
  }

  return privateSameOriginRedirect(SENT)
}
