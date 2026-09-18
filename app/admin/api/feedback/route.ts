import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { ADMIN_COOKIE_NAME, adminCsrfTokenMatches, verifyAdminToken } from '@/lib/admin-auth'
import { loadAuthorBoard } from '@/lib/author-dashboard'
import { exportAuthorFeedback, type ExportNaming } from '@/lib/author-export'
import {
  removeSavedView,
  putSavedView,
  setItemResolved,
  itemMetadata,
  ITEM_ID_PATTERN,
  SAVED_VIEW_HOME_SLUG,
  type AuthorMetadataFailure,
} from '@/lib/author-metadata'
import { authorContext } from '@/lib/reading-session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The author's triage, saved views and export, as four named intents.
 *
 * ## What this endpoint is allowed to be
 *
 * Author-only, CSRF-protected, one intent per request, and **no retries**.
 * A refused or conflicted write answers with what happened and stops; it is
 * never re-attempted here and the browser is never told to re-attempt it for
 * itself. A conflict means somebody else changed the document, and doing the
 * same write again against a document you have not looked at is how a
 * reversible choice becomes an accidental one.
 *
 * ## What it will not take from the caller
 *
 * Nothing the browser sends is authoritative except the shape of the intent.
 * The items, their identities, their timestamps and their contents are all
 * re-read server-side: `resolve` loads the author-visible board for the named
 * book and requires the exact row before it writes anything, `setItemResolved`
 * reads the document it is about to change, `putSavedView` re-parses and
 * re-normalises the view through `asSavedView`, and `exportAuthorFeedback` reads
 * the whole source and every triage document again. A caller cannot pass an item
 * list to be exported, a timestamp to be recorded, or a body to be stored --
 * there is no parameter for any of them.
 *
 * The body is bounded in **bytes**, before it is parsed and while it is read,
 * and a body that fits is decoded exactly or refused -- never repaired into
 * something parseable: see `readBoundedBody` and `exactText`.
 *
 * ## What it never says
 *
 * A closed set of error codes and nothing else. No provider message, no storage
 * path, no stack, no address, no token. `refusal()` below is the only way this
 * file produces a failure body, and it takes a code from a fixed list.
 *
 * ## The export, and where the event happens
 *
 * The **server response is the export event.** `exportAuthorFeedback` generates
 * the packet and both renderings and then stamps `lastExportedAt`; by the time
 * this route answers, that has already happened or already failed. What the
 * browser does next -- save a file, copy to a clipboard, or fail at either --
 * is invisible from here and must never cause a second generation or a second
 * stamp. Retrying is therefore Mike pressing the button again, on purpose,
 * which is an honest new export rather than a hidden repeat of an old one.
 *
 * Nothing generated here is written anywhere. The packet is rendered into the
 * response body and dropped; it is not stored, not cached (`no-store`), not
 * logged, and not sent to anybody. There is no model call, no key and no job.
 */

/*
 * Module-private on purpose, both of these.
 *
 * A Next route module may export only its HTTP methods and the handful of route
 * segment options; anything else is a build error, which is the framework
 * stating that a route file is a route and not a library. So the bound and the
 * file name live here as locals, and the tests exercise them through the
 * handler's own answers rather than by importing them.
 */

/**
 * The largest request this endpoint will read, in **UTF-8 bytes**. A maximal
 * saved view is ~10KB.
 *
 * Bytes, not JavaScript string length: `String.prototype.length` counts UTF-16
 * code units, so 11,000 euro signs measure 11,000 there and 33,000 on the wire.
 * A limit that is checked in code units is not the limit this constant names.
 */
const MAX_BODY_BYTES = 32 * 1024

/** Every intent this endpoint answers. There is no default and no fall-through. */
const INTENTS = ['resolve', 'save-view', 'delete-view', 'export'] as const
type Intent = (typeof INTENTS)[number]

/** Every failure this endpoint names. Safe to print, by construction. */
type Code =
  | 'not_authorized'
  | 'bad_csrf'
  | 'bad_request'
  | 'too_large'
  | 'conflict'
  | 'unreadable'
  | 'storage_unavailable'
  | 'incomplete_source'
  | 'metadata_unreadable'
  | 'write_failed'

const BOOK_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
/** A whole export is bounded by the books the site loaded; this bounds the ask. */
const MAX_EXPORT_BOOKS = 50

function headers(response: NextResponse): NextResponse {
  response.headers.set(
    'Cache-Control',
    'private, no-store, no-cache, max-age=0, must-revalidate',
  )
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
  return response
}

function refusal(code: Code, status: number, extra: Record<string, unknown> = {}): NextResponse {
  return headers(NextResponse.json({ ok: false, error: code, ...extra }, { status }))
}

function accepted(body: Record<string, unknown>): NextResponse {
  return headers(NextResponse.json({ ok: true, ...body }, { status: 200 }))
}

/** One metadata failure, as one of this endpoint's own codes. */
function metadataRefusal(reason: AuthorMetadataFailure): NextResponse {
  if (reason === 'forbidden') return refusal('not_authorized', 403)
  if (reason === 'invalid') return refusal('bad_request', 400)
  if (reason === 'conflict') return refusal('conflict', 409)
  if (reason === 'storage-unavailable') return refusal('storage_unavailable', 503)
  return refusal('unreadable', 503)
}

/** The session cookie's raw value, needed to check a CSRF token against it. */
async function adminToken(): Promise<string | null> {
  const store = await cookies()
  const value = store.get(ADMIN_COOKIE_NAME)?.value
  if (!value) return null
  return (await verifyAdminToken(value)) ? value : null
}

function isIntent(value: unknown): value is Intent {
  return typeof value === 'string' && (INTENTS as readonly string[]).includes(value)
}

/** A compact, deterministic file name. Carries a time and nothing else. */
function exportFilename(generatedAt: string, format: 'json' | 'markdown'): string {
  const stamp = generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z?$/, 'Z')
  return `author-feedback-${stamp}.${format === 'json' ? 'json' : 'md'}`
}

/**
 * The request body, as exactly the text its bytes spell, or `null` when it is
 * past the bound.
 *
 * Two checks, because either one alone can be walked around:
 *
 *   **The declared length**, when there is one. A caller announcing more than
 *   the cap is refused immediately, without reading a byte of it.
 *
 *   **The bytes actually read.** A `content-length` may be absent -- a chunked
 *   or streamed body carries none -- or simply untrue, so the running total is
 *   compared against the cap after every chunk and the read is abandoned the
 *   moment it is exceeded. Nothing past the cap is buffered and `JSON.parse`
 *   is never reached.
 *
 * Then, and only for a body that fit, the bytes are decoded **exactly**: see
 * `exactText`. Decoding waits for the whole body on purpose. A character can
 * straddle two reads, so judging each chunk on its own would refuse a valid
 * request; and a body past the cap is `too_large` whatever its bytes are,
 * because nothing past the cap is ever looked at.
 *
 * If the platform gives no stream at all, the body is taken as bytes and
 * measured by its exact UTF-8 byte count -- never the length of a string it
 * was turned into, which is the measure this bound exists to stop using -- and
 * then decoded the same exact way.
 */
async function readBoundedBody(request: NextRequest): Promise<string | null> {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) return null
  }

  const stream = request.body
  if (!stream) {
    const bytes = new Uint8Array(await request.arrayBuffer())
    return bytes.byteLength > MAX_BODY_BYTES ? null : exactText(bytes)
  }

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_BODY_BYTES) return null
      chunks.push(value)
    }
  } finally {
    // Whether the body ended or was abandoned at the cap, this request is over.
    await reader.cancel().catch(() => {})
  }

  return exactText(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
}

/**
 * The text these bytes spell -- exactly that text, or a throw.
 *
 * A body is either UTF-8 or it is not a request. A lenient decoder reads an
 * invalid sequence as U+FFFD and carries on, and the route would then parse,
 * check and **act on** a document the caller never sent: one bad byte pair
 * inside a string nobody reads was enough to turn a malformed body into an
 * accepted triage write. So decoding is `fatal`, and the throw lands in the
 * caller's `bad_request`, which is what an unreadable body has always been.
 *
 * `ignoreBOM`, for the same reason from the other side: the decoder is not
 * allowed to **remove** a byte either. A leading byte-order mark stays in the
 * text, where `JSON.parse` refuses it as it always has. What comes out of here
 * is the code points of the bytes that went in -- no more and no fewer.
 */
function exactText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}

export async function POST(request: NextRequest) {
  /*
   * The refusal comes first, before a prefix is built, a book is resolved or a
   * store is touched. A reviewer session and an anonymous caller are turned
   * away here, by the author check, and reach no metadata and no feedback.
   */
  const context = await authorContext()
  const token = await adminToken()
  if (!context || !token) return refusal('not_authorized', 401)

  let raw: string | null
  try {
    raw = await readBoundedBody(request)
  } catch {
    return refusal('bad_request', 400)
  }
  if (raw === null) return refusal('too_large', 413)

  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return refusal('bad_request', 400)
    }
    body = parsed as Record<string, unknown>
  } catch {
    return refusal('bad_request', 400)
  }

  if (!(await adminCsrfTokenMatches(token, typeof body.csrf === 'string' ? body.csrf : null))) {
    return refusal('bad_csrf', 403)
  }

  if (!isIntent(body.intent)) return refusal('bad_request', 400)

  try {
    switch (body.intent) {
      case 'resolve':
        return await resolveItem(context.viewer, body)
      case 'save-view':
        return await saveView(context.viewer, body)
      case 'delete-view':
        return await deleteView(context.viewer, body)
      case 'export':
        return await runExport(context.viewer, body)
    }
  } catch {
    // Nothing about the throw is reported. It is never a retry signal either:
    // the caller is told the write did not happen, and doing it again is theirs
    // to decide after reloading what the server now believes.
    console.error('[admin] feedback intent failed')
    return refusal('write_failed', 500)
  }
}

type Viewer = NonNullable<Awaited<ReturnType<typeof authorContext>>>['viewer']

/**
 * Set or clear one item's `resolved`.
 *
 * One item, one intent, one write. `resolved` must be a real boolean -- a
 * missing or string value is `bad_request` rather than a coerced `false`, so a
 * malformed request can never quietly un-resolve something.
 *
 * ## The target has to exist, in the book that was named
 *
 * A pattern-valid `itemId` is a **shape**, not a target. Writing on shape alone
 * lets a CSRF-valid request create triage entries for items that do not exist,
 * consume the bounded metadata capacity, and make later legitimate writes fail
 * -- and re-reading the metadata document proves only what metadata is there,
 * never that the row is real. So the author-visible board for the named book is
 * loaded first and the exact row is required.
 *
 * A board restricted to one book is the whole authority for that book, so a row
 * missing from a **complete** board does not exist and is `bad_request`. A row
 * missing from an **incomplete** board is not an answer at all -- a source did
 * not respond -- and is `incomplete_source`, because refusing a real item as
 * imaginary because a read failed is the one mistake that loses work.
 */
async function resolveItem(viewer: Viewer, body: Record<string, unknown>): Promise<NextResponse> {
  const bookSlug = body.bookSlug
  const itemId = body.itemId
  const resolved = body.resolved

  if (typeof bookSlug !== 'string' || !BOOK_SLUG.test(bookSlug)) return refusal('bad_request', 400)
  if (typeof itemId !== 'string' || !ITEM_ID_PATTERN.test(itemId)) return refusal('bad_request', 400)
  if (typeof resolved !== 'boolean') return refusal('bad_request', 400)
  /*
   * The saved-view document is not a book and holds no items. Naming it here
   * would be an attempt to write triage into the one document that must never
   * carry any, so it is refused by name rather than by accident.
   */
  if (bookSlug === SAVED_VIEW_HOME_SLUG) return refusal('bad_request', 400)

  const board = await loadAuthorBoard(viewer, [bookSlug])
  const target = board.rows.find(
    (row) => row.bookSlug === bookSlug && row.itemId === itemId,
  )
  if (!target) return board.incomplete ? refusal('incomplete_source', 409) : refusal('bad_request', 400)

  const outcome = await setItemResolved(viewer, bookSlug, itemId, resolved)
  if (!outcome.ok) return metadataRefusal(outcome.reason)

  // The server's answer, read back out of the document it just wrote, rather
  // than an echo of what the browser asked for.
  const entry = itemMetadata(outcome.value, itemId)
  return accepted({
    itemId,
    bookSlug,
    resolved: entry.resolved,
    lastReadAt: entry.lastReadAt,
    lastExportedAt: entry.lastExportedAt,
  })
}

/**
 * Add or replace one saved view, in the one document that owns saved views.
 *
 * The view is written to `SAVED_VIEW_HOME_SLUG` and to nothing else, whatever
 * books it names: see that constant for the ownership rule. `putSavedView`
 * re-parses it through `asSavedView`, so what comes back is the normalised,
 * deduplicated, bounded view that was actually stored -- and a malformed or
 * over-limit one is refused whole, leaving every existing view where it was.
 */
async function saveView(viewer: Viewer, body: Record<string, unknown>): Promise<NextResponse> {
  const view = body.view
  if (typeof view !== 'object' || view === null || Array.isArray(view)) {
    return refusal('bad_request', 400)
  }

  const outcome = await putSavedView(viewer, SAVED_VIEW_HOME_SLUG, view)
  if (!outcome.ok) return metadataRefusal(outcome.reason)

  return accepted({ views: outcome.value.views })
}

/** Remove one saved view by id, from the one document that owns saved views. */
async function deleteView(viewer: Viewer, body: Record<string, unknown>): Promise<NextResponse> {
  const viewId = body.viewId
  if (typeof viewId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(viewId)) {
    return refusal('bad_request', 400)
  }

  const outcome = await removeSavedView(viewer, SAVED_VIEW_HOME_SLUG, viewId)
  if (!outcome.ok) return metadataRefusal(outcome.reason)

  return accepted({ views: outcome.value.views })
}

/**
 * Generate one packet and return one rendering of it.
 *
 * `naming` defaults to `pseudonym`; `display-name` has to be asked for on this
 * request, every time, and is never remembered anywhere. The book subset is the
 * explicit list in this request or nothing at all -- there is no hidden state
 * for it to be inferred from, and an omitted list means every book Mike can
 * open rather than "whatever was on screen".
 *
 * An incomplete source or an unreadable triage document produces **no packet**:
 * the committed operation refuses before anything is rendered, and that refusal
 * is reported as an error rather than as a shorter file.
 */
async function runExport(viewer: Viewer, body: Record<string, unknown>): Promise<NextResponse> {
  const format = body.format
  if (format !== 'json' && format !== 'markdown') return refusal('bad_request', 400)

  /*
   * Pseudonyms unless this request asked for names. An absent field is the
   * default and an unrecognised one is a refusal -- never a silent fallback to
   * the safer value, because a caller that meant to ask for names and was
   * quietly given numbers has been told nothing about what it got.
   */
  const asked = body.naming === undefined ? 'pseudonym' : body.naming
  if (asked !== 'pseudonym' && asked !== 'display-name') return refusal('bad_request', 400)
  const naming: ExportNaming = asked

  let bookSlugs: string[] | undefined
  if (body.bookSlugs !== undefined) {
    if (!Array.isArray(body.bookSlugs)) return refusal('bad_request', 400)
    if (body.bookSlugs.length === 0) return refusal('bad_request', 400)
    if (body.bookSlugs.length > MAX_EXPORT_BOOKS) return refusal('bad_request', 400)
    for (const slug of body.bookSlugs) {
      if (typeof slug !== 'string' || !BOOK_SLUG.test(slug)) return refusal('bad_request', 400)
    }
    bookSlugs = body.bookSlugs as string[]
  }

  const generatedAt = new Date().toISOString()
  const outcome = await exportAuthorFeedback(viewer, { naming, bookSlugs }, generatedAt)

  if (!outcome.ok) {
    if (outcome.reason === 'forbidden') return refusal('not_authorized', 403)
    if (outcome.reason === 'storage-unavailable') {
      return refusal('storage_unavailable', 503, { failures: outcome.failures })
    }
    if (outcome.reason === 'metadata-unreadable') {
      return refusal('metadata_unreadable', 409, { failures: outcome.failures })
    }
    return refusal('incomplete_source', 409, { failures: outcome.failures })
  }

  return accepted({
    format,
    filename: exportFilename(generatedAt, format),
    content: format === 'json' ? outcome.json : outcome.markdown,
    naming,
    generatedAt,
    itemCount: outcome.itemIds.length,
    notFound: outcome.notFound,
    stamped: outcome.stamped,
  })
}
