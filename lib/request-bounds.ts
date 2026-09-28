/**
 * Bounding a public request body **before** anything parses it.
 *
 * ## What was wrong
 *
 * Every public write on this site began the same way: `await request.formData()`
 * or `await request.json()`, and only then the application's own limits -- the
 * 600-character message, the 4,000-character note, the honeypot, the rate
 * limiter. Those limits are real, and every one of them ran after the whole
 * body had already been received and decoded into memory. A request declaring
 * a hundred megabytes was a hundred megabytes of parsing before a single line
 * of this application had an opinion about it. The application did not bound
 * parse-time resource use at all; it bounded what it would *store*, which is a
 * different thing and happens later.
 *
 * A platform in front of the app may well cap request sizes. That is a fact
 * about a deployment, not about this code, and nothing in this repository
 * establishes it. So the bound is taken here, where it is true wherever this
 * runs -- `next dev` on a laptop included.
 *
 * ## How the bound is taken
 *
 * Three checks, in this order, and the body is not parsed until all three pass:
 *
 *   1. **The media type.** Only the types this site actually posts are parsed.
 *      Anything else is refused without reading the body at all, so an
 *      unsupported type costs nothing.
 *
 *   2. **The declared length.** `Content-Length` above the limit is refused
 *      before the stream is touched. This is the cheap case and it is checked
 *      first, but it is never the only check, because the declaration is the
 *      caller's and a chunked request carries none at all.
 *
 *   3. **The bytes themselves.** The body is drained one chunk at a time with a
 *      running total, and the moment the total passes the limit the stream is
 *      cancelled and the request is refused. A body that lies about its length,
 *      or declares none, is stopped by this and not by the header above it.
 *
 * Only then are the collected bytes -- of which there are at most `limit` --
 * decoded as strict UTF-8 and handed to a parser, which works from those bytes
 * rather than the original request. Nothing here ever calls
 * `request.formData()` or `request.json()`, which is the whole point: those are
 * exactly the calls that consume an unbounded body. Ill-formed UTF-8, raw or
 * (in a form) percent-encoded, is refused as `unreadable`; see "Why decoding
 * is fatal here" below.
 *
 * ## What a refusal must not do
 *
 * Nothing. A refusal happens before the store is opened, before the limiter is
 * consulted, before any mail is composed and before any session is minted, and
 * it says only that the request was refused -- never how large it was, what the
 * limit is, or which check stopped it. Those are the caller's to guess at, not
 * ours to confirm.
 *
 * Deliberately dependency-free and server-only: no Next, no store, no
 * application types. It takes a `Request` and a number and answers.
 */

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/request-bounds is server-only and must not be imported by a client component',
  )
}

/** The one form encoding this site's forms produce. */
export const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded'

/** The one body encoding the reader's API sends. */
export const JSON_MEDIA_TYPE = 'application/json'

/**
 * Why a body was refused.
 *
 * Kept apart from each other here and deliberately flattened by the callers:
 * this module knows which check stopped the request, and a public endpoint does
 * not tell the caller that.
 */
export type BodyRefusal = 'too-large' | 'unsupported-media-type' | 'unreadable'

export type BoundedBody<T> = { ok: true; value: T } | { ok: false; reason: BodyRefusal }

/* ------------------------------------------------------------ the limits */

/*
 * Each limit is the sum of what its endpoint actually accepts, with room for
 * the worst honest encoding of it, and nothing else. They are bytes on the
 * wire, not characters: one character can be four bytes of UTF-8 and each of
 * those bytes can be three characters of percent-encoding, so a 600-character
 * message is worth about 7 KB in the worst case a real browser can produce.
 */

/**
 * `POST /review/api/request`: a name (80), an address, a message (600), a
 * honeypot that is expected to be empty, and a timestamp.
 */
export const REQUEST_FORM_LIMIT_BYTES = 16 * 1024

/** `POST /review/api/signin`: an address, the honeypot, and a timestamp. */
export const SIGNIN_FORM_LIMIT_BYTES = 4 * 1024

/** `POST /review/api/credential`: a purpose word and one emailed credential. */
export const CREDENTIAL_FORM_LIMIT_BYTES = 4 * 1024

/** `POST /review/api/unlock`: an access code and a path within this site. */
export const UNLOCK_FORM_LIMIT_BYTES = 4 * 1024

/**
 * `POST /review/api/reading`: an operation name, a handful of slugs, offsets
 * and identifiers, and at most one note body.
 *
 * A note body is capped at 4,000 characters (`MAX_NOTE_BODY_LENGTH`). JSON may
 * escape each of those as `\uXXXX`, and an astral character as a surrogate
 * pair, so the body alone can honestly reach roughly 24 KB. Nothing else on
 * this request is longer than a slug. No anchor text is sent: a paragraph's
 * words and a quotation are taken from the verified manuscript on the server,
 * never from the browser, so `MAX_PARAGRAPH_TEXT_LENGTH` is not part of this
 * budget.
 */
export const READING_JSON_LIMIT_BYTES = 32 * 1024

/* ------------------------------------------------------------ the reading */

/** The media type alone, lower-cased, with any parameters dropped. */
function mediaTypeOf(header: string | null): string {
  if (header === null) return ''
  const semicolon = header.indexOf(';')
  return (semicolon === -1 ? header : header.slice(0, semicolon)).trim().toLowerCase()
}

/**
 * The body, up to `limit` bytes, or a refusal.
 *
 * The stream is cancelled on the first chunk that takes the total past the
 * limit, so an oversized upload is stopped rather than received and discarded.
 */
async function readBoundedBytes(
  request: Request,
  limit: number,
): Promise<BoundedBody<Uint8Array>> {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    /*
     * A plain run of digits, which is the only thing `Content-Length` is
     * allowed to be. `Number()` would also accept '1e9', ' 12 ', '0x10' and
     * '+5', none of which any HTTP client sends and each of which would mean
     * this check was reasoning about a value it had invented. A header that is
     * not a declaration is refused rather than ignored: reading on would mean
     * trusting a caller who has already sent something malformed.
     */
    if (!/^[0-9]+$/.test(declared.trim())) return { ok: false, reason: 'unreadable' }
    const length = Number(declared.trim())
    if (!Number.isSafeInteger(length)) return { ok: false, reason: 'unreadable' }
    if (length > limit) return { ok: false, reason: 'too-large' }
  }

  const stream = request.body
  // No body at all. An empty one is a complete answer here; whether the
  // endpoint can do anything with it is the endpoint's question.
  if (!stream) return { ok: true, value: new Uint8Array() }

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > limit) {
        await cancelQuietly(reader)
        return { ok: false, reason: 'too-large' }
      }
      chunks.push(value)
    }
  } catch {
    await cancelQuietly(reader)
    return { ok: false, reason: 'unreadable' }
  }

  const body = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.byteLength
  }
  return { ok: true, value: body }
}

/**
 * Stop reading, and never fail because of it.
 *
 * A cancel can reject when the peer has already gone. The request is being
 * refused either way, and a rejection here would turn a clean refusal into a
 * 500.
 */
async function cancelQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    /* deliberately ignored -- see above */
  }
}

/* ------------------------------------------------------------ strict UTF-8 */

/*
 * ## Why decoding is fatal here
 *
 * Both parsers used to decode forgivingly: an invalid byte became U+FFFD and
 * parsing carried on, so a body that was not UTF-8 at all reached field
 * validation -- and, where the damaged field was not one a later check looks
 * at, the business call -- as if it had been. A malformed body is not a body
 * this site's forms or reader produce, and it is refused here with the same
 * `unreadable` every other unparseable body gets, before anything is called.
 *
 * Fatal decoding refuses **ill-formed** input only. A correctly encoded U+FFFD
 * -- the three bytes EF BF BD, raw or as `%EF%BF%BD` -- is a character like any
 * other and passes: what is refused is a sequence that is not UTF-8, never a
 * particular character.
 */

/** Throws on any ill-formed sequence. A BOM is content, not stripped. */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Throws on any ill-formed sequence. A leading BOM is dropped, as before. */
const STRICT_UTF8_TEXT = new TextDecoder('utf-8', { fatal: true })

const HEX = /^[0-9A-Fa-f]{2}$/

/**
 * One `application/x-www-form-urlencoded` name or value, decoded strictly.
 *
 * The standard steps -- `+` is a space, then percent-decoding to **bytes**,
 * then UTF-8 -- with two refusals the forgiving decoder lacks:
 *
 *   - a `%` not followed by exactly two hex digits is refused rather than kept
 *     as a literal `%`;
 *   - the bytes percent-decoding produces must be well-formed UTF-8. `%80`,
 *     `%C3` alone, `%C3%28`, `%C0%AF`, `%ED%A0%80` and their like are valid
 *     ASCII on the wire and only become ill-formed once unescaped, so checking
 *     the raw body cannot see them. This is where they are seen.
 *
 * `+` is replaced before unescaping, so `%2B` is a literal plus sign and `+`
 * is a space, exactly as a browser encodes them. Throws on refusal.
 */
function decodeFormComponent(component: string): string {
  const text = component.replace(/\+/g, ' ')
  if (!text.includes('%')) return text

  const encoder = new TextEncoder()
  const bytes: number[] = []
  for (let at = 0; at < text.length; ) {
    if (text[at] === '%') {
      const hex = text.slice(at + 1, at + 3)
      if (!HEX.test(hex)) throw new Error('malformed percent escape')
      bytes.push(Number.parseInt(hex, 16))
      at += 3
      continue
    }
    // One code point at a time. The component came out of a fatal decode, so
    // it holds no lone surrogate and re-encoding it is exact.
    const point = text.codePointAt(at) as number
    const char = String.fromCodePoint(point)
    const encoded = encoder.encode(char)
    for (let i = 0; i < encoded.length; i += 1) bytes.push(encoded[i])
    at += char.length
  }
  return STRICT_UTF8.decode(new Uint8Array(bytes))
}

/**
 * The urlencoded parser, over bytes already bounded, strictly.
 *
 * The raw bytes are fatal-decoded first, which refuses an invalid byte on the
 * wire; each component is then decoded by `decodeFormComponent`, which refuses
 * an invalid byte that was percent-encoded. Splitting on `&` and `=` after the
 * first decode is exact, because both are ASCII and UTF-8 never uses an ASCII
 * byte inside a multi-byte sequence. Empty sequences are skipped and a name
 * with no `=` has an empty value, as the standard parser does. Throws on
 * refusal; the caller turns that into `unreadable`.
 */
function parseStrictForm(body: Uint8Array): FormData {
  const text = STRICT_UTF8.decode(body)
  const form = new FormData()
  for (const sequence of text.split('&')) {
    if (sequence === '') continue
    const equals = sequence.indexOf('=')
    const name = equals === -1 ? sequence : sequence.slice(0, equals)
    const value = equals === -1 ? '' : sequence.slice(equals + 1)
    form.append(decodeFormComponent(name), decodeFormComponent(value))
  }
  return form
}

/**
 * A form body, bounded, or a refusal.
 *
 * Only `application/x-www-form-urlencoded` is parsed, because that is what a
 * plain HTML form on this site posts and this site has no form that sends
 * anything else. A `multipart/form-data` or `text/plain` submission is refused
 * rather than decoded: there is no endpoint here that wants one, and declining
 * to parse a shape nobody sends removes a parser from the public surface
 * entirely.
 *
 * The parser is this module's own (`parseStrictForm`), not the platform's
 * forgiving one, so that ill-formed UTF-8 -- raw or percent-encoded -- is a
 * refusal rather than a U+FFFD. See "Why decoding is fatal here" above.
 */
export async function readBoundedForm(
  request: Request,
  limit: number,
): Promise<BoundedBody<FormData>> {
  const type = request.headers.get('content-type')
  if (mediaTypeOf(type) !== FORM_MEDIA_TYPE) {
    return { ok: false, reason: 'unsupported-media-type' }
  }

  const bytes = await readBoundedBytes(request, limit)
  if (!bytes.ok) return bytes

  try {
    // Parsed out of the bytes already in hand, never out of the request. At
    // most `limit` bytes reach this line.
    return { ok: true, value: parseStrictForm(bytes.value) }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
}

/**
 * A JSON body, bounded, or a refusal.
 *
 * The media type is required rather than assumed. A browser can send a
 * credentialed cross-origin `text/plain` POST whose body happens to be JSON
 * without asking permission first; requiring `application/json` means such a
 * request cannot reach a parser at all, and -- because it is not a type a
 * simple request may carry -- means the browser must ask permission first,
 * which this site never grants. That is a useful second lock; it is **not** the
 * authorization boundary. See `sameOrigin` in `lib/request-origin.ts` for that.
 */
export async function readBoundedJson(
  request: Request,
  limit: number,
): Promise<BoundedBody<unknown>> {
  if (mediaTypeOf(request.headers.get('content-type')) !== JSON_MEDIA_TYPE) {
    return { ok: false, reason: 'unsupported-media-type' }
  }

  const bytes = await readBoundedBytes(request, limit)
  if (!bytes.ok) return bytes

  try {
    // Fatal: an ill-formed byte refuses the body before `JSON.parse` runs,
    // rather than arriving in a string value as U+FFFD.
    return { ok: true, value: JSON.parse(STRICT_UTF8_TEXT.decode(bytes.value)) }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
}
