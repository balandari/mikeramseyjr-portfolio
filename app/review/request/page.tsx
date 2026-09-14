import type { Metadata } from 'next'

import GateShell from '../GateShell'
import { MAX_MESSAGE_LENGTH, MAX_NAME_LENGTH } from '@/lib/reviewer-requests'
import '../login/login.css'

export const dynamic = 'force-dynamic'

/*
 * The same `<head>` discipline the gate keeps. An unauthenticated visitor must
 * learn nothing here they could not learn from the page itself -- not the book,
 * not how many there are, not who else is reading it.
 */
export const metadata: Metadata = {
  title: 'Request reviewer access',
  description: 'Ask Mike Ramsey Jr for access to his advance reading.',
  keywords: null,
  openGraph: {
    title: 'Request reviewer access',
    description: 'Ask Mike Ramsey Jr for access to his advance reading.',
    siteName: 'Mike Ramsey Jr',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Request reviewer access',
    description: 'Ask Mike Ramsey Jr for access to his advance reading.',
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
 * Asking for access.
 *
 * Three fields, and each one earns its place: a name, so Mike knows whether he
 * knows you; an address, because it is the only way he can answer; and a few
 * sentences, because for somebody he has never met that is the only thing he
 * has to go on. Nothing else is asked — no phone number, no company, no "how
 * did you hear about this", and no account of any kind is created by sending
 * this.
 *
 * **Every submission is answered with the same words.** A new address, an
 * address that already wrote last week, an address that already belongs to a
 * reviewer, and an address that was revoked all produce the confirmation below.
 * That is not vagueness for its own sake: a form that answered them differently
 * would let anybody test whether a particular person reads for Mike.
 */
export default function RequestAccessPage({ searchParams }: { searchParams: SearchParams }) {
  const sent = first(searchParams, 'sent') === '1'
  const error = first(searchParams, 'error')

  // Rendered fresh on every request, and compared on submission. A form filled
  // in and posted within a moment was not filled in by a person.
  const openedAt = Date.now()

  return (
    <GateShell eyebrow="Private reading entrance" heading="Request reviewer access">
      {sent ? (
        <>
          <p className="rv-gate-intro" role="status">
            Thank you — your request has been saved and Mike has been told about it. If he opens
            the reading to you, you&rsquo;ll get an email with a link that signs you in.
          </p>
          <p className="rv-fine">
            He reads these himself, so it may take a few days. There is nothing else you need to
            do, and no account has been created for you yet.
          </p>
          <p className="rv-fine rv-gate-help">
            Already have a code? <a href="/review/login">Enter it here</a>.
          </p>
        </>
      ) : (
        <>
          <p className="rv-gate-intro">
            Mike shares his unfinished work with a small number of readers. Tell him who you are
            and why you&rsquo;d like to read, and he&rsquo;ll decide himself.
          </p>

          {error === 'unavailable' ? (
            <p className="rv-alert" role="alert">
              Requests are not available right now. Please try again later.
            </p>
          ) : null}

          {error === '1' ? (
            <p className="rv-alert" role="alert">
              Please check the form: a name, an email address you can receive mail at, and a short
              message are all needed.
            </p>
          ) : null}

          <form action="/review/api/request" method="post">
            <input type="hidden" name="openedAt" value={String(openedAt)} />

            {/*
              * Not a field. It is off-screen, unlabelled to a person, and
              * `tabIndex={-1}` and `autoComplete="off"` keep a browser and a
              * password manager away from it. Anything that fills it in is not
              * a reader, and is answered exactly as a reader is.
              */}
            <div className="rv-trap" aria-hidden="true">
              <label htmlFor="rq-website">Website</label>
              <input id="rq-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
            </div>

            <div className="rv-field">
              <label htmlFor="rq-name">Your name</label>
              <input
                id="rq-name"
                name="name"
                type="text"
                className="rv-text"
                maxLength={MAX_NAME_LENGTH}
                autoComplete="name"
                required
              />
            </div>

            <div className="rv-field">
              <label htmlFor="rq-email">Email address</label>
              <input
                id="rq-email"
                name="email"
                type="email"
                className="rv-text"
                maxLength={254}
                autoComplete="email"
                inputMode="email"
                required
                aria-describedby="rq-email-help"
              />
              <p className="rv-count" id="rq-email-help">
                Mike&rsquo;s answer comes here, and it is how you&rsquo;ll sign in afterwards.
              </p>
            </div>

            <div className="rv-field">
              <label htmlFor="rq-message">Who you are, or why you&rsquo;d like to read</label>
              <textarea
                id="rq-message"
                name="message"
                className="rv-note"
                maxLength={MAX_MESSAGE_LENGTH}
                required
                aria-describedby="rq-message-help"
              />
              <p className="rv-count" id="rq-message-help">
                A few sentences. Up to {MAX_MESSAGE_LENGTH} characters.
              </p>
            </div>

            <button type="submit" className="rv-btn rv-btn--primary rv-btn--wide">
              Send my request
            </button>
          </form>

          <p className="rv-fine">
            Your name, address and message are stored privately so Mike can answer you. They are
            not shared with anybody, not used for any mailing list, and nothing else about you is
            collected.
          </p>

          <p className="rv-fine rv-gate-help">
            Already have a code? <a href="/review/login">Enter it here</a>. Already a reviewer?{' '}
            <a href="/review/signin">Email me a sign-in link</a>.
          </p>
        </>
      )}
    </GateShell>
  )
}
