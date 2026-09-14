/**
 * Sending mail, and being honest about what happened.
 *
 * The site's own store stays authoritative for requests, approvals, accounts
 * and permissions. This is a delivery service and nothing else: a message
 * handed to it, and a result written down. Nothing in this file decides
 * anything, grants anything, or is allowed to lose a request.
 *
 * ## The outcomes, and why none of them says "delivered"
 *
 *   `accepted`        the mail service took the message and gave it an id
 *   `refused`         the mail service answered, and said no
 *   `uncertain`       the service was reached and may have taken the message,
 *                     and there is no way from here to find out which
 *   `unreachable`     no answer at all. Retained because records written before
 *                     `uncertain` existed hold it, and it still parses.
 *   `not-configured`  there is no mail service here at all
 *
 * **`accepted` is the strongest thing this system can ever know.** Whether a
 * message reached a mailbox is not observable from inside the sender, and
 * saying "sent" when only acceptance is known would be a lie told in exactly
 * the place Mike is relying on for the truth. The dashboard says the message
 * was handed to the mail service, and when.
 *
 * `uncertain` is the second thing it must be honest about, and it was added
 * because the alternative was worse: folding "the service answered 409" and
 * "the connection broke after the request went out" into a flat "unreachable"
 * reads as *it did not go*, and it might well have.
 *
 * ## Idempotency, and exactly what it does and does not buy
 *
 * Every send carries a stable idempotency key that identifies **one credential
 * in one message** -- the operation identity, not the generation alone, because
 * two different tokens once shared a generation and therefore a key.
 *
 * What that key buys, stated precisely: **Resend will process at most one email
 * for one key carrying an identical payload, within its documented idempotency
 * window (24 hours).** It is the provider's guarantee, not this application's,
 * and it is bounded by that window.
 *
 * What it does not buy: **this application may make up to two provider calls
 * for one stable operation.** `lib/mail-operations.ts` re-offers an uncertain
 * answer once, with the same message and the same key, which is safe precisely
 * *because* of the paragraph above -- not because the call happens only once.
 *
 * **Nothing here guarantees exactly-once delivery, and nothing here guarantees
 * delivery at all.** A refused, unconfigured or permanently uncertain operation
 * may deliver zero messages.
 *
 * And there is **no ordering between access emails**. An earlier version of this
 * comment claimed "the newest credential is the only one that works"; that rule,
 * and the current-credential pointer that enforced it, were deleted. Every
 * emailed credential is individually single-use and stays valid until it is
 * used, until it expires, or until Mike revokes the reviewer, changes their
 * address, or invalidates their outstanding links. So a double-pressed button
 * produces two working emails rather than possibly none, and a reader who opens
 * the older message is not sent away to find the newer one. See
 * `lib/auth-credentials.ts`.
 *
 * Provider idempotency is never used as a substitute for this system's own
 * durable state. The request record is what says whether an activation is
 * outstanding.
 *
 * ## Drivers
 *
 *   `file`          the local outbox. Writes each message as JSON to a
 *                   gitignored directory so the whole journey can be driven end
 *                   to end with no external service, no credential, and no real
 *                   email. This is what local development uses.
 *   `resend`        production. Nothing in this repository has ever run it: it
 *                   needs a credential this work is not authorised to hold.
 *   unconfigured    the default. Refuses, loudly, and is reported as such.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'

if (typeof window !== 'undefined') {
  throw new Error('lib/mailer is server-only and must not be imported by a client component')
}

export type MailOutcome =
  | 'accepted'
  | 'refused'
  | 'uncertain'
  | 'unreachable'
  | 'not-configured'

export type MailResult = {
  status: MailOutcome
  /** The mail service's message id, when it gave one. Not a secret. */
  providerId: string | null
  /** A short failure class. Never a credential, never a recipient, never a link. */
  error: string | null
}

export type MailMessage = {
  to: string
  subject: string
  text: string
  html: string
  /** Stable per operation. See the header comment. */
  idempotencyKey: string
  /** Overrides `EMAIL_REPLY_TO` for the one message that needs to. */
  replyTo?: string
}

export type Mailer = {
  readonly driver: string
  send(message: MailMessage): Promise<MailResult>
}

function trimmed(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function mailFrom(): string {
  return trimmed(process.env.EMAIL_FROM)
}

export function mailReplyTo(): string {
  return trimmed(process.env.EMAIL_REPLY_TO)
}

export function authorAlertAddress(): string {
  return trimmed(process.env.AUTHOR_ALERT_EMAIL)
}

/**
 * The origin every emailed link is built from.
 *
 * Required, and never inferred from the request. Inferring it is precisely the
 * mistake that once sent a phone to `0.0.0.0` after a perfectly good access
 * code, and a link in an email cannot be corrected afterwards. An unset or
 * unusable value means no link can be built, so no message is sent and the
 * failure is shown rather than guessed around.
 */
export function siteOrigin(): string | null {
  const raw = trimmed(process.env.SITE_ORIGIN)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.origin
  } catch {
    return null
  }
}

/* --------------------------------------------------- unconfigured (default) */

class UnconfiguredMailer implements Mailer {
  readonly driver = 'unconfigured'

  async send(): Promise<MailResult> {
    return { status: 'not-configured', providerId: null, error: 'no_mail_driver' }
  }
}

/* ------------------------------------------------------------- file outbox */

/**
 * The local outbox.
 *
 * It writes the message, links and all, to a directory on Mike's own machine.
 * That directory is gitignored and never deployed, and it is the reason the
 * whole activation and sign-in journey can be exercised locally without a mail
 * account, without a credential, and without a single real email leaving the
 * building.
 */
export class FileMailer implements Mailer {
  readonly driver = 'file'

  private readonly dir: string

  constructor(dir: string) {
    this.dir = resolve(dir)
  }

  async send(message: MailMessage): Promise<MailResult> {
    mkdirSync(this.dir, { recursive: true })
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`
    const path = join(this.dir, `${id}.json`)
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          id,
          at: new Date().toISOString(),
          from: mailFrom(),
          replyTo: message.replyTo ?? mailReplyTo(),
          to: message.to,
          subject: message.subject,
          idempotencyKey: message.idempotencyKey,
          text: message.text,
          html: message.html,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    return { status: 'accepted', providerId: id, error: null }
  }
}

/* ------------------------------------------------------------------ Resend */

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

/**
 * How long this application will wait for the mail service before giving up on
 * the answer.
 *
 * There was no deadline at all, and `fetch` has no default one: a provider that
 * accepted the connection and then stalled held the serverless function until
 * the platform killed it. That is the worst possible shape, because the
 * function dying *is* the crash `lib/mail-operations.ts` exists to survive --
 * the operation record stays `in-flight`, is read afterwards as `uncertain`,
 * and is never re-offered. So the stall spent the whole invocation and then
 * produced the one outcome nobody can resolve.
 *
 * Ten seconds is well beyond any healthy Resend response and comfortably inside
 * every platform function limit, so this application decides its own fate.
 *
 * **A timeout is `uncertain`, never `refused` and never `accepted`.** The
 * request may have been received and acted on before the deadline passed; there
 * is no way from here to find out, and claiming either would be a lie in the
 * one place Mike relies on for the truth.
 */
export const RESEND_TIMEOUT_MS = 10_000

/**
 * Whether a rejection is this deadline firing, or any other abort.
 *
 * `AbortSignal.timeout()` rejects with a `TimeoutError`; an explicit abort
 * rejects with an `AbortError`. Both mean "we stopped waiting", and both mean
 * the same thing about the message: unknown.
 */
export function isAbortLike(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  return name === 'TimeoutError' || name === 'AbortError'
}

/**
 * The only provider error names this code will ever repeat.
 *
 * An allowlist rather than a pattern, because the value ends up in a durable
 * record and in the dashboard, and "whatever the provider sent" is not
 * something either of those should be made to hold.
 */
const KNOWN_PROVIDER_ERRORS = new Set([
  'concurrent_idempotent_requests',
  'invalid_idempotent_request',
])

/** Longest error body this will read at all. A provider is not a file host. */
const MAX_ERROR_BODY = 4096

/**
 * Name a provider error, safely, or return null.
 *
 * Everything about this function is deliberately paranoid, because it is the
 * one place an external service's bytes could reach a stored record:
 *
 *   - the body is read as text and truncated before it is parsed;
 *   - only the `name` field is looked at -- never `message`, which is where a
 *     provider echoes back the recipient, the subject, or the request;
 *   - the value is accepted only if it is one of the names above;
 *   - every failure is swallowed into null.
 *
 * So nothing recorded here can contain an address, a credential, a link, a
 * message body, an API key, or anything else the provider chose to say.
 */
async function classifyProviderError(response: Response): Promise<string | null> {
  try {
    const raw = (await response.text()).slice(0, MAX_ERROR_BODY)
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const name = (parsed as Record<string, unknown>).name
    if (typeof name !== 'string') return null
    return KNOWN_PROVIDER_ERRORS.has(name) ? name : null
  } catch {
    return null
  }
}

/**
 * The production driver.
 *
 * **Never exercised in this repository.** It needs `RESEND_API_KEY`, which is
 * held in Mike's password manager, is entered directly into Vercel's protected
 * settings, and is not present on this machine by design. The status mapping
 * below therefore follows the service's documented behaviour rather than
 * observed behaviour, and that distinction is recorded in the report rather
 * than papered over.
 *
 * The key is read here, sent to `api.resend.com` over TLS, and used nowhere
 * else. It is never logged, never returned, never placed in an error string,
 * and never written to any record.
 */
export class ResendMailer implements Mailer {
  readonly driver = 'resend'

  private readonly apiKey: string

  private readonly timeoutMs: number

  constructor(apiKey: string, timeoutMs: number = RESEND_TIMEOUT_MS) {
    this.apiKey = apiKey
    this.timeoutMs = timeoutMs
  }

  async send(message: MailMessage): Promise<MailResult> {
    const from = mailFrom()
    if (!from) return { status: 'not-configured', providerId: null, error: 'no_email_from' }

    const replyTo = message.replyTo ?? mailReplyTo()

    let response: Response
    try {
      response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        // The deadline. See `RESEND_TIMEOUT_MS`: without one, a stalled provider
        // consumes the whole function window and leaves a durable `uncertain`
        // nobody can resolve.
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          // Stable per operation, so a retry inside the service's window is the
          // same message rather than a second one.
          'idempotency-key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(replyTo ? { reply_to: replyTo } : {}),
        }),
      })
    } catch (error) {
      /*
       * Nothing was learned. Not a refusal, and certainly not a send -- but not
       * a proven non-send either: the request may have been received and acted
       * on before the connection broke, or before this application stopped
       * waiting. `uncertain` is the only honest word for either.
       *
       * The two are separated only by the recorded failure class, because they
       * mean different things to whoever reads the dashboard afterwards: a
       * network failure is the provider's or the network's, and `timeout` is
       * this application deciding it had waited long enough.
       */
      return {
        status: 'uncertain',
        providerId: null,
        error: isAbortLike(error) ? 'timeout' : 'network',
      }
    }

    if (response.ok) {
      let providerId: string | null = null
      try {
        const body = (await response.json()) as { id?: unknown }
        if (typeof body.id === 'string') providerId = body.id
      } catch {
        // Accepted with an unreadable body is still accepted.
      }
      return { status: 'accepted', providerId, error: null }
    }

    /*
     * 409 is two different answers wearing one status code, and telling them
     * apart matters:
     *
     *   concurrent_idempotent_requests  the same key and the SAME payload,
     *       while the first request is still running. Not a refusal -- the
     *       first one may well be succeeding -- so: uncertain.
     *
     *   invalid_idempotent_request      the same key reused with a DIFFERENT
     *       payload. Resend says such a request is invalid and cannot succeed
     *       without changing the key or the payload, so retrying is pointless
     *       and calling it uncertain would invite exactly that. It is a fault
     *       in this application, and it is reported as a refusal so it is
     *       visible rather than swallowed.
     *
     * Labelling every 409 as the first is what the previous version did, and it
     * would have hidden the very defect that produced two payloads under one
     * key.
     */
    if (response.status === 409) {
      const name = await classifyProviderError(response)
      if (name === 'invalid_idempotent_request') {
        return { status: 'refused', providerId: null, error: 'invalid_idempotent_request' }
      }
      return {
        status: 'uncertain',
        providerId: null,
        error: name ?? 'concurrent_idempotent_requests',
      }
    }
    // The service was reached and did not say no. A 5xx after a message has
    // been received can still mean it was queued.
    if (response.status === 429 || response.status >= 500) {
      return { status: 'uncertain', providerId: null, error: `http_${response.status}` }
    }

    // A 4xx the service chose to give. The status is recorded; the body is not,
    // because it is the one place a recipient or a key could be echoed back.
    return { status: 'refused', providerId: null, error: `http_${response.status}` }
  }
}

/* ----------------------------------------------------------------- factory */

let mailer: Mailer | null = null

export function createMailer(): Mailer {
  if (mailer) return mailer

  const driver = trimmed(process.env.EMAIL_DRIVER).toLowerCase()

  if (driver === 'file') {
    const dir = trimmed(process.env.EMAIL_OUTBOX_DIR)
    if (!dir) throw new Error('EMAIL_DRIVER=file requires EMAIL_OUTBOX_DIR')
    mailer = new FileMailer(dir)
  } else if (driver === 'resend') {
    const key = trimmed(process.env.RESEND_API_KEY)
    if (!key) throw new Error('EMAIL_DRIVER=resend requires RESEND_API_KEY')
    mailer = new ResendMailer(key)
  } else {
    mailer = new UnconfiguredMailer()
  }

  return mailer
}

/** Test seam. Resets the memoised mailer so a test can drive each driver. */
export function __resetMailer(): void {
  mailer = null
}
