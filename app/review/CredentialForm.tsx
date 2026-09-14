'use client'

import { useEffect, useState } from 'react'

/**
 * The confirmation step that stands between an emailed link and a session.
 *
 * Two separate problems are solved here, and both of them are the reason this
 * is a component rather than a plain link that signs you in.
 *
 * **The credential is in the fragment, not the query.** An activation link is
 * `…/review/activate#a=<token>`. Everything after the `#` is never transmitted:
 * it does not reach this site's server, Vercel's runtime logs, an access log,
 * or a `Referer` header. This component reads it in the browser, immediately
 * rewrites the address bar so it is not left in history or on screen, holds it
 * in memory for as long as the page is open, and sends it in the **body** of a
 * POST. A `?token=` would have written the same secret into every log line that
 * records a URL.
 *
 * **Nothing is consumed until a person presses the button.** Mail scanners,
 * link-preview bots and antivirus proxies fetch the URLs in a message. They run
 * no JavaScript and post no forms, so they cannot spend a one-use credential
 * before the reader ever sees it. That is worth one tap.
 *
 * With JavaScript switched off, the fragment cannot be read — so the field for
 * the code printed in the email is what renders, and the journey still
 * finishes. That is why the paste field is the default state rather than a
 * fallback bolted on afterwards.
 */
export default function CredentialForm({
  purpose,
  fragmentKey,
  submitLabel,
  pasteLabel,
  pasteHelp,
}: {
  purpose: 'activation' | 'signin'
  fragmentKey: string
  submitLabel: string
  pasteLabel: string
  pasteHelp: string
}) {
  const [token, setToken] = useState('')
  const [fromLink, setFromLink] = useState(false)

  useEffect(() => {
    let found = ''
    try {
      const hash = window.location.hash.replace(/^#/, '')
      for (const part of hash.split('&')) {
        const [key, value] = part.split('=')
        if (key === fragmentKey && value) found = decodeURIComponent(value)
      }
    } catch {
      found = ''
    }

    if (!found) return

    setToken(found)
    setFromLink(true)

    /*
     * Off the address bar and out of this entry in history, before anything
     * else happens. A reader who hands somebody their phone, or whose browser
     * syncs its history, should not be handing over a working credential.
     */
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    } catch {
      // A browser that refuses is no reason to stop; the token still only
      // travels in the POST body.
    }
  }, [fragmentKey])

  return (
    <form action="/review/api/credential" method="post">
      <input type="hidden" name="purpose" value={purpose} />

      {fromLink ? (
        <input type="hidden" name="token" value={token} />
      ) : (
        <div className="rv-field">
          <label htmlFor="rv-credential">{pasteLabel}</label>
          <input
            id="rv-credential"
            name="token"
            type="text"
            className="rv-text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={64}
            required
            aria-describedby="rv-credential-help"
          />
          <p className="rv-count" id="rv-credential-help">
            {pasteHelp}
          </p>
        </div>
      )}

      <button type="submit" className="rv-btn rv-btn--primary rv-btn--wide">
        {submitLabel}
      </button>
    </form>
  )
}
