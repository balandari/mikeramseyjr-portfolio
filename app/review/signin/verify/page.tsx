import type { Metadata } from 'next'

import CredentialForm from '../../CredentialForm'
import GateShell from '../../GateShell'
import '../../login/login.css'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Sign in and read',
  description: 'Finish signing in to your advance reading.',
  keywords: null,
  openGraph: {
    title: 'Sign in and read',
    description: 'Finish signing in to your advance reading.',
    siteName: 'Mike Ramsey Jr',
    type: 'website',
  },
  twitter: { card: 'summary', title: 'Sign in and read' },
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
 * Where a sign-in link lands. The activation page's twin, and for the same
 * reasons: the credential arrives in the fragment, the server renders this
 * knowing nothing, and nothing is spent until somebody presses the button.
 */
export default function SigninVerifyPage({ searchParams }: { searchParams: SearchParams }) {
  const failed = first(searchParams, 'error') !== null

  return (
    <GateShell eyebrow="Private reading entrance" heading="Sign in and read">
      {failed ? (
        <p className="rv-alert" role="alert">
          That link didn&rsquo;t work. It may have been used already, or it may have expired.
        </p>
      ) : null}

      <p className="rv-gate-intro">
        One more tap and this device is signed in, at the place you left off.
      </p>

      <CredentialForm
        purpose="signin"
        fragmentKey="s"
        submitLabel="Sign in and read"
        pasteLabel="One-time code from your email"
        pasteHelp="Paste the code the email printed beneath the button."
      />

      <p className="rv-fine">
        Sign-in links work once and expire quickly, so an old one in your inbox will not open
        anything.
      </p>

      <p className="rv-fine rv-gate-help">
        Need another? <a href="/review/signin">Email me a new link</a>. Have an access code?{' '}
        <a href="/review/login">Enter it here</a>.
      </p>
    </GateShell>
  )
}
