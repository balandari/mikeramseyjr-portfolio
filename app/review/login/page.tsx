import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { REVIEWER_COOKIE_NAME, verifyReviewerToken } from '@/lib/reviewer-access'
import { safeReviewPath } from '../safe-path'
import './login.css'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Advance reading',
  robots: { index: false, follow: false, noarchive: true, nocache: true },
}

type SearchParams = Record<string, string | string[] | undefined>

function first(params: SearchParams, key: string): string | null {
  const value = params[key]
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0] ?? null
  return null
}

/**
 * Marks the document as the gate so the gate stylesheet can repaint `body` in
 * the public site's ink rather than the reader's paper. Set before first paint,
 * the same way the reader's own layout sets `data-rv`.
 */
const GATE_BOOTSTRAP = `(function(){try{
document.documentElement.setAttribute('data-rv-gate','');
}catch(e){}})();`

/**
 * The reviewer gate.
 *
 * One field, one code, submitted as a form POST so the code never appears in a
 * URL, a referrer, a server access log or the browser's history. The failure
 * message is deliberately the same for an unknown code, a revoked reviewer and
 * a code belonging to someone who has been re-issued: telling them apart would
 * let an unauthenticated visitor map which codes exist.
 *
 * It is also the only page of the private area a visitor can reach without a
 * code, so it is dressed as what it is -- the quiet side entrance to Mike
 * Ramsey Jr's advance-reading room, in the same type and the same palette as
 * the public site, with a way back to it. Nothing about the mechanism changed
 * when that happened: same action, same field, same validation, same cookie,
 * same one-year authorization, same boundaries.
 *
 * Nothing here names a title. Somebody who has not signed in learns that
 * advance reading exists and is by invitation, and nothing else -- not what is
 * being read, not how many titles there are, not who else has a code.
 */
export default async function ReviewLoginPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const store = await cookies()
  const reviewer = await verifyReviewerToken(store.get(REVIEWER_COOKIE_NAME)?.value)

  const next = safeReviewPath(first(searchParams, 'next'))

  // Someone who is already signed in has no business on the gate.
  if (reviewer) redirect(next)

  const error = first(searchParams, 'error')
  const signedOut = first(searchParams, 'signedout') === '1'

  return (
    <div className="rv-root rv-root--gate">
      <script dangerouslySetInnerHTML={{ __html: GATE_BOOTSTRAP }} />

      <div className="rv-gate">
        <div className="rv-gate-grain" aria-hidden="true" />

        <div className="rv-gate-top">
          <a href="/" className="rv-gate-wordmark">
            Mike Ramsey Jr
          </a>
        </div>

        <div className="rv-gate-panel">
          <p className="rv-gate-eyebrow">By invitation</p>

          <h1>Advance reading</h1>

          <hr className="rv-gate-rule" />

          <p className="rv-gate-intro">
            A private edition for invited readers. Enter the access code you were
            sent to open the titles shared with you.
          </p>

          {error === 'unavailable' ? (
            <p className="rv-alert" role="alert">
              Advance reading is not available right now. Please try again later.
            </p>
          ) : null}

          {error === '1' ? (
            <p className="rv-alert" role="alert">
              That code was not recognised. Check it and try again.
            </p>
          ) : null}

          {signedOut ? (
            <p className="rv-alert rv-alert--calm" role="status">
              You have been signed out on this device.
            </p>
          ) : null}

          <form action="/review/api/unlock" method="post">
            <input type="hidden" name="next" value={next} />
            <label htmlFor="rv-code">Access code</label>
            <input
              id="rv-code"
              name="code"
              className="rv-code"
              type="text"
              required
              maxLength={64}
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              /*
               * A reviewer code is sixteen characters in four groups of four
               * (`npm run reviewer:code`). The placeholder used to show two
               * groups, which understated the code a reader was holding. It
               * now shows the real shape. Presentation only -- `maxLength` is
               * unchanged at 64, and the field still accepts whatever the
               * unlock endpoint is willing to normalise.
               */
              placeholder="••••-••••-••••-••••"
              aria-describedby="rv-code-help"
            />
            <button type="submit" className="rv-btn rv-btn--primary rv-btn--wide">
              Open my reading
            </button>
          </form>

          <p className="rv-fine" id="rv-code-help">
            Your code is personal to you. This device will stay signed in for about
            a year, so you should only need to enter it once. Please do not share
            the code or anything you read here.
          </p>
        </div>

        <div className="rv-gate-foot">
          <a href="/" className="rv-gate-back">
            <span aria-hidden="true">&larr;</span>
            Back to mikeramseyjr.com
          </a>
        </div>
      </div>
    </div>
  )
}
