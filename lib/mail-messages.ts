/**
 * The three messages this site sends, composed in one place.
 *
 * Two rules govern every line below.
 *
 * **The credential lives in the fragment.** An activation link is
 * `…/review/activate#a=<token>`, and everything after the `#` is never sent to
 * any server: not to Vercel's runtime logs, not to an access log, not in a
 * `Referer`. The page reads it in the browser, strips it from the address bar,
 * and submits it in the body of a POST. A query parameter would have put the
 * same secret in every log line that records a URL, which is why there is not
 * one anywhere in this feature.
 *
 * The same token is also printed in the message as a code to copy, because mail
 * clients do rewrite and occasionally damage links, and a reviewer who cannot
 * follow the link should not have to write to Mike. That code is visible to the
 * person it was sent to and to nobody else — **it is never shown to Mike, never
 * stored, and cannot be recovered from anything this system keeps.**
 *
 * **Everything a stranger wrote is escaped.** The alert Mike receives carries a
 * name and a message typed by somebody unauthenticated. Both are escaped for
 * HTML here, at the point of composition, rather than trusted to be harmless.
 */

import type { ReviewerRequest } from './reviewer-requests.ts'
import type { MailMessage } from './mailer.ts'

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/mail-messages is server-only and must not be imported by a client component',
  )
}

/** Escape for HTML text and attribute contexts alike. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function paragraphs(value: string): string {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => `<p style="margin:0 0 0.75rem">${escapeHtml(line)}</p>`)
    .join('')
}

/** A plain, readable shell. No tracking pixel, no images, no remote anything. */
function shell(body: string): string {
  return [
    '<div style="font:16px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;',
    'color:#1a1714;max-width:34rem;margin:0 auto;padding:1.5rem">',
    body,
    '</div>',
  ].join('')
}

function whenReadable(iso: string): string {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return 'shortly'
  return new Date(parsed).toUTCString()
}

export function activationLink(origin: string, token: string): string {
  return `${origin}/review/activate#a=${token}`
}

export function signinLink(origin: string, token: string): string {
  return `${origin}/review/signin/verify#s=${token}`
}

/* ------------------------------------------------- 1. the alert to the author */

/**
 * Sent to Mike after the request is durably stored, and never before.
 *
 * `Reply-To` is the requester's own address, so Mike can answer a person
 * directly from his phone. It is the only message that does that, and it
 * discloses nothing he was not already being shown.
 */
export function authorAlertMessage(input: {
  to: string
  request: ReviewerRequest
  adminUrl: string
}): MailMessage {
  const { request } = input
  const subject = `Reviewer access request — ${request.name}`

  const text = [
    `${request.name} <${request.email}> has asked to read your advance edition.`,
    '',
    'What they wrote:',
    request.message,
    '',
    `Decide in your dashboard: ${input.adminUrl}`,
    '',
    'This message was sent by mikeramseyjr.com. The request is already saved,',
    'whether or not this email arrived.',
  ].join('\n')

  const html = shell(
    [
      `<p style="margin:0 0 1rem"><strong>${escapeHtml(request.name)}</strong> `,
      `&lt;${escapeHtml(request.email)}&gt; has asked to read your advance edition.</p>`,
      '<div style="border-left:3px solid #d8d2c4;padding-left:0.9rem;margin:0 0 1.25rem">',
      paragraphs(request.message),
      '</div>',
      `<p style="margin:0 0 1rem"><a href="${escapeHtml(input.adminUrl)}">Open your dashboard</a> `,
      'to approve or decline.</p>',
      '<p style="margin:0;color:#6b6459;font-size:0.875rem">The request is already saved, ',
      'whether or not this email arrived.</p>',
    ].join(''),
  )

  return {
    to: input.to,
    subject,
    text,
    html,
    /*
     * One alert per request **occurrence**. A retry inside the service's window
     * is the same message, not a second one -- and a *new* request from an
     * address whose old request was declined and removed is a different
     * occurrence, so it is a different key and a genuinely new message.
     *
     * The request id alone was not enough, and the gap was real rather than
     * theoretical: the id is derived from the address, a removal frees the
     * pathname, and the next submission from that address lands at exactly the
     * same id. Keyed on the id alone, the second person's alert collided with a
     * durable mail operation from months earlier, `sendMailOperation` returned
     * that old operation's outcome, and nothing was sent. Mike would have seen
     * a pending request only if he happened to open the dashboard.
     *
     * `notificationId` is minted by the create-if-absent that brings each
     * occurrence into existence (`lib/reviewer-requests.ts`), so two occurrences
     * can never share one. A record written before the field existed has none,
     * and falls back to the id -- which is what its already-sent alert was keyed
     * on, so nothing re-sends on a deploy.
     */
    idempotencyKey: authorAlertKey(request),
    replyTo: request.email,
  }
}

/** The author alert's idempotency key: this request, at this occurrence. */
export function authorAlertKey(request: ReviewerRequest): string {
  return request.notificationId
    ? `author-alert:${request.id}:${request.notificationId}`
    : `author-alert:${request.id}`
}

/* --------------------------------------------- 2. the activation, to the reader */

export function activationMessage(input: {
  to: string
  name: string
  origin: string
  token: string
  expiresAt: string
  /** The credential's own mail-operation identity. See `lib/auth-credentials.ts`. */
  operationId: string
  requestId: string
}): MailMessage {
  const link = activationLink(input.origin, input.token)
  const expires = whenReadable(input.expiresAt)

  const text = [
    `${input.name},`,
    '',
    'Mike has opened his advance reading to you. Follow this link on the device',
    'you would like to read on, then press the button on the page:',
    '',
    link,
    '',
    'If the link does not work, open this page:',
    `${input.origin}/review/activate`,
    'and enter this one-time code:',
    '',
    input.token,
    '',
    `The link and the code stop working after they are used once, and expire ${expires}.`,
    'If they expire, ask Mike for a new one.',
    '',
    'Please keep the reading, and this message, to yourself.',
  ].join('\n')

  const html = shell(
    [
      `<p style="margin:0 0 1rem">${escapeHtml(input.name)},</p>`,
      '<p style="margin:0 0 1.25rem">Mike has opened his advance reading to you. Open this on ',
      'the device you would like to read on, then press the button on the page.</p>',
      `<p style="margin:0 0 1.5rem"><a href="${escapeHtml(link)}" `,
      'style="display:inline-block;padding:0.7rem 1.1rem;background:#1a1714;color:#fbf9f4;',
      'text-decoration:none;border-radius:0.35rem">Open my reading</a></p>',
      '<p style="margin:0 0 0.5rem;color:#6b6459;font-size:0.9375rem">If that button does not ',
      `work, open <a href="${escapeHtml(`${input.origin}/review/activate`)}">`,
      `${escapeHtml(`${input.origin}/review/activate`)}</a> and enter this one-time code:</p>`,
      '<p style="margin:0 0 1.25rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;',
      `font-size:0.9375rem;word-break:break-all">${escapeHtml(input.token)}</p>`,
      '<p style="margin:0;color:#6b6459;font-size:0.875rem">It works once, and expires ',
      `${escapeHtml(expires)}. Please keep the reading, and this message, to yourself.</p>`,
    ].join(''),
  )

  return {
    to: input.to,
    subject: 'Your advance reading is open',
    text,
    html,
    /*
     * Keyed by the credential's own random operation identity, and by nothing
     * else. An earlier key was built from a generation number, and two
     * simultaneous issues produced two different tokens under one generation --
     * two different payloads sharing one key, with the mail-operation claim
     * suppressing one of them. A different credential is now always a different
     * key; a retry of the same credential is still the same key.
     */
    idempotencyKey: `activation:${input.requestId}:${input.operationId}`,
  }
}

/* ------------------------------------------ 3. the sign-in link, to the reader */

export function signinMessage(input: {
  to: string
  name: string
  origin: string
  token: string
  expiresAt: string
  /** The credential's own mail-operation identity. See `lib/auth-credentials.ts`. */
  operationId: string
  reviewerId: string
}): MailMessage {
  const link = signinLink(input.origin, input.token)
  const expires = whenReadable(input.expiresAt)

  const text = [
    `${input.name},`,
    '',
    'Here is your sign-in link for Mike Ramsey Jr’s advance reading. Open it on',
    'the device you want to read on, then press the button on the page:',
    '',
    link,
    '',
    'If the link does not work, open this page:',
    `${input.origin}/review/signin/verify`,
    'and enter this one-time code:',
    '',
    input.token,
    '',
    `It works once, and expires ${expires}.`,
    '',
    'If you did not ask for this, you can ignore it. Nothing has changed.',
  ].join('\n')

  const html = shell(
    [
      `<p style="margin:0 0 1rem">${escapeHtml(input.name)},</p>`,
      '<p style="margin:0 0 1.25rem">Here is your sign-in link. Open it on the device you want ',
      'to read on, then press the button on the page.</p>',
      `<p style="margin:0 0 1.5rem"><a href="${escapeHtml(link)}" `,
      'style="display:inline-block;padding:0.7rem 1.1rem;background:#1a1714;color:#fbf9f4;',
      'text-decoration:none;border-radius:0.35rem">Sign in and read</a></p>',
      '<p style="margin:0 0 0.5rem;color:#6b6459;font-size:0.9375rem">If that button does not ',
      `work, open <a href="${escapeHtml(`${input.origin}/review/signin/verify`)}">`,
      `${escapeHtml(`${input.origin}/review/signin/verify`)}</a> and enter this one-time code:</p>`,
      '<p style="margin:0 0 1.25rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;',
      `font-size:0.9375rem;word-break:break-all">${escapeHtml(input.token)}</p>`,
      '<p style="margin:0;color:#6b6459;font-size:0.875rem">It works once, and expires ',
      `${escapeHtml(expires)}. If you did not ask for this, you can ignore it — nothing `,
      'has changed.</p>',
    ].join(''),
  )

  return {
    to: input.to,
    subject: 'Sign in to your advance reading',
    text,
    html,
    // See the activation message: the operation identity is what makes one key
    // mean exactly one payload.
    idempotencyKey: `signin:${input.reviewerId}:${input.operationId}`,
  }
}
