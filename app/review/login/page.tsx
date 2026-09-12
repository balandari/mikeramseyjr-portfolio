import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import AuthorMark from '@/components/site/AuthorMark'
import { REVIEWER_COOKIE_NAME } from '@/lib/reviewer-access'
import { authorizeReviewer } from '@/lib/reviewer-authorization'
import { safeReviewPath } from '../safe-path'
import CodeField from './CodeField'
import './login.css'

export const dynamic = 'force-dynamic'

/*
 * Every metadata field the root layout sets is overridden here with something
 * that names no title. The root layout's description, keywords and share text
 * all mention the current book -- correct for the public site, and inherited by
 * default by every route under it, including this one. An unauthenticated
 * visitor must learn nothing from the gate's `<head>` that they cannot learn
 * from its body. The rendered-page smoke test scans the whole document for it.
 */
export const metadata: Metadata = {
  title: 'Advance reading',
  description: 'A private edition for invited readers.',
  keywords: null,
  openGraph: {
    title: 'Advance reading',
    description: 'A private edition for invited readers.',
    siteName: 'Mike Ramsey Jr',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Advance reading',
    description: 'A private edition for invited readers.',
  },
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
 * the public site's ground -- paper, or ink under a dark scheme -- rather than
 * the reader's own theme. Set before first paint, the same way the reader's
 * layout sets `data-rv`.
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

  /*
   * A roster that cannot be read must not take the gate down with it. Every
   * other surface lets a store failure propagate, because refusing to answer is
   * right when the answer would be a guess -- but this page is the one an
   * unauthenticated visitor is sent to, and a 500 here would mean nobody could
   * even see the sign-in form. So a failure is treated as "not signed in",
   * which shows the form; a submission then meets `isReviewerAccessLive()` and
   * is told plainly that advance reading is unavailable.
   */
  let reviewer = null
  try {
    reviewer = await authorizeReviewer(store.get(REVIEWER_COOKIE_NAME)?.value)
  } catch {
    reviewer = null
  }

  const next = safeReviewPath(first(searchParams, 'next'))

  // Someone who is already signed in has no business on the gate.
  if (reviewer) redirect(next)

  const error = first(searchParams, 'error')
  const signedOut = first(searchParams, 'signedout') === '1'

  return (
    <div className="rv-root rv-root--gate">
      <script dangerouslySetInnerHTML={{ __html: GATE_BOOTSTRAP }} />

      <div className="rv-gate">
        <div className="rv-gate-top">
          {/*
            * The simplified mark, in place of the purple `MR` tile this page
            * used to open with. That tile was a stand-in from before there was
            * a mark; the accent it borrowed is the reader's own "something of
            * yours" colour, which means a highlight or a saved place — it never
            * meant Mike. The reader keeps that accent everywhere it does mean
            * that. Identity is this mark's job now.
            */}
          <a href="/" className="rv-gate-wordmark">
            <AuthorMark size={28} className="rv-gate-mark" />
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
            {/*
              * A reviewer code is sixteen characters in four groups of four
              * (`npm run reviewer:code`), and the field now groups what is
              * typed or pasted into it so a reviewer can check it against the
              * message it came in. Presentation only: `maxLength` is unchanged,
              * the field still accepts a code typed with dashes, without them,
              * or in lower case, and the server normalises and compares exactly
              * as it did before. With JavaScript unavailable this is an
              * ordinary text input in an ordinary form.
              */}
            <CodeField
              id="rv-code"
              name="code"
              className="rv-code"
              maxLength={64}
              placeholder="••••-••••-••••-••••"
              describedBy="rv-code-help"
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
