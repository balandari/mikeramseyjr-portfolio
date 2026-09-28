import test from 'node:test'
import assert from 'node:assert/strict'

/*
 * The bound taken **before** a public body is parsed (F6).
 *
 * The finding: every public write on this site began with `request.formData()`
 * or `request.json()`, and the application's own limits -- the 600-character
 * message, the 4,000-character note, the honeypot, the rate limiter -- all ran
 * after the whole body had been received and decoded. The application bounded
 * what it would *store*. It did not bound what it would *parse*.
 *
 * This file is about the mechanism on its own; `tests/public-write-boundary.test.ts`
 * is about the five endpoints that use it and the side effects they must not
 * have. Each case here is written against the exact state the old code was in:
 *
 *   - a declared `Content-Length` over the limit must be refused **before the
 *     stream is touched at all**, which is checked by giving the request a body
 *     that records whether anybody ever read it;
 *
 *   - a body that declares no length, or lies about it, must still be stopped,
 *     which is the case a `Content-Length` check alone cannot reach and the one
 *     an attacker would actually use;
 *
 *   - the limit itself must be inclusive, so a request of exactly the limit
 *     succeeds and one of limit-plus-one does not. Both are asserted, because a
 *     bound that refuses everything is as wrong as one that refuses nothing;
 *
 *   - only the media types this site posts may reach a parser.
 */

import {
  CREDENTIAL_FORM_LIMIT_BYTES,
  FORM_MEDIA_TYPE,
  JSON_MEDIA_TYPE,
  READING_JSON_LIMIT_BYTES,
  REQUEST_FORM_LIMIT_BYTES,
  SIGNIN_FORM_LIMIT_BYTES,
  UNLOCK_FORM_LIMIT_BYTES,
  readBoundedForm,
  readBoundedJson,
} from '../lib/request-bounds.ts'

const URL_UNDER_TEST = 'https://example.test/review/api/whatever'

/* ---------------------------------------------------------- the fixtures */

/** A form body of exactly `bytes` bytes, as a browser would encode one. */
function formBodyOfExactly(bytes: number): string {
  const prefix = 'message='
  assert.ok(bytes >= prefix.length, 'asked for a body shorter than its own field name')
  return prefix + 'x'.repeat(bytes - prefix.length)
}

/** A JSON body of exactly `bytes` bytes. */
function jsonBodyOfExactly(bytes: number): string {
  const wrapper = '{"op":"note-create","body":""}'
  assert.ok(bytes >= wrapper.length, 'asked for a body shorter than its own wrapper')
  return `{"op":"note-create","body":"${'x'.repeat(bytes - wrapper.length)}"}`
}

function formRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request(URL_UNDER_TEST, {
    method: 'POST',
    headers: { 'content-type': FORM_MEDIA_TYPE, ...headers },
    body,
  })
}

function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request(URL_UNDER_TEST, {
    method: 'POST',
    headers: { 'content-type': JSON_MEDIA_TYPE, ...headers },
    body,
  })
}

/**
 * A request whose body is a stream that reports what was done to it.
 *
 * `pulls` counts how many chunks were actually taken and `cancelled` records
 * whether the reader stopped the stream rather than draining it.
 *
 * **One pull is not a read.** Node's `Request` speculatively takes a single
 * chunk from a stream body shortly after construction, before anything under
 * test has run, so the honest statement about a refusal that never reads the
 * body is "at most one chunk was ever taken" -- against a fixture holding a
 * thousand. `request.formData()` on the same fixture takes all thousand, so
 * the two states are not close to each other and nothing here is tuned.
 */
function streamedRequest(
  contentType: string,
  chunkBytes: number,
  chunks: number,
  headers: Record<string, string> = {},
): { request: Request; state: { pulls: number; cancelled: boolean } } {
  const state = { pulls: 0, cancelled: false }
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) {
        controller.close()
        return
      }
      sent += 1
      state.pulls += 1
      controller.enqueue(new TextEncoder().encode('x'.repeat(chunkBytes)))
    },
    cancel() {
      state.cancelled = true
    },
  })

  const request = new Request(URL_UNDER_TEST, {
    method: 'POST',
    headers: { 'content-type': contentType, ...headers },
    body: stream,
    // Required by Node for a streaming request body.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })

  return { request, state }
}

/* ------------------------------------------------- the limits themselves */

test('every endpoint limit is small, positive and stated in bytes', () => {
  const limits = {
    REQUEST_FORM_LIMIT_BYTES,
    SIGNIN_FORM_LIMIT_BYTES,
    CREDENTIAL_FORM_LIMIT_BYTES,
    UNLOCK_FORM_LIMIT_BYTES,
    READING_JSON_LIMIT_BYTES,
  }
  for (const [name, value] of Object.entries(limits)) {
    assert.ok(Number.isSafeInteger(value) && value > 0, `${name} is not a byte count`)
    // "Small" is the requirement, and it is worth pinning: a limit that drifts
    // into the megabytes is the unbounded parse again with extra steps.
    assert.ok(value <= 64 * 1024, `${name} is no longer a small limit`)
  }
})

/* --------------------------------------------------- the exact boundary */

test('a form body of exactly the limit is accepted', async () => {
  const limit = 512
  const body = formBodyOfExactly(limit)
  assert.equal(new TextEncoder().encode(body).byteLength, limit)

  const bounded = await readBoundedForm(formRequest(body), limit)
  assert.equal(bounded.ok, true, 'a body of exactly the limit was refused')
  if (!bounded.ok) return
  assert.equal(bounded.value.get('message'), 'x'.repeat(limit - 'message='.length))
})

test('a form body one byte over the limit is refused', async () => {
  const limit = 512
  const body = formBodyOfExactly(limit + 1)
  assert.equal(new TextEncoder().encode(body).byteLength, limit + 1)

  const bounded = await readBoundedForm(formRequest(body), limit)
  assert.deepEqual(bounded, { ok: false, reason: 'too-large' })
})

test('a JSON body of exactly the limit is accepted, and one byte more is not', async () => {
  const limit = 512

  const exact = await readBoundedJson(jsonRequest(jsonBodyOfExactly(limit)), limit)
  assert.equal(exact.ok, true, 'a body of exactly the limit was refused')

  const over = await readBoundedJson(jsonRequest(jsonBodyOfExactly(limit + 1)), limit)
  assert.deepEqual(over, { ok: false, reason: 'too-large' })
})

/* ------------------------------------------- the declared length, first */

test('an oversized declared Content-Length is refused without reading the body', async () => {
  /*
   * The cheap check, and the one that has to happen *first*. The body is a
   * thousand chunks that record every pull; a limiter that believed the
   * declaration before touching the stream leaves that count on the floor.
   */
  const { request, state } = streamedRequest(FORM_MEDIA_TYPE, 256, 1000, {
    'content-length': String(10 * 1024 * 1024),
  })

  const bounded = await readBoundedForm(request, 512)
  assert.deepEqual(bounded, { ok: false, reason: 'too-large' })
  assert.ok(
    state.pulls <= 1,
    `the body was read (${state.pulls} chunks) despite an oversized declaration`,
  )
})

test('a Content-Length that is not a plain count is refused rather than ignored', async () => {
  // Every one of these is something `Number()` would have been happy with, or
  // something no client sends. None of them is a count of bytes.
  for (const declared of ['not a number', '-1', '1e9', '0x10', '+5', '1.5', '']) {
    const bounded = await readBoundedForm(
      formRequest('message=short', { 'content-length': declared }),
      512,
    )
    assert.deepEqual(
      bounded,
      { ok: false, reason: 'unreadable' },
      `Content-Length: ${declared} was accepted`,
    )
  }
})

/* --------------------------------- the bytes, for a body with no length */

test('a streamed body with no declared length is stopped at the limit', async () => {
  /*
   * The case a `Content-Length` check cannot reach: chunked transfer, no
   * declaration, and far more bytes than the limit. The old code called
   * `formData()` on exactly this and parsed all of it.
   */
  const limit = 512
  const { request, state } = streamedRequest(FORM_MEDIA_TYPE, 256, 1000)

  const bounded = await readBoundedForm(request, limit)
  assert.deepEqual(bounded, { ok: false, reason: 'too-large' })

  assert.equal(state.cancelled, true, 'the oversized upload was drained rather than stopped')
  // 256-byte chunks against a 512-byte limit: two fit, the third passes it.
  assert.equal(state.pulls, 3, `the reader took ${state.pulls} chunks past the limit`)
  assert.ok(state.pulls * 256 <= limit + 256, 'more than one chunk past the limit was taken')
})

test('a body that lies about its length is stopped by the bytes, not the header', async () => {
  const limit = 512
  const { request } = streamedRequest(JSON_MEDIA_TYPE, 256, 1000, { 'content-length': '10' })

  // The declaration says ten bytes and passes the cheap check; the bytes
  // themselves are a quarter of a megabyte and are stopped by the count.
  assert.deepEqual(await readBoundedJson(request, limit), { ok: false, reason: 'too-large' })
})

test('a streamed body under the limit still arrives intact', async () => {
  // The positive control for the two cases above: the stream path must deliver
  // a legitimate chunked body, not merely refuse large ones.
  const { request } = streamedRequest(JSON_MEDIA_TYPE, 4, 3)
  const bounded = await readBoundedJson(request, 512)
  // Twelve bytes of `x` arrive whole, under the limit, and fail as JSON --
  // which is the point: the stream path delivered them rather than refusing.
  assert.deepEqual(bounded, { ok: false, reason: 'unreadable' })

  const good = await readBoundedJson(jsonRequest('{"op":"position"}'), 512)
  assert.equal(good.ok, true)
  assert.deepEqual(good.ok && good.value, { op: 'position' })
})

/* ------------------------------------------------------ the media types */

test('only the form encoding this site posts reaches a form parser', async () => {
  for (const type of [
    'multipart/form-data; boundary=----x',
    'text/plain',
    'application/json',
    'application/xml',
    '',
  ]) {
    const request = new Request(URL_UNDER_TEST, {
      method: 'POST',
      headers: type === '' ? {} : { 'content-type': type },
      body: 'message=hello',
    })
    const bounded = await readBoundedForm(request, 512)
    assert.deepEqual(
      bounded,
      { ok: false, reason: 'unsupported-media-type' },
      `${type || '(absent)'} reached the form parser`,
    )
  }

  // And the one that is used still works, parameters and casing included.
  const withCharset = await readBoundedForm(
    formRequest('message=hello', { 'content-type': 'Application/X-WWW-Form-UrlEncoded; charset=UTF-8' }),
    512,
  )
  assert.equal(withCharset.ok, true)
  assert.equal(withCharset.ok && withCharset.value.get('message'), 'hello')
})

test('only application/json reaches the JSON parser', async () => {
  for (const type of ['text/plain', FORM_MEDIA_TYPE, 'multipart/form-data; boundary=x', '']) {
    const request = new Request(URL_UNDER_TEST, {
      method: 'POST',
      headers: type === '' ? {} : { 'content-type': type },
      body: '{"op":"position"}',
    })
    assert.deepEqual(
      await readBoundedJson(request, 512),
      { ok: false, reason: 'unsupported-media-type' },
      `${type || '(absent)'} reached the JSON parser`,
    )
  }

  const withCharset = await readBoundedJson(
    jsonRequest('{"op":"position"}', { 'content-type': 'Application/JSON; charset=utf-8' }),
    512,
  )
  assert.equal(withCharset.ok, true)
})

test('an unsupported media type is refused without reading the body', async () => {
  const { request, state } = streamedRequest('text/plain', 256, 1000)
  assert.deepEqual(await readBoundedForm(request, 512), {
    ok: false,
    reason: 'unsupported-media-type',
  })
  assert.ok(
    state.pulls <= 1,
    `an unsupported body was read (${state.pulls} chunks) before being refused`,
  )
})

/* ----------------------------------------------------- malformed bodies */

test('a body that is the right type and the wrong shape is unreadable, not too large', async () => {
  assert.deepEqual(await readBoundedJson(jsonRequest('{ not json'), 512), {
    ok: false,
    reason: 'unreadable',
  })
})

test('an absent body is an empty one, and is not an error', async () => {
  const request = new Request(URL_UNDER_TEST, {
    method: 'POST',
    headers: { 'content-type': FORM_MEDIA_TYPE },
  })
  const bounded = await readBoundedForm(request, 512)
  assert.equal(bounded.ok, true)
  assert.deepEqual(bounded.ok && Array.from(bounded.value.keys()), [])
})
