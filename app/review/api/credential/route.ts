import type { NextRequest } from 'next/server'

import { mintReviewerToken, reviewerCookie } from '@/lib/reviewer-access'
import { privateSameOriginRedirect } from '@/lib/redirect'
import { createPrivateStore } from '@/lib/private-store'
import { allowCredentialAttempt } from '@/lib/rate-limit'
import { activateWithCredential, signinWithCredential } from '@/lib/reviewer-onboarding'
import { readBoundedForm, CREDENTIAL_FORM_LIMIT_BYTES } from '@/lib/request-bounds'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Spending an emailed credential, and only ever by POST.
 *
 * This is the endpoint the confirmation button submits to. It is a POST and not
 * a link for two reasons that both matter: a mail scanner following the link in
 * a message cannot reach it, and the credential travels in the request **body**
 * rather than in a URL, so it is not written into any log that records paths.
 *
 * Nothing distinguishable is returned. A forged credential, an expired one, one
 * already used, one whose reviewer has since been revoked, one sent to an
 * address that has since changed, and one Mike has explicitly invalidated all
 * redirect to the same page with the same generic message. The server knows
 * which it was -- and records the ones that were spent before being refused, so
 * Mike can see them -- but the visitor does not.
 *
 * On success this mints **the existing reviewer session** — the same
 * `mintReviewerToken` and the same `mrj_reviewer` cookie that an access code
 * has always produced, with the same HttpOnly, SameSite=Lax, `/review`-scoped,
 * Secure-in-production attributes and the same one-year life. No second session
 * mechanism was invented, so nothing about revocation, code rotation or the
 * request boundary had to change to accommodate this.
 */

function failure(purpose: 'activation' | 'signin') {
  return privateSameOriginRedirect(
    purpose === 'signin' ? '/review/signin/verify?error=1' : '/review/activate?error=1',
  )
}

export async function POST(request: NextRequest) {
  /*
   * Bounded and typed before parsing, and before the store, the limiter or a
   * session mint is reached. The refusal is `activation` because the purpose
   * field lives in the body that was just refused -- there is nothing to read
   * it from, and guessing would leak which of the two pages a caller was
   * probing. It is the same answer an unreadable body already got.
   */
  const bounded = await readBoundedForm(request, CREDENTIAL_FORM_LIMIT_BYTES)
  if (!bounded.ok) return failure('activation')
  const form = bounded.value

  const rawPurpose = form.get('purpose')
  const purpose: 'activation' | 'signin' = rawPurpose === 'signin' ? 'signin' : 'activation'

  const token = form.get('token')
  if (typeof token !== 'string' || token.trim() === '') return failure(purpose)

  const store = (() => {
    try {
      return createPrivateStore()
    } catch {
      return null
    }
  })()
  if (!store) return failure(purpose)

  /*
   * Throttled when the limiter can be relied on, and deliberately *not*
   * fail-closed when it cannot. `/review/api/unlock` now applies exactly the
   * same policy through exactly the same function -- see
   * `allowCredentialAttempt` for why this endpoint fails open where the two
   * mail-sending ones fail closed.
   */
  if (!(await allowCredentialAttempt(request.headers, store))) return failure(purpose)

  let outcome
  try {
    outcome =
      purpose === 'signin'
        ? await signinWithCredential(token.trim(), { store })
        : await activateWithCredential(token.trim(), { store })
  } catch {
    return failure(purpose)
  }

  if (!outcome.ok) return failure(purpose)

  const session = await mintReviewerToken(outcome.reviewer)
  if (!session) return failure(purpose)

  const response = privateSameOriginRedirect('/review')
  response.cookies.set(reviewerCookie(session))
  return response
}
