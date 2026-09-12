import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import AuthorMark from '@/components/site/AuthorMark'
import {
  ADMIN_COOKIE_NAME,
  isAdminConfigured,
  safeAdminPath,
  verifyAdminToken,
} from '@/lib/admin-auth'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Sign in',
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
 * The administrator gate.
 *
 * One button. There is no password field here and there never will be: identity
 * comes from Google, and authority comes from an allowlist this page cannot
 * see. Nothing on it names a reviewer, a title, or the address that is allowed
 * in -- somebody who reaches this URL learns that an administration area exists
 * and nothing else.
 *
 * It is also completely separate from the reviewer gate at `/review/login`.
 * The two share no cookie, no secret and no code path; a reviewer's access code
 * is meaningless here, and a Google sign-in is meaningless there.
 */
export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const store = await cookies()
  const session = await verifyAdminToken(store.get(ADMIN_COOKIE_NAME)?.value)

  const next = safeAdminPath(first(searchParams, 'next'))
  if (session) redirect(next)

  const configured = isAdminConfigured()
  const error = first(searchParams, 'error')
  const signedOut = first(searchParams, 'signedout') === '1'

  return (
    <div className="ad-root">
      <div className="ad-gate">
        <div className="ad-gate-panel">
          {/*
           * The simplified mark, replacing the purple `MR` tile the sign-in
           * pages used to open with. Nothing else on this page names the site,
           * so unlike the reviewer gate -- where the wordmark is right beside
           * it -- the mark here carries alt text and says whose door this is.
           */}
          <AuthorMark size={44} className="ad-gate-mark" alt="Mike Ramsey Jr" />

          {/*
           * "Author access", not "Reviewers". This page is the door Mike comes
           * in by, and it was named after one of the things on the other side
           * of it -- which read, to the one person who ever sees it, as though
           * he were about to sign in as a reviewer. It names who it is for.
           * Nothing about what it authorises has changed.
           */}
          <h1>Author access</h1>

          <p className="ad-hint" style={{ marginTop: '0.75rem' }}>
            Your own way in: your reading, and the reviewers you have shared
            with. Sign in with the Google account that owns this site.
          </p>

          {error === 'denied' ? (
            <p className="ad-note ad-note--bad" role="alert">
              That Google account signed in successfully, but it is not an
              administrator of this site. Nothing has been opened.
            </p>
          ) : null}

          {error === 'failed' ? (
            <p className="ad-note ad-note--bad" role="alert">
              That sign-in could not be completed. Please try again.
            </p>
          ) : null}

          {error === 'unconfigured' || !configured ? (
            <p className="ad-note ad-note--bad" role="alert">
              Administration is not configured on this deployment, so there is
              nothing to sign in to.
            </p>
          ) : null}

          {signedOut ? (
            <p className="ad-note" role="status">
              You have been signed out on this device.
            </p>
          ) : null}

          {configured ? (
            <form action="/admin/api/auth/start" method="post" style={{ marginTop: '1.25rem' }}>
              <input type="hidden" name="next" value={next} />
              <button
                type="submit"
                className="ad-btn ad-btn--primary"
                style={{ width: '100%' }}
              >
                Continue with Google
              </button>
            </form>
          ) : null}

          <p className="ad-hint" style={{ marginTop: '1.5rem' }}>
            <a href="/">Back to mikeramseyjr.com</a>
          </p>
        </div>
      </div>
    </div>
  )
}
