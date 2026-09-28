import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FORM_MEDIA_TYPE,
  JSON_MEDIA_TYPE,
  readBoundedForm,
  readBoundedJson,
} from '../lib/request-bounds.ts'

/*
 * C2-4: strict UTF-8 at both form boundaries -- the raw bytes, and the bytes
 * percent-decoding produces -- and at the JSON boundary.
 *
 * The partition each parser now draws, after the media type and size bounds
 * (which are unchanged and still answer first):
 *
 *   raw bytes ill-formed                          -> unreadable
 *   form: a `%` not followed by two hex digits    -> unreadable
 *   form: percent-decoded bytes ill-formed        -> unreadable
 *   well-formed, including a literal U+FFFD       -> parsed
 *
 * The C1 state decoded forgivingly and answered `ok: true` for the first and
 * third rows, with U+FFFD standing in for the damage. No field value from a
 * refused body is echoed by any assertion here.
 */

const URL_UNDER_TEST = 'https://example.test/review/api/whatever'

function bytesOf(...parts: Array<string | number[]>): Uint8Array<ArrayBuffer> {
  const out: number[] = []
  for (const part of parts) {
    if (typeof part === 'string') out.push(...Array.from(new TextEncoder().encode(part)))
    else out.push(...part)
  }
  return new Uint8Array(out)
}

function request(type: string, body: Uint8Array<ArrayBuffer> | string): Request {
  return new Request(URL_UNDER_TEST, { method: 'POST', headers: { 'content-type': type }, body })
}

/** A body delivered in the given chunks, so a sequence can straddle a boundary. */
function chunkedRequest(type: string, chunks: Uint8Array[]): Request {
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[index])
      index += 1
    },
  })
  return new Request(URL_UNDER_TEST, {
    method: 'POST',
    headers: { 'content-type': type },
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
}

function oneBytePerChunk(bytes: Uint8Array): Uint8Array[] {
  return Array.from(bytes, (byte) => new Uint8Array([byte]))
}

/** Ill-formed raw sequences, by the class of defect. */
const RAW_ILL_FORMED: Array<[label: string, bytes: number[]]> = [
  ['lone continuation 0x80', [0x80]],
  ['lone continuation 0xBF', [0xbf]],
  ['invalid lead 0xFF', [0xff]],
  ['invalid lead 0xFE', [0xfe]],
  ['invalid lead 0xF5', [0xf5, 0x80, 0x80, 0x80]],
  ['overlong 2-byte 0xC0 0x80', [0xc0, 0x80]],
  ['overlong 2-byte 0xC1 0xBF', [0xc1, 0xbf]],
  ['overlong 3-byte', [0xe0, 0x80, 0xaf]],
  ['overlong 4-byte', [0xf0, 0x80, 0x80, 0xaf]],
  ['truncated 2-byte then ASCII', [0xc3, 0x28]],
  ['truncated 3-byte then ASCII', [0xe2, 0x82, 0x41]],
  ['truncated 4-byte then ASCII', [0xf0, 0x9f, 0x98, 0x41]],
  ['bad continuation in 3-byte', [0xe2, 0x28, 0xa1]],
  ['bad continuation in 4-byte', [0xf0, 0x28, 0x8c, 0xbc]],
  ['UTF-16 surrogate encoded', [0xed, 0xa0, 0x80]],
  ['above U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
]

/** Truncations that can only happen at the very end of a body. */
const RAW_TRUNCATED_AT_END: Array<[label: string, bytes: number[]]> = [
  ['2-byte lead at end', [0xc3]],
  ['3-byte sequence cut at end', [0xe2, 0x82]],
  ['4-byte sequence cut at end', [0xf0, 0x9f, 0x98]],
]

/** Percent-encoded ill-formed UTF-8: valid ASCII on the wire. */
const PERCENT_ILL_FORMED = [
  '%80',
  '%BF',
  '%FF',
  '%C3',
  '%C3%28',
  '%E2%82',
  '%E2%82A',
  '%E2%28%A1',
  '%F0%9F%98',
  '%C0%AF',
  '%C1%BF',
  '%E0%80%AF',
  '%F0%80%80%AF',
  '%ED%A0%80',
  '%F4%90%80%80',
  '%f5%80%80%80',
  'ok%C3', // truncated at the end of a value after valid text
]

const MALFORMED_ESCAPES = ['%', '%4', '%G1', '%4G', '%%', '%zz', 'x%', 'x%2', '%-1', '%+1']

/* ------------------------------------------------------------------ JSON */

test('C2-4 JSON: ill-formed raw UTF-8 is unreadable, before JSON.parse', async () => {
  for (const [label, bad] of [...RAW_ILL_FORMED, ...RAW_TRUNCATED_AT_END]) {
    // Inside a string value, where a forgiving decoder hid it as U+FFFD.
    const inValue = bytesOf('{"op":"position","v":"', bad, '"}')
    assert.deepEqual(
      await readBoundedJson(request(JSON_MEDIA_TYPE, inValue), 1024),
      { ok: false, reason: 'unreadable' },
      `JSON with ${label} inside a value`,
    )
  }
  // The Judge's exact control: a lone 0x80 as the whole string value.
  assert.deepEqual(
    await readBoundedJson(request(JSON_MEDIA_TYPE, bytesOf('{"v":"', [0x80], '"}')), 1024),
    { ok: false, reason: 'unreadable' },
  )
})

test('C2-4 JSON: a literal U+FFFD is content, raw or escaped', async () => {
  const raw = await readBoundedJson(request(JSON_MEDIA_TYPE, bytesOf('{"v":"a', [0xef, 0xbf, 0xbd], 'b"}')), 1024)
  assert.deepEqual(raw, { ok: true, value: { v: 'a\uFFFDb' } })
  const escaped = await readBoundedJson(request(JSON_MEDIA_TYPE, '{"v":"a\\ufffdb"}'), 1024)
  assert.deepEqual(escaped, { ok: true, value: { v: 'a\uFFFDb' } })
})

test('C2-4 JSON: valid multibyte text split byte by byte across chunks arrives whole', async () => {
  const text = '{"v":"é € 😀 \uFFFD"}'
  const bytes = new TextEncoder().encode(text)
  const bounded = await readBoundedJson(chunkedRequest(JSON_MEDIA_TYPE, oneBytePerChunk(bytes)), 1024)
  assert.deepEqual(bounded, { ok: true, value: { v: 'é € 😀 \uFFFD' } })
})

test('C2-4 JSON: an ill-formed sequence split across chunks is still refused', async () => {
  const bytes = bytesOf('{"v":"', [0xe2, 0x28, 0xa1], '"}')
  assert.deepEqual(
    await readBoundedJson(chunkedRequest(JSON_MEDIA_TYPE, oneBytePerChunk(bytes)), 1024),
    { ok: false, reason: 'unreadable' },
  )
})

test('C2-4 JSON: the exact limit holds for multibyte bodies', async () => {
  // 4-byte emoji: a body of exactly the limit is parsed, one more byte is not.
  const wrapper = '{"v":""}'
  const emoji = '😀'
  const limit = wrapper.length + 4 * 10
  const exact = `{"v":"${emoji.repeat(10)}"}`
  assert.equal(new TextEncoder().encode(exact).byteLength, limit)
  const accepted = await readBoundedJson(request(JSON_MEDIA_TYPE, exact), limit)
  assert.equal(accepted.ok, true)
  const over = `{"v":"${emoji.repeat(10)}x"}`
  assert.deepEqual(await readBoundedJson(request(JSON_MEDIA_TYPE, over), limit), {
    ok: false,
    reason: 'too-large',
  })
})

/* ------------------------------------------------------------------ forms */

test('C2-4 form: ill-formed raw UTF-8 is unreadable, in a name or a value', async () => {
  for (const [label, bad] of [...RAW_ILL_FORMED, ...RAW_TRUNCATED_AT_END]) {
    for (const [where, body] of [
      ['value', bytesOf('a=1&message=', bad)],
      ['name', bytesOf('a=1&', bad, '=x')],
    ] as const) {
      // `name` bodies end with ASCII, so an at-end truncation is not at the end
      // there; it is still ill-formed because the next byte is not a continuation.
      assert.deepEqual(
        await readBoundedForm(request(FORM_MEDIA_TYPE, body), 1024),
        { ok: false, reason: 'unreadable' },
        `form ${where} with ${label}`,
      )
    }
  }
  // The Judge's exact control: a truncated 0xC3 0x28 in a field.
  assert.deepEqual(
    await readBoundedForm(request(FORM_MEDIA_TYPE, bytesOf('message=', [0xc3, 0x28])), 1024),
    { ok: false, reason: 'unreadable' },
  )
})

test('C2-4 form: percent-encoded ill-formed UTF-8 is unreadable, in a name or a value', async () => {
  for (const encoded of PERCENT_ILL_FORMED) {
    for (const body of [`a=1&message=${encoded}`, `a=1&${encoded}=x`, `message=${encoded}&b=2`]) {
      assert.deepEqual(
        await readBoundedForm(request(FORM_MEDIA_TYPE, body), 1024),
        { ok: false, reason: 'unreadable' },
        `form with percent-encoded ${encoded}`,
      )
    }
  }
  // Half raw, half escaped: a lead byte escaped, followed by a raw non-continuation.
  assert.deepEqual(
    await readBoundedForm(request(FORM_MEDIA_TYPE, 'message=%C3é'), 1024),
    { ok: false, reason: 'unreadable' },
  )
})

test('C2-4 form: a malformed percent escape is unreadable, not a literal %', async () => {
  for (const escape of MALFORMED_ESCAPES) {
    for (const body of [`message=${escape}`, `${escape}=x`, `a=1&message=${escape}&b=2`]) {
      assert.deepEqual(
        await readBoundedForm(request(FORM_MEDIA_TYPE, body), 1024),
        { ok: false, reason: 'unreadable' },
        `form with escape ${JSON.stringify(escape)}`,
      )
    }
  }
})

test('C2-4 form: a literal U+FFFD is content, raw or percent-encoded', async () => {
  for (const body of [bytesOf('message=a', [0xef, 0xbf, 0xbd], 'b'), bytesOf('message=a%EF%BF%BDb'), bytesOf('message=a%ef%bf%bdb')]) {
    const bounded = await readBoundedForm(request(FORM_MEDIA_TYPE, body), 1024)
    assert.equal(bounded.ok, true, 'a well-formed U+FFFD was refused')
    assert.equal(bounded.ok && bounded.value.get('message'), 'a\uFFFDb')
  }
})

test('C2-4 form: well-formed bodies parse exactly as the standard parser does', async () => {
  /*
   * The differential control. For every well-formed body, the strict parser's
   * entries must equal URLSearchParams' -- so the strictness adds refusals and
   * changes nothing that was already correct: `+` is a space, `%2B` is a plus,
   * empty sequences are skipped, a bare name has an empty value, duplicates and
   * order survive.
   */
  const bodies = [
    'email=a%40example.test&message=hello+world',
    'message=1%2B1%3D2',
    'a=1&&b=2&',
    'flag&x=',
    'k=v1&k=v2&k=v3',
    'name=Ren%C3%A9e&note=%E2%82%AC5+%F0%9F%98%80',
    'name=Renée&note=€5 😀',
    'mixed=%C3%A9é%E2%82%AC€',
    'eq=a%3Db=c',
    'empty=&=novalue',
    '',
  ]
  for (const body of bodies) {
    const bounded = await readBoundedForm(request(FORM_MEDIA_TYPE, body), 1024)
    assert.equal(bounded.ok, true, `a well-formed body was refused (#${bodies.indexOf(body)})`)
    if (!bounded.ok) continue
    assert.deepEqual(
      Array.from(bounded.value.entries()),
      Array.from(new URLSearchParams(body).entries()),
      `entries differ from the standard parser (#${bodies.indexOf(body)})`,
    )
  }
})

test('C2-4 form: valid multibyte text split byte by byte across chunks arrives whole', async () => {
  const bytes = new TextEncoder().encode('message=é € 😀 \uFFFD&code=%F0%9F%98%80')
  const bounded = await readBoundedForm(chunkedRequest(FORM_MEDIA_TYPE, oneBytePerChunk(bytes)), 1024)
  assert.equal(bounded.ok, true)
  assert.equal(bounded.ok && bounded.value.get('message'), 'é € 😀 \uFFFD')
  assert.equal(bounded.ok && bounded.value.get('code'), '😀')
})

test('C2-4 form: an ill-formed sequence split across chunks is still refused', async () => {
  const bytes = bytesOf('message=ok', [0xf0, 0x28, 0x8c, 0xbc])
  assert.deepEqual(
    await readBoundedForm(chunkedRequest(FORM_MEDIA_TYPE, oneBytePerChunk(bytes)), 1024),
    { ok: false, reason: 'unreadable' },
  )
})

test('C2-4 form: the exact limit holds for multibyte bodies', async () => {
  const prefix = 'message='
  const limit = prefix.length + 3 * 20
  const exact = `${prefix}${'€'.repeat(20)}`
  assert.equal(new TextEncoder().encode(exact).byteLength, limit)
  const accepted = await readBoundedForm(request(FORM_MEDIA_TYPE, exact), limit)
  assert.equal(accepted.ok, true)
  assert.equal(accepted.ok && accepted.value.get('message'), '€'.repeat(20))
  assert.deepEqual(await readBoundedForm(request(FORM_MEDIA_TYPE, `${exact}x`), limit), {
    ok: false,
    reason: 'too-large',
  })
})

test('C2-4 the earlier checks still answer first', async () => {
  // Media type before bytes; size before decoding. An ill-formed body of the
  // wrong type is unsupported, and an ill-formed body over the limit is too
  // large -- neither is decoded at all.
  const bad = bytesOf('message=', [0x80])
  assert.deepEqual(await readBoundedForm(request('text/plain', bad), 1024), {
    ok: false,
    reason: 'unsupported-media-type',
  })
  assert.deepEqual(await readBoundedForm(request(FORM_MEDIA_TYPE, bad), 4), {
    ok: false,
    reason: 'too-large',
  })
  assert.deepEqual(await readBoundedJson(request(JSON_MEDIA_TYPE, bytesOf('{"v":"', [0x80], '"}')), 4), {
    ok: false,
    reason: 'too-large',
  })
})
