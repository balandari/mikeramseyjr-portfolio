import type { Metadata } from 'next'

import GateShell from '../GateShell'
import '../login/login.css'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Email me a sign-in link',
  description: 'Sign in to your advance reading on another device.',
  keywords: null,
  openGraph: {
    title: 'Email me a sign-in link',
    description: 'Sign in to your advance reading on another device.',
    siteName: 'Mike Ramsey Jr',
    type: 'website',
  },
  twitter: { card: 'summary', title: 'Email me a sign-in link' },
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
 * Signing in again, on a device that has never been signed in.
 *
 * This is what replaces "write to Mike for another code". A reviewer who has
 * once opened their account by email can open it again anywhere, and Mike is
 * not in the loop at all.
 *
 * **The answer is the same whatever is typed.** An address that belongs to an
 * active reviewer, one that belongs to a revoked reviewer, one that belongs to
 * somebody who has never proved their address, and one that belongs to nobody
 * at all all produce the confirmation below. There is no version of this page
 * that can be used to find out who reads for Mike.
 */
export default function SigninPage({ searchParams }: { searchParams: SearchParams }) {
  const sent = first(searchParams, 'sent') === '1'
  const error = first(searchParams, 'error')
  const openedAt = Date.now()

  return (
    <GateShell eyebrow="Private reading entrance" heading="Email me a sign-in link">
      {sent ? (
        <>
          <p className="rv-gate-intro" role="status">
            If that address has advance reading, a sign-in link is on its way to it. Open the email
            on this device and press the button in it.
          </p>
          <p className="rv-fine">
            The link works once and expires in about fifteen minutes. If one doesn&rsquo;t arrive,
            check the address and try again.
          </p>
          <p className="rv-fine rv-gate-help">
            Have an access code instead? <a href="/review/login">Enter it here</a>.
          </p>
        </>
      ) : (
        <>
          <p className="rv-gate-intro">
            Reading on a new phone or computer? Give the address Mike has for you and
            he&rsquo;ll&nbsp;— well, his site will — send you a link that signs this device in.
          </p>

          {error === 'unavailable' ? (
            <p className="rv-alert" role="alert">
              Sign-in links are not available right now. Please try again later.
            </p>
          ) : null}

          {error === '1' ? (
            <p className="rv-alert" role="alert">
              That does not look like an email address. Check it and try again.
            </p>
          ) : null}

          <form action="/review/api/signin" method="post">
            <input type="hidden" name="openedAt" value={String(openedAt)} />

            <div className="rv-trap" aria-hidden="true">
              <label htmlFor="si-website">Website</label>
              <input id="si-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
            </div>

            <div className="rv-field">
              <label htmlFor="si-email">Email address</label>
              <input
                id="si-email"
                name="email"
                type="email"
                className="rv-text"
                maxLength={254}
                autoComplete="email"
                inputMode="email"
                required
              />
            </div>

            <button type="submit" className="rv-btn rv-btn--primary rv-btn--wide">
              Email me a sign-in link
            </button>
          </form>

          <p className="rv-fine">
            This works only for an address that has already opened its reading from one of
            Mike&rsquo;s emails. It never creates an account, and it never tells you whether an
            address has one.
          </p>

          <p className="rv-fine rv-gate-help">
            Have an access code? <a href="/review/login">Enter it here</a>. Never been invited?{' '}
            <a href="/review/request">Request reviewer access</a>.
          </p>
        </>
      )}
    </GateShell>
  )
}
