import type { Metadata } from 'next'

import CredentialForm from '../CredentialForm'
import GateShell from '../GateShell'
import '../login/login.css'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Open your reading',
  description: 'Finish opening your advance reading.',
  keywords: null,
  openGraph: {
    title: 'Open your reading',
    description: 'Finish opening your advance reading.',
    siteName: 'Mike Ramsey Jr',
    type: 'website',
  },
  twitter: { card: 'summary', title: 'Open your reading' },
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
 * Where an activation link lands.
 *
 * The server renders this page knowing nothing: the credential is in the URL
 * fragment, which never reaches it. So there is no branch here that depends on
 * whether the link is good, and nothing on this page can disclose whether a
 * particular credential exists.
 *
 * The one failure message is deliberately single and vague. An expired link, a
 * link already used, a link that was replaced by a newer one and a string
 * somebody invented all produce the same sentence — telling them apart would
 * map the door for whoever was trying it.
 */
export default function ActivatePage({ searchParams }: { searchParams: SearchParams }) {
  const failed = first(searchParams, 'error') !== null

  return (
    <GateShell eyebrow="Private reading entrance" heading="Open your reading">
      {failed ? (
        <p className="rv-alert" role="alert">
          That link didn&rsquo;t work. It may have been used already, or it may have expired.
        </p>
      ) : null}

      <p className="rv-gate-intro">
        One more tap and this device is signed in. Your reading, your place in the book and
        anything you mark will be kept to your account, on every device you sign in on.
      </p>

      <CredentialForm
        purpose="activation"
        fragmentKey="a"
        submitLabel="Open my reading"
        pasteLabel="One-time code from your email"
        pasteHelp="Paste the code Mike's email printed beneath the button."
      />

      <p className="rv-fine">
        The link and the code each work once. Advance reading is by invitation — please keep it,
        and anything you read, to yourself.
      </p>

      <p className="rv-fine rv-gate-help">
        Expired or already used?{' '}
        <a href="mailto:mike@mikeramseyjr.com?subject=Reviewer%20access">Write to Mike</a> and he
        will send a new one. Have an access code instead?{' '}
        <a href="/review/login">Enter it here</a>.
      </p>
    </GateShell>
  )
}
