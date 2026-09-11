'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The reviewer dashboard's interactive half.
 *
 * It holds no authority of its own. Every action here is one POST to
 * `/admin/api/reviewers`, which re-verifies the administrator session and the
 * CSRF token before it does anything, and every response carries the whole
 * roster back so this component never has to guess what the server now
 * believes. If this file were replaced wholesale by an attacker's version, it
 * could not do anything the endpoint would not already allow.
 *
 * The one piece of genuinely sensitive data it ever touches is a freshly issued
 * access code, which arrives in a response, is shown once behind an explicit
 * confirmation, and is dropped from state the moment that confirmation is
 * given. It is never written to storage, never put in a URL, and never logged.
 */

export type AdminReviewer = {
  id: string
  name: string
  email: string
  books: string[]
  status: 'active' | 'revoked'
  createdAt: string
  codeUpdatedAt: string
  lastAccessAt: string | null
}

export type AdminAuditEvent = {
  id: string
  at: string
  actor: string
  action: string
  reviewerId: string
  detail: string
}

export type AdminViewData = {
  driver: string
  writable: boolean
  updatedAt: string
  books: string[]
  reviewers: AdminReviewer[]
  audit: AdminAuditEvent[]
}

type IssuedCode = { reviewerId: string; name: string; code: string }

/** Absolute, and explicit about never having been recorded to the second. */
function when(value: string | null): string {
  if (!value) return 'never'
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return 'unknown'
  return new Date(parsed).toLocaleString()
}

export default function Dashboard({
  initial,
  csrf,
  adminEmail,
}: {
  initial: AdminViewData
  csrf: string
  adminEmail: string
}) {
  const [view, setView] = useState<AdminViewData>(initial)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [issued, setIssued] = useState<IssuedCode | null>(null)

  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newBooks, setNewBooks] = useState<string[]>([])
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  /**
   * One place every mutation goes through.
   *
   * `busy` is a key rather than a boolean so that only the control that was
   * pressed shows itself working -- a phone with every button greyed out at
   * once reads as a broken page.
   */
  const send = useCallback(
    async (key: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
      setBusy(key)
      setError(null)
      try {
        const response = await fetch('/admin/api/reviewers', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ ...body, csrf }),
        })

        const payload = (await response.json().catch(() => null)) as Record<
          string,
          unknown
        > | null

        if (!response.ok || !payload?.ok) {
          const message =
            typeof payload?.error === 'string' && payload.error !== 'not_authorized'
              ? payload.error
              : response.status === 401
                ? 'Your session has ended. Reload the page and sign in again.'
                : 'That could not be saved. Nothing was changed.'
          setError(message)
          return null
        }

        if (payload.view) setView(payload.view as AdminViewData)
        return payload
      } catch {
        setError('That could not be saved — you may be offline. Nothing was changed.')
        return null
      } finally {
        setBusy(null)
      }
    },
    [csrf],
  )

  const addReviewer = useCallback(async () => {
    const result = await send('create', {
      action: 'create',
      name: newName,
      email: newEmail,
      books: newBooks,
    })
    if (!result) return
    setNewName('')
    setNewEmail('')
    setNewBooks([])
    if (result.issued) setIssued(result.issued as IssuedCode)
  }, [send, newName, newEmail, newBooks])

  const replaceCode = useCallback(
    async (reviewerId: string) => {
      const result = await send(`code:${reviewerId}`, { action: 'replace-code', reviewerId })
      if (result?.issued) setIssued(result.issued as IssuedCode)
    },
    [send],
  )

  const toggleBook = useCallback(
    async (reviewer: AdminReviewer, slug: string, checked: boolean) => {
      const books = checked
        ? [...reviewer.books, slug]
        : reviewer.books.filter((entry) => entry !== slug)
      await send(`books:${reviewer.id}`, {
        action: 'set-entitlements',
        reviewerId: reviewer.id,
        books,
      })
    },
    [send],
  )

  const readOnly = !view.writable

  return (
    <div className="ad-root">
      <header className="ad-bar">
        <span className="ad-bar-title">Reviewers</span>
        <span className="ad-who" title={adminEmail}>
          {adminEmail}
        </span>
        <form action="/admin/api/auth/signout" method="post">
          <button type="submit" className="ad-btn ad-btn--small">
            Sign out
          </button>
        </form>
      </header>

      <div className="ad-shell">
        {readOnly ? (
          <p className="ad-note ad-note--bad" role="alert">
            The roster is being served by the read-only <b>{view.driver}</b> driver, so it
            cannot be edited here. Set <b>REVIEWER_ROSTER_DRIVER</b> to a writable driver to
            manage reviewers without redeploying.
          </p>
        ) : null}

        {error ? (
          <p className="ad-note ad-note--bad" role="alert">
            {error}
          </p>
        ) : null}

        {/* ------------------------------------------------------- roster */}

        <section className="ad-section" aria-labelledby="ad-roster">
          <h2 className="ad-section-title" id="ad-roster">
            {view.reviewers.length === 0
              ? 'Nobody yet'
              : `${view.reviewers.length} ${view.reviewers.length === 1 ? 'reviewer' : 'reviewers'}`}
          </h2>
          <p className="ad-hint">
            Changes take effect immediately — revoking somebody, or issuing a new code, ends
            their open sessions on the next request.
          </p>

          {view.reviewers.map((reviewer) => (
            <article
              key={reviewer.id}
              className={`ad-card${reviewer.status === 'revoked' ? ' ad-card--revoked' : ''}`}
            >
              <div className="ad-card-head">
                <h3 className="ad-name">{reviewer.name}</h3>
                <span
                  className={`ad-pill ${
                    reviewer.status === 'active' ? 'ad-pill--active' : 'ad-pill--revoked'
                  }`}
                >
                  {reviewer.status}
                </span>
              </div>

              <p className="ad-email">{reviewer.email || <em>no address recorded</em>}</p>

              <div className="ad-meta">
                <span>
                  <b>Added</b> {when(reviewer.createdAt)}
                </span>
                <span>
                  <b>Last opened</b> {when(reviewer.lastAccessAt)}
                </span>
                <span>
                  <b>Code issued</b> {when(reviewer.codeUpdatedAt)}
                </span>
                <span>
                  <b>Identifier</b> {reviewer.id}
                </span>
              </div>

              {renaming === reviewer.id ? (
                <div className="ad-field">
                  <label className="ad-label" htmlFor={`rename-${reviewer.id}`}>
                    Name
                  </label>
                  <input
                    id={`rename-${reviewer.id}`}
                    className="ad-input"
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    autoComplete="off"
                  />
                  <div className="ad-btn-row">
                    <button
                      type="button"
                      className="ad-btn ad-btn--primary ad-btn--small"
                      disabled={busy !== null || renameValue.trim().length === 0}
                      onClick={async () => {
                        const ok = await send(`rename:${reviewer.id}`, {
                          action: 'rename',
                          reviewerId: reviewer.id,
                          name: renameValue,
                        })
                        if (ok) setRenaming(null)
                      }}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="ad-btn ad-btn--small"
                      onClick={() => setRenaming(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}

              <fieldset className="ad-fieldset" disabled={readOnly || busy !== null}>
                <legend className="ad-label ad-legend">Can read</legend>
                <div className="ad-books">
                  {view.books.map((slug) => (
                    <label className="ad-book" key={slug}>
                      <input
                        type="checkbox"
                        checked={reviewer.books.includes(slug)}
                        onChange={(event) =>
                          void toggleBook(reviewer, slug, event.target.checked)
                        }
                      />
                      <span>{slug}</span>
                    </label>
                  ))}
                  {view.books.length === 0 ? (
                    <p className="ad-hint">This deployment has no manuscripts to share.</p>
                  ) : null}
                </div>
              </fieldset>

              <div className="ad-btn-row">
                <button
                  type="button"
                  className="ad-btn ad-btn--small"
                  disabled={readOnly || busy !== null}
                  onClick={() => void replaceCode(reviewer.id)}
                >
                  {busy === `code:${reviewer.id}` ? 'Issuing…' : 'New code'}
                </button>

                <button
                  type="button"
                  className="ad-btn ad-btn--small"
                  disabled={readOnly || busy !== null}
                  onClick={() => {
                    setRenaming(reviewer.id)
                    setRenameValue(reviewer.name)
                  }}
                >
                  Rename
                </button>

                {reviewer.status === 'active' ? (
                  <button
                    type="button"
                    className="ad-btn ad-btn--small ad-btn--danger"
                    disabled={readOnly || busy !== null}
                    onClick={() =>
                      void send(`revoke:${reviewer.id}`, {
                        action: 'revoke',
                        reviewerId: reviewer.id,
                      })
                    }
                  >
                    {busy === `revoke:${reviewer.id}` ? 'Revoking…' : 'Revoke'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ad-btn ad-btn--small"
                    disabled={readOnly || busy !== null}
                    onClick={() =>
                      void send(`restore:${reviewer.id}`, {
                        action: 'restore',
                        reviewerId: reviewer.id,
                      })
                    }
                  >
                    Restore
                  </button>
                )}
              </div>

              {reviewer.status === 'revoked' ? (
                <p className="ad-hint">
                  Restoring makes their previous code work again. If the code itself may have
                  reached somebody else, use <b>New code</b> instead.
                </p>
              ) : null}
            </article>
          ))}
        </section>

        {/* ---------------------------------------------------------- add */}

        <section className="ad-section" aria-labelledby="ad-add">
          <h2 className="ad-section-title" id="ad-add">
            Add a reviewer
          </h2>
          <p className="ad-hint">
            A code is generated when you add them and shown once. Send it yourself — nothing
            is emailed from here.
          </p>

          <div className="ad-card">
            <fieldset className="ad-fieldset" disabled={readOnly || busy !== null}>
              <div className="ad-field">
                <label className="ad-label" htmlFor="ad-new-name">
                  Name
                </label>
                <input
                  id="ad-new-name"
                  className="ad-input"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="Anna Vasquez"
                  autoComplete="off"
                  enterKeyHint="next"
                />
              </div>

              <div className="ad-field">
                <label className="ad-label" htmlFor="ad-new-email">
                  Email
                </label>
                <input
                  id="ad-new-email"
                  className="ad-input"
                  type="email"
                  inputMode="email"
                  value={newEmail}
                  onChange={(event) => setNewEmail(event.target.value)}
                  placeholder="anna@example.com"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="done"
                />
                <p className="ad-hint">
                  For your records only. Reviewers sign in with their code, never with this.
                </p>
              </div>

              <fieldset className="ad-fieldset">
                <legend className="ad-label ad-legend">Can read</legend>
                <div className="ad-books">
                  {view.books.map((slug) => (
                    <label className="ad-book" key={slug}>
                      <input
                        type="checkbox"
                        checked={newBooks.includes(slug)}
                        onChange={(event) =>
                          setNewBooks((current) =>
                            event.target.checked
                              ? [...current, slug]
                              : current.filter((entry) => entry !== slug),
                          )
                        }
                      />
                      <span>{slug}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="ad-btn-row">
                <button
                  type="button"
                  className="ad-btn ad-btn--primary"
                  disabled={
                    readOnly ||
                    busy !== null ||
                    newName.trim().length === 0 ||
                    newEmail.trim().length === 0
                  }
                  onClick={() => void addReviewer()}
                >
                  {busy === 'create' ? 'Adding…' : 'Add and issue a code'}
                </button>
              </div>
            </fieldset>
          </div>
        </section>

        {/* -------------------------------------------------------- audit */}

        <section className="ad-section" aria-labelledby="ad-audit-title">
          <h2 className="ad-section-title" id="ad-audit-title">
            History
          </h2>
          <p className="ad-hint">What changed, when, and who. Codes never appear here.</p>

          {view.audit.length === 0 ? (
            <p className="ad-hint">Nothing has been changed yet.</p>
          ) : (
            <div className="ad-audit">
              {view.audit.map((event) => (
                <p className="ad-audit-row" key={event.id}>
                  <span className="ad-audit-when">
                    {when(event.at)} · {event.actor}
                  </span>
                  {event.detail}
                </p>
              ))}
            </div>
          )}
        </section>
      </div>

      {issued ? <CodeSheet issued={issued} onConfirm={() => setIssued(null)} /> : null}
    </div>
  )
}

/**
 * The one-time display of a newly issued access code.
 *
 * Deliberately hard to dismiss by accident: there is no click-away on the
 * scrim, because this is the only moment the code exists anywhere and a stray
 * tap would cost it. Escape still closes it, because a modal that traps the
 * keyboard is worse -- and somebody who pressed Escape meant to.
 */
function CodeSheet({ issued, onConfirm }: { issued: IssuedCode; onConfirm: () => void }) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle')
  const panelRef = useRef<HTMLDivElement | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    returnFocusRef.current = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // The confirm button, not the copy button: the keyboard should land on the
    // way out, so Enter never re-copies by accident.
    confirmRef.current?.focus()

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onConfirm()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return

      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>('button, [href], input'),
      ).filter((element) => !element.hasAttribute('disabled'))
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      returnFocusRef.current?.focus?.()
    }
  }, [onConfirm])

  return (
    <>
      <div className="ad-scrim" aria-hidden="true" />
      <div
        className="ad-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ad-code-title"
        ref={panelRef}
      >
        <h2 className="ad-section-title" id="ad-code-title">
          {issued.name}&rsquo;s access code
        </h2>

        <p className="ad-hint">
          This is the only time it will be shown. It is not stored anywhere and cannot be
          recovered — if it is lost, issue a new one.
        </p>

        <p className="ad-code">{issued.code}</p>

        <div className="ad-btn-row">
          <button
            type="button"
            className="ad-btn"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(issued.code)
                setCopied('ok')
              } catch {
                // Clipboard access needs a secure context and a permission the
                // browser may simply refuse. The code is selectable, so say so
                // rather than pretending it worked.
                setCopied('failed')
              }
            }}
          >
            Copy
          </button>

          <button
            type="button"
            className="ad-btn ad-btn--primary"
            ref={confirmRef}
            onClick={onConfirm}
          >
            I have copied it
          </button>
        </div>

        <p className="ad-hint" role="status">
          {copied === 'ok'
            ? 'Copied to the clipboard. Send it to them directly — do not put it in a ticket or a note.'
            : copied === 'failed'
              ? 'This browser would not let the page copy for you. Select the code above and copy it yourself.'
              : 'Send it to them directly. Nothing is emailed from here.'}
        </p>
      </div>
    </>
  )
}
