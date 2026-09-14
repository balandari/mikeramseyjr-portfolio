'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import AuthorMark from '@/components/site/AuthorMark'
import { submitAdminMutation } from './mutation-transport'

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
  /** When they proved this address by using an emailed link. Null until then. */
  emailVerifiedAt: string | null
  origin: 'admin' | 'request'
}

/**
 * One access request, exactly as the server sees it.
 *
 * There is no credential here and no field one could be put in. What the
 * dashboard knows about an outstanding activation is that it exists and when it
 * expires — never what it is. Mike cannot read out an activation link, copy one,
 * or send one by hand, and that is deliberate: the only way one reaches a
 * person is the mail service sending it to the address on the request.
 */
export type AdminRequest = {
  id: string
  createdAt: string
  name: string
  email: string
  message: string
  status: 'pending' | 'approving' | 'approved' | 'declined'
  reviewerId: string | null
  books: string[]
  decidedAt: string | null
  decidedBy: string | null
  activation: {
    /** The credential's keyed fingerprint. Never the credential itself. */
    tokenHash: string | null
    operationId: string | null
    expiresAt: string | null
    usedAt: string | null
  } | null
  delivery: {
    kind: 'author-alert' | 'activation' | 'signin' | 'signin'
    at: string
    status:
      | 'accepted'
      | 'refused'
      | 'uncertain'
      | 'unreachable'
      | 'not-configured'
    providerId: string | null
    error: string | null
  } | null
  alertedAt: string | null
  activationOutstanding: boolean
  /** What the roster says about this request's reviewer, right now. */
  reviewerStatus: 'absent' | 'active' | 'revoked'
  /** Whether that reviewer has proved their address. Decides the email purpose. */
  reviewerVerified: boolean
  /** An unfinished approval whose reviewer was revoked after it stopped. */
  approvalBlockedByRevocation: boolean
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

/** What the mail service actually told us, in Mike's words rather than HTTP's. */
function deliverySentence(delivery: AdminRequest['delivery']): string | null {
  if (!delivery) return null
  if (delivery.kind !== 'activation' && delivery.kind !== 'signin') return null
  if (delivery.status === 'accepted') return null
  if (delivery.status === 'not-configured') {
    return 'No mail service is configured here, so nothing was sent.'
  }
  if (delivery.status === 'refused') return 'The mail service refused that address.'
  if (delivery.status === 'uncertain') {
    /*
     * The honest sentence, and the hardest one to write. The service was
     * reached and may well have taken the message; there is no way from here to
     * find out. The link that was minted is still live, so the right advice is
     * to wait a little and only then replace it -- replacing it kills whatever
     * did arrive.
     */
    return (
      'The mail service may or may not have taken that message — there is no way to tell ' +
      'from here. The link that was made is still live, so if it arrives it will work. ' +
      'If nothing arrives, send a new access email; the first one keeps working too, so ' +
      'nothing is lost either way.'
    )
  }
  return 'The mail service did not answer. Nothing is known to have been sent.'
}

export default function Dashboard({
  initial,
  csrf,
  adminEmail,
  requests: initialRequests,
  requestsReadable,
}: {
  initial: AdminViewData
  csrf: string
  adminEmail: string
  requests: AdminRequest[]
  requestsReadable: boolean
}) {
  const [view, setView] = useState<AdminViewData>(initial)
  const [requests, setRequests] = useState<AdminRequest[]>(initialRequests)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * "The answer never came back, so this may have happened."
   *
   * The third outcome, kept apart from `error` because it is the opposite kind
   * of statement. `error` is something the server said about itself. This is
   * the absence of anything the server said -- a dropped connection, an
   * unreadable body, an invocation terminated after the write landed -- and the
   * page used to flatten it into "Nothing was changed", which is a claim it is
   * in no position to make. Retrying on that claim is how a second access code
   * overwrites a first one nobody ever saw.
   */
  const [unresolved, setUnresolved] = useState<string | null>(null)
  /**
   * "It happened; the page beside it is stale."
   *
   * Kept apart from `error`, because the two say opposite things about whether
   * the change landed. The server now distinguishes them -- a committed
   * mutation whose dashboard reread failed or ran out of time answers
   * `ok: true` with `refreshed: false` -- and the page must not flatten that
   * back into a failure, which is exactly what "Nothing was changed" used to do
   * to a successful one.
   */
  const [stale, setStale] = useState(false)
  const [issued, setIssued] = useState<IssuedCode | null>(null)

  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newBooks, setNewBooks] = useState<string[]>([])
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [editingEmail, setEditingEmail] = useState<string | null>(null)
  const [emailValue, setEmailValue] = useState('')
  /**
   * Which books a pending request will be approved with, before it is approved.
   *
   * Unset means "all the books this site can offer a reviewer", which is
   * currently the one there is. Ticking is still a decision Mike makes on
   * purpose — the server validates the list against the manuscripts either way,
   * so nothing here can grant an author-only book.
   */
  const [requestBooks, setRequestBooks] = useState<Record<string, string[]>>({})

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
      setUnresolved(null)
      try {
        const outcome = await submitAdminMutation(
          '/admin/api/reviewers',
          { ...body, csrf },
          { refusedFallback: 'That could not be saved. Nothing was changed.' },
        )

        if (outcome.kind === 'refused') {
          setError(outcome.message)
          return null
        }

        if (outcome.kind === 'unknown') {
          setUnresolved(outcome.message)
          return null
        }

        if (outcome.payload.view) setView(outcome.payload.view as AdminViewData)
        setStale(!outcome.refreshed)
        return outcome.payload
      } finally {
        setBusy(null)
      }
    },
    [csrf],
  )

  /**
   * The same discipline as `send`, pointed at the requests endpoint.
   *
   * Separate rather than shared because the two endpoints answer with different
   * things — one returns the roster, the other the requests — and a helper that
   * had to guess which would eventually put one into the other's state.
   */
  const act = useCallback(
    async (key: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
      setBusy(key)
      setError(null)
      setUnresolved(null)
      try {
        const outcome = await submitAdminMutation(
          '/admin/api/requests',
          { ...body, csrf },
          { refusedFallback: 'That could not be completed. Nothing further was changed.' },
        )

        if (outcome.kind === 'refused') {
          setError(outcome.message)
          return null
        }

        if (outcome.kind === 'unknown') {
          setUnresolved(outcome.message)
          return null
        }

        if (outcome.payload.requests) setRequests(outcome.payload.requests as AdminRequest[])
        setStale(!outcome.refreshed)
        return outcome.payload
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
  const pendingCount = requests.filter(
    (request) => request.status === 'pending' || request.status === 'approving',
  ).length

  return (
    <div className="ad-root">
      <header className="ad-bar">
        {/*
         * The page is the author's dashboard; reviewers are one section of it,
         * below. It used to be called after its largest section, which made
         * "Read my books" look like a visitor on somebody else's page.
         *
         * The mark is 24px here and carries no alt text: the bar it sits in
         * already says "Author dashboard" two millimetres to its right.
         */}
        <AuthorMark size={24} className="ad-bar-mark" />
        <span className="ad-bar-title">Author dashboard</span>
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
        {/*
         * Reading your own book is the thing you came here to do most often,
         * so it is the first thing on the page rather than a link in a footer.
         * It stays inside `/admin`, which is what lets the administrator cookie
         * keep its narrow scope.
         */}
        <a href="/admin/read" className="ad-read">
          <span className="ad-read-t">
            <span className="ad-read-k">Read my books</span>
            <span className="ad-read-v">
              Every manuscript loaded here, in the reader your reviewers use — plus the
              notes and comments they have shared with you.
            </span>
          </span>
          {/*
           * A chevron, so the card reads as something that goes somewhere
           * rather than as a heading with a paragraph under it. It is
           * decoration over an anchor that was always an anchor: nothing about
           * what this opens, or who may open it, is changed by it.
           */}
          <span className="ad-read-go" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M9 5l7 7-7 7" />
            </svg>
          </span>
        </a>

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

        {unresolved ? (
          <p className="ad-note ad-note--bad" role="alert">
            {unresolved}{' '}
            <b>Do not repeat the action before reloading</b> &mdash; if it did go through,
            doing it again would replace what it produced.
          </p>
        ) : null}

        {stale ? (
          <p className="ad-note" role="status">
            That was saved. The dashboard below could not be re-read in time afterwards, so
            what it shows may be out of date &mdash; reload when the store answers again.{' '}
            <b>Nothing was lost, and nothing needs doing again.</b>
          </p>
        ) : null}

        {/* ----------------------------------------------------- requests */}

        {/*
         * Above the roster, because a person waiting for an answer is more
         * urgent than a person already reading — and because this is the only
         * section that appears because somebody else did something.
         *
         * Everything a stranger wrote is rendered as text by React, which
         * escapes it. Their name and message are never passed through
         * `dangerouslySetInnerHTML` here or anywhere else, and the email that
         * carries them to Mike escapes them explicitly.
         */}
        {!requestsReadable ? (
          <p className="ad-note ad-note--bad" role="alert">
            Access requests could not be read, so they are not being shown. This is a storage
            fault, not an empty list — nobody has been lost, and nothing should be assumed
            about who is waiting until it can be read again.
          </p>
        ) : null}

        {requests.length > 0 ? (
          <section className="ad-section" aria-labelledby="ad-requests">
            <p className="ad-section-eyebrow">Access requests</p>
            <h2 className="ad-section-title" id="ad-requests">
              {pendingCount === 0
                ? 'Nothing waiting'
                : `${pendingCount} waiting for you`}
            </h2>
            <p className="ad-hint">
              Approving creates the account, opens the books you tick, and emails them a
              one-time link. You never see or send the link yourself.
            </p>

            {requests.map((request) => {
              const chosen = requestBooks[request.id] ?? (request.books.length > 0 ? request.books : view.books)
              const failure = deliverySentence(request.delivery)
              /*
               * Uncertain is not failure, and the difference matters here more
               * than anywhere: the link may well have arrived and is still
               * live, so the control must not read as "that did not work" and
               * the expiry must still be shown.
               */
              const uncertain =
                request.delivery?.kind === 'activation' &&
                request.delivery.status === 'uncertain'
              /*
               * A blocked approval is not "undecided" in the sense that matters
               * here: the ordinary Approve/Finish button is refused for it, so
               * offering one would be a button that only ever fails. The two
               * specific ways out are rendered instead.
               */
              const undecided =
                (request.status === 'pending' || request.status === 'approving') &&
                !request.approvalBlockedByRevocation

              return (
                <article
                  key={request.id}
                  className={`ad-card${request.status === 'declined' ? ' ad-card--revoked' : ''}`}
                >
                  <div className="ad-card-head">
                    <h3 className="ad-name">{request.name}</h3>
                    <span
                      className={`ad-pill ${
                        request.status === 'pending' || request.status === 'approving'
                          ? 'ad-pill--active'
                          : 'ad-pill--revoked'
                      }`}
                    >
                      {request.status === 'approving' ? 'unfinished' : request.status}
                    </span>
                  </div>

                  <p className="ad-email">{request.email}</p>

                  <blockquote className="ad-quote">{request.message}</blockquote>

                  <div className="ad-meta">
                    <span>
                      <b>Asked</b> {when(request.createdAt)}
                    </span>
                    {request.decidedAt ? (
                      <span>
                        <b>Decided</b> {when(request.decidedAt)}
                      </span>
                    ) : null}
                    {request.activation?.usedAt ? (
                      <span>
                        <b>Activated</b> {when(request.activation.usedAt)}
                      </span>
                    ) : null}
                    {request.reviewerId ? (
                      <span>
                        <b>Identifier</b> {request.reviewerId}
                      </span>
                    ) : null}
                  </div>

                  {request.status === 'approving' && !request.approvalBlockedByRevocation ? (
                    <p className="ad-note ad-note--bad">
                      That approval did not finish. Nothing is lost and nothing was duplicated —
                      press the button again and it will pick up where it stopped.
                    </p>
                  ) : null}

                  {request.approvalBlockedByRevocation ? (
                    <p className="ad-note ad-note--bad" role="alert">
                      That approval did not finish, and you revoked{' '}
                      <b>{request.reviewerId}</b> afterwards. Finishing it would make them active
                      again, so it is refused. Either <b>Restore reviewer</b> below — which puts
                      them back exactly as they were, so you can then finish the approval — or{' '}
                      <b>Cancel approval</b>, which closes this request and leaves them revoked.
                      Cancelling does not delete the reviewer, and neither button does the other
                      one’s job.
                    </p>
                  ) : null}

                  {failure ? (
                    <p className="ad-note ad-note--bad" role="alert">
                      {failure}
                    </p>
                  ) : null}

                  {request.status === 'approved' &&
                  !request.activation?.usedAt &&
                  (!failure || uncertain) ? (
                    <p className="ad-hint">
                      {request.activationOutstanding
                        ? `${uncertain ? 'The link' : 'Access email sent — awaiting activation. The link'} expires ${when(
                            request.activation?.expiresAt ?? null,
                          )}.`
                        : 'The access email has expired without being used. Send a new one.'}
                    </p>
                  ) : null}

                  {undecided ? (
                    <fieldset className="ad-fieldset" disabled={readOnly || busy !== null}>
                      <legend className="ad-label ad-legend">Open these books</legend>
                      <div className="ad-books">
                        {view.books.map((slug) => (
                          <label className="ad-book" key={slug}>
                            <input
                              type="checkbox"
                              checked={chosen.includes(slug)}
                              onChange={(event) =>
                                setRequestBooks((current) => ({
                                  ...current,
                                  [request.id]: event.target.checked
                                    ? [...chosen, slug]
                                    : chosen.filter((entry) => entry !== slug),
                                }))
                              }
                            />
                            <span>{slug}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ) : null}

                  <div className="ad-btn-row">
                    {request.approvalBlockedByRevocation && request.reviewerId ? (
                      <>
                        <button
                          type="button"
                          className="ad-btn ad-btn--small"
                          disabled={readOnly || busy !== null}
                          onClick={() =>
                            void send(`restore:${request.reviewerId}`, {
                              action: 'restore',
                              reviewerId: request.reviewerId,
                            })
                          }
                        >
                          {busy === `restore:${request.reviewerId}`
                            ? 'Restoring…'
                            : 'Restore reviewer'}
                        </button>

                        <button
                          type="button"
                          className="ad-btn ad-btn--small ad-btn--danger"
                          disabled={readOnly || busy !== null}
                          onClick={() =>
                            void act(`cancel:${request.id}`, {
                              action: 'cancel-approval',
                              requestId: request.id,
                            })
                          }
                        >
                          {busy === `cancel:${request.id}` ? 'Cancelling…' : 'Cancel approval'}
                        </button>
                      </>
                    ) : null}

                    {undecided ? (
                      <>
                        <button
                          type="button"
                          className="ad-btn ad-btn--primary ad-btn--small"
                          disabled={readOnly || busy !== null}
                          onClick={() =>
                            void act(`approve:${request.id}`, {
                              action: 'approve',
                              requestId: request.id,
                              books: chosen,
                            })
                          }
                        >
                          {busy === `approve:${request.id}`
                            ? 'Working…'
                            : request.status === 'approving'
                              ? 'Finish approving and send access email'
                              : 'Approve and send access email'}
                        </button>

                        {request.status === 'pending' ? (
                          <button
                            type="button"
                            className="ad-btn ad-btn--small"
                            disabled={readOnly || busy !== null}
                            onClick={() =>
                              void act(`decline:${request.id}`, {
                                action: 'decline',
                                requestId: request.id,
                              })
                            }
                          >
                            Decline
                          </button>
                        ) : null}
                      </>
                    ) : null}

                    {request.status === 'approved' && request.reviewerStatus === 'active' ? (
                      <button
                        type="button"
                        className="ad-btn ad-btn--small"
                        disabled={readOnly || busy !== null}
                        onClick={() =>
                          void act(`resend:${request.id}`, {
                            action: 'send-access-email',
                            requestId: request.id,
                          })
                        }
                      >
                        {busy === `resend:${request.id}`
                          ? 'Sending…'
                          : failure && !uncertain
                            ? 'Try sending again'
                            : request.reviewerVerified
                              ? 'Send a sign-in email'
                              : 'Send a new activation email'}
                      </button>
                    ) : null}

                    {request.status === 'declined' ? (
                      <button
                        type="button"
                        className="ad-btn ad-btn--small ad-btn--danger"
                        disabled={readOnly || busy !== null}
                        onClick={() =>
                          void act(`remove:${request.id}`, {
                            action: 'remove',
                            requestId: request.id,
                          })
                        }
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>

                  {request.status === 'approved' && request.reviewerStatus === 'active' ? (
                    <p className="ad-hint">
                      {request.reviewerVerified
                        ? 'They have already proved this address, so an activation link would no ' +
                          'longer work for them. This sends a sign-in link instead, and it ' +
                          'expires in about 15 minutes.'
                        : 'This sends an activation link, and it expires in about 3 days.'}{' '}
                      Earlier emails keep working until they expire, so sending another is safe:
                      whichever one they open works, once. The link itself cannot be looked up or
                      re-sent, by you or by anybody. To kill every outstanding link for somebody,
                      use <b>Invalidate links</b> on their roster row.
                    </p>
                  ) : null}

                  {request.status === 'declined' ? (
                    <p className="ad-hint">
                      Removing this frees the address to write to you again. The audit line
                      stays, without what they wrote.
                    </p>
                  ) : null}
                </article>
              )
            })}
          </section>
        ) : null}

        {/* ------------------------------------------------------- roster */}

        {/*
         * Reviewers, now plainly a section of the dashboard rather than the
         * name of the whole page.
         */}
        <section className="ad-section" aria-labelledby="ad-roster">
          <p className="ad-section-eyebrow">Reviewers</p>
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

              <p className="ad-email">
                {reviewer.email || <em>no address recorded</em>}
                {reviewer.email ? (
                  <span
                    className={`ad-tag${reviewer.emailVerifiedAt ? ' ad-tag--ok' : ''}`}
                    title={
                      reviewer.emailVerifiedAt
                        ? 'They opened an emailed link from this address, so they can sign in by email on any device.'
                        : 'Nobody has proved this address yet, so email sign-in is not available to them.'
                    }
                  >
                    {reviewer.emailVerifiedAt ? 'email sign-in' : 'unverified'}
                  </span>
                ) : null}
              </p>

              {editingEmail === reviewer.id ? (
                <div className="ad-field">
                  <label className="ad-label" htmlFor={`email-${reviewer.id}`}>
                    Email address
                  </label>
                  <input
                    id={`email-${reviewer.id}`}
                    className="ad-input"
                    type="email"
                    value={emailValue}
                    onChange={(event) => setEmailValue(event.target.value)}
                    autoComplete="off"
                    aria-describedby={`email-help-${reviewer.id}`}
                  />
                  <p className="ad-hint" id={`email-help-${reviewer.id}`}>
                    Changing this un-verifies the address and stops any link already sent to the
                    old one. Their identifier, their books and everything they have read, marked
                    or written stay exactly as they are.
                  </p>
                  <div className="ad-btn-row">
                    <button
                      type="button"
                      className="ad-btn ad-btn--primary ad-btn--small"
                      disabled={busy !== null || emailValue.trim().length === 0}
                      onClick={async () => {
                        const saved = await send(`email:${reviewer.id}`, {
                          action: 'set-email',
                          reviewerId: reviewer.id,
                          email: emailValue,
                        })
                        if (saved) setEditingEmail(null)
                      }}
                    >
                      Save address
                    </button>
                    <button
                      type="button"
                      className="ad-btn ad-btn--small"
                      onClick={() => setEditingEmail(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}

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

                <button
                  type="button"
                  className="ad-btn ad-btn--small"
                  disabled={readOnly || busy !== null}
                  onClick={() => {
                    setEditingEmail(reviewer.id)
                    setEmailValue(reviewer.email)
                  }}
                >
                  {reviewer.email ? 'Change address' : 'Add address'}
                </button>

                {/*
                 * One button, two messages, and the server decides which.
                 *
                 * An unverified address gets an activation link -- the migration
                 * path for everybody already here with a code; using it proves
                 * the address and gives them email sign-in on every device
                 * afterwards. A verified address gets a fifteen-minute sign-in
                 * link, because an activation link is refused the instant a
                 * verified reviewer presses it, and this button used to send one
                 * anyway and report it as delivered. The label below follows the
                 * same roster state the server resolves, so it says what will
                 * actually happen. Their code keeps working either way.
                 */}
                {reviewer.status === 'active' && reviewer.email ? (
                  <button
                    type="button"
                    className="ad-btn ad-btn--small"
                    disabled={readOnly || busy !== null}
                    onClick={() =>
                      void send(`activation:${reviewer.id}`, {
                        action: 'send-access-email',
                        reviewerId: reviewer.id,
                      })
                    }
                  >
                    {busy === `activation:${reviewer.id}`
                      ? 'Sending…'
                      : reviewer.emailVerifiedAt
                        ? 'Send a sign-in email'
                        : 'Set up email sign-in'}
                  </button>
                ) : null}

                {/*
                 * The one capability the old "only the newest email works" rule
                 * used to provide as a side effect, now a deliberate act. Every
                 * outstanding emailed link for this reviewer stops working. It
                 * does not end sessions and does not touch their code -- the
                 * hint below says so, because assuming otherwise is exactly the
                 * mistake that matters here.
                 */}
                {reviewer.status === 'active' ? (
                  <button
                    type="button"
                    className="ad-btn ad-btn--small"
                    disabled={readOnly || busy !== null}
                    onClick={() =>
                      void send(`invalidate:${reviewer.id}`, {
                        action: 'invalidate-credentials',
                        reviewerId: reviewer.id,
                      })
                    }
                  >
                    {busy === `invalidate:${reviewer.id}` ? 'Invalidating…' : 'Invalidate links'}
                  </button>
                ) : null}

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

              {reviewer.status === 'active' && reviewer.email ? (
                <p className="ad-hint">
                  {reviewer.emailVerifiedAt
                    ? 'They have proved this address, so “Send a sign-in email” sends a sign-in ' +
                      'link that expires in about 15 minutes. An activation link would no longer ' +
                      'work for them.'
                    : '“Set up email sign-in” sends an activation link that expires in about 3 ' +
                      'days. Using it proves the address and turns on email sign-in.'}
                </p>
              ) : null}

              {reviewer.status === 'active' ? (
                <p className="ad-hint">
                  <b>Invalidate links</b> kills every emailed link outstanding for this reviewer,
                  right now. It does not sign them out and it does not change their code — if you
                  want to end a session, use <b>New code</b> or <b>Revoke</b>.
                </p>
              ) : null}

              {reviewer.status === 'revoked' ? (
                <p className="ad-hint">
                  Restoring makes their previous code work again, but every emailed link that was
                  outstanding when you revoked them stays dead. If the code itself may have
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
                  Where their access email goes. Once they have proved this address by using
                  a link sent to it, they can sign in by email as well as with their code.
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
