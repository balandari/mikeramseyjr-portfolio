import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

/*
 * What the five public write endpoints do with a body they must not accept
 * (F6), and what the reviewer mutation does with a request from somewhere else
 * (F7).
 *
 * The two findings share one acceptance condition, which is the reason they
 * share a file: **a refused request performs no side effect.** Not a store
 * read, not a limiter write, not a mail send, not a session mint, not a
 * business mutation. Bounding a body after `formData()` has already run, or
 * checking an origin after `readingPost` has already written, would satisfy a
 * status-code test and close neither finding.
 *
 * ## How it is proved
 *
 * A resolve hook points every side-effecting module each route imports at a
 * double that records the call and then throws. Throwing matters: it means a
 * route that reaches one of them cannot quietly continue and return the status
 * the test expected anyway. So each case asserts two things -- the answer the
 * caller gets, and an empty ledger -- and the second is the one the finding is
 * about.
 *
 * The routes themselves are the real modules, and so are `lib/request-bounds.ts`
 * and `lib/request-origin.ts`. Only the things a refusal must never reach are
 * replaced.
 *
 * `node --test` gives each file its own process, so the hook registered here is
 * local to this file.
 */

type Ledger = { calls: string[] }

declare global {
  // eslint-disable-next-line no-var
  var __routeLedger: Ledger | undefined
  // eslint-disable-next-line no-var
  var __reviewerContext: (() => Promise<unknown>) | undefined
}

const ledger: Ledger = { calls: [] }
globalThis.__routeLedger = ledger

const inlineModule = (source: string) =>
  `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`

/**
 * One recorded, refusing function.
 *
 * Every double below is built from this, so "the ledger is empty" is the same
 * statement about all of them and there is no double that records without
 * refusing.
 */
const SPY = `
const record = (name) => (...args) => {
  globalThis.__routeLedger.calls.push(name)
  throw new Error('a refused request reached ' + name)
}
`

/* The side-effecting modules, replaced. Everything else stays real. */
const DOUBLES: Record<string, string> = {
  '@/lib/private-store': `
${SPY}
export const createPrivateStore = record('private-store.createPrivateStore')
// Not a side effect: it reads an environment variable and decides nothing.
// The routes consult it before the body, and it must answer honestly or the
// fail-closed branch would hide the bound being tested.
export const hasAuthSecret = () => true
`,
  '@/lib/rate-limit': `
${SPY}
export const RULES = {
  requestByClient: { name: 'requestByClient' },
  requestByAddress: { name: 'requestByAddress' },
  signinByClient: { name: 'signinByClient' },
  signinByAddress: { name: 'signinByAddress' },
}
export const clientKey = record('rate-limit.clientKey')
export const limiterReady = record('rate-limit.limiterReady')
export const recordAndCheck = record('rate-limit.recordAndCheck')
export const allowCredentialAttempt = record('rate-limit.allowCredentialAttempt')
`,
  '@/lib/reviewer-onboarding': `
${SPY}
export const submitAccessRequest = record('onboarding.submitAccessRequest')
export const requestSigninLink = record('onboarding.requestSigninLink')
export const activateWithCredential = record('onboarding.activateWithCredential')
export const signinWithCredential = record('onboarding.signinWithCredential')
`,
  '@/lib/reviewer-access': `
${SPY}
export const mintReviewerToken = record('access.mintReviewerToken')
export const reviewerCookie = record('access.reviewerCookie')
`,
  '@/lib/reviewer-authorization': `
${SPY}
export const identifyReviewerFromStore = record('authorization.identifyReviewerFromStore')
export const isReviewerAccessLive = record('authorization.isReviewerAccessLive')
`,
  '@/lib/reading-api': `
${SPY}
export const readingGet = record('reading-api.readingGet')
export const readingPost = record('reading-api.readingPost')
export const readingDelete = record('reading-api.readingDelete')
`,
  '@/lib/reading-session': `
export const reviewerContext = (...args) => globalThis.__reviewerContext(...args)
`,
}

register(
  inlineModule(`
const doubles = ${JSON.stringify(
    Object.fromEntries(Object.entries(DOUBLES).map(([name, source]) => [name, inlineModule(source)])),
  )}
export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(doubles, specifier)) {
    return { url: doubles[specifier], shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
`),
)

/** A signed-in reviewer, so the origin and bound checks are what decides. */
globalThis.__reviewerContext = async () => ({
  viewer: { kind: 'reviewer', id: 'anna', books: ['the-backward-becoming'] },
})

const SITE = 'https://reader.example.test'
const FORM_TYPE = 'application/x-www-form-urlencoded'

function clear(): void {
  ledger.calls = []
}

/** A body of exactly `bytes` bytes in one urlencoded field. */
function formBody(bytes: number, field = 'code'): string {
  const prefix = `${field}=`
  return prefix + 'x'.repeat(bytes - prefix.length)
}

function formRequest(path: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`${SITE}${path}`, {
    method: 'POST',
    headers: { 'content-type': FORM_TYPE, host: 'reader.example.test', ...headers },
    body,
  })
}

function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request(`${SITE}/review/api/reading`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host: 'reader.example.test',
      origin: SITE,
      ...headers,
    },
    body,
  })
}

/* ================================================================ F6: forms */

type FormRoute = {
  name: string
  path: string
  module: string
  /** The limit this route is given, from `lib/request-bounds.ts`. */
  limit: number
  /**
   * A field this route reads before it reaches anything recorded.
   *
   * The positive control needs a body the route's own validation will carry
   * past, or it would pass for the wrong reason: `/review/api/credential`
   * refuses a submission with no `token` before it opens the store, and an
   * empty ledger would then say nothing about the bound.
   */
  field: string
}

const FORM_ROUTES: FormRoute[] = []

test('the four public form endpoints are bounded before they parse', async () => {
  const bounds = await import('../lib/request-bounds.ts')
  FORM_ROUTES.push(
    {
      name: 'request',
      path: '/review/api/request',
      module: '../app/review/api/request/route.ts',
      limit: bounds.REQUEST_FORM_LIMIT_BYTES,
      field: 'email',
    },
    {
      name: 'signin',
      path: '/review/api/signin',
      module: '../app/review/api/signin/route.ts',
      limit: bounds.SIGNIN_FORM_LIMIT_BYTES,
      field: 'email',
    },
    {
      name: 'credential',
      path: '/review/api/credential',
      module: '../app/review/api/credential/route.ts',
      limit: bounds.CREDENTIAL_FORM_LIMIT_BYTES,
      field: 'token',
    },
    {
      name: 'unlock',
      path: '/review/api/unlock',
      module: '../app/review/api/unlock/route.ts',
      limit: bounds.UNLOCK_FORM_LIMIT_BYTES,
      field: 'code',
    },
  )

  for (const route of FORM_ROUTES) {
    const { POST } = (await import(route.module)) as unknown as {
      POST: (request: Request) => Promise<Response>
    }

    /* ---- one byte over the limit, declared honestly ---- */
    clear()
    const over = await POST(formRequest(route.path, formBody(route.limit + 1, route.field)))
    assert.ok(
      over.status >= 300 && over.status < 400,
      `${route.name}: an oversized body was not refused (${over.status})`,
    )
    assert.deepEqual(
      ledger.calls,
      [],
      `${route.name}: an oversized body reached ${ledger.calls.join(', ')}`,
    )

    /* ---- an unsupported media type ---- */
    clear()
    const wrongType = await POST(
      formRequest(route.path, 'code=short', { 'content-type': 'text/plain' }),
    )
    assert.ok(
      wrongType.status >= 300 && wrongType.status < 400,
      `${route.name}: text/plain was not refused (${wrongType.status})`,
    )
    assert.deepEqual(
      ledger.calls,
      [],
      `${route.name}: text/plain reached ${ledger.calls.join(', ')}`,
    )

    /* ---- an oversized declaration, before the stream is read ---- */
    clear()
    const declared = await POST(
      formRequest(route.path, 'code=short', {
        'content-length': String(50 * 1024 * 1024),
      }),
    )
    assert.ok(declared.status >= 300 && declared.status < 400, `${route.name}: declaration`)
    assert.deepEqual(
      ledger.calls,
      [],
      `${route.name}: an oversized declaration reached ${ledger.calls.join(', ')}`,
    )
  }
})

test('a body of exactly the limit is not refused by the bound', async () => {
  /*
   * The positive control. Every case above asserts that something did **not**
   * happen, and a route that refused everything would pass all of them. At
   * exactly the limit the bound must let go, and the request must get far
   * enough to reach the first thing a real submission reaches -- which, with
   * these doubles in place, is a recorded call.
   */
  for (const route of FORM_ROUTES) {
    const { POST } = (await import(route.module)) as unknown as {
      POST: (request: Request) => Promise<Response>
    }
    clear()
    await POST(formRequest(route.path, formBody(route.limit, route.field))).catch(() => undefined)
    assert.ok(
      ledger.calls.length > 0,
      `${route.name}: a body of exactly the limit was refused by the bound`,
    )
  }
})

/* ========================================================= F6 + F7: reading */

async function readingPost(request: Request): Promise<Response> {
  const { POST } = (await import('../app/review/api/reading/route.ts')) as unknown as {
    POST: (request: Request) => Promise<Response>
  }
  return POST(request)
}

test('F7: a reviewer POST without an Origin is refused and writes nothing', async () => {
  clear()
  const request = new Request(`${SITE}/review/api/reading`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'reader.example.test' },
    body: '{"op":"position"}',
  })
  const response = await readingPost(request)

  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'forbidden_origin' })
  assert.deepEqual(ledger.calls, [], `a refused POST reached ${ledger.calls.join(', ')}`)
})

test('F7: a cross-origin and a same-site sibling origin are both refused', async () => {
  /*
   * The sibling is the finding. `SameSite=Lax` is site-based, so a page on
   * `evil.example.test` is same-site with `reader.example.test`, does get the
   * reviewer cookie attached, and reached this endpoint before this check
   * existed. An unrelated domain was already refused by the cookie; a sibling
   * was not.
   */
  for (const origin of [
    'https://evil.example.test', // same site, different origin -- the finding
    'https://attacker.test', // plainly cross-site
    'https://reader.example.test.attacker.test', // a suffix that looks like ours
    'https://reader.example.test:8443', // same host, different port
    'null', // an opaque origin, from a sandboxed frame
    'not a url', // malformed
    '', // present and empty
  ]) {
    clear()
    const response = await readingPost(jsonRequest('{"op":"position"}', { origin }))
    assert.equal(response.status, 403, `origin ${origin || '(empty)'} was accepted`)
    assert.deepEqual(
      ledger.calls,
      [],
      `origin ${origin || '(empty)'} reached ${ledger.calls.join(', ')}`,
    )
  }
})

test('F7: a valid same-origin JSON POST still reaches the service', async () => {
  // The positive control for every refusal above.
  clear()
  await readingPost(jsonRequest('{"op":"position"}')).catch(() => undefined)
  assert.deepEqual(
    ledger.calls,
    ['reading-api.readingPost'],
    'a legitimate reviewer save no longer reaches the service',
  )
})

test('F7: the origin is checked before the body is parsed', async () => {
  /*
   * Ordering, not just presence. A malformed body with a bad origin must answer
   * for the origin: if the parse ran first the caller would learn that its body
   * was the problem, which is a probe a cross-origin page should not be able to
   * run.
   */
  clear()
  const response = await readingPost(
    jsonRequest('{ not json at all', { origin: 'https://evil.example.test' }),
  )
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'forbidden_origin' })
  assert.deepEqual(ledger.calls, [])
})

test('F6: an oversized reviewer JSON body is 413 and writes nothing', async () => {
  const { READING_JSON_LIMIT_BYTES } = await import('../lib/request-bounds.ts')
  clear()

  const body = `{"op":"note-create","body":"${'x'.repeat(READING_JSON_LIMIT_BYTES)}"}`
  const response = await readingPost(jsonRequest(body))

  assert.equal(response.status, 413)
  assert.deepEqual(await response.json(), { error: 'too_large' })
  assert.deepEqual(ledger.calls, [], `an oversized body reached ${ledger.calls.join(', ')}`)
})

test('F6: a reviewer JSON POST sent as text/plain is 415 and writes nothing', async () => {
  clear()
  const response = await readingPost(
    jsonRequest('{"op":"position"}', { 'content-type': 'text/plain' }),
  )

  assert.equal(response.status, 415)
  assert.deepEqual(await response.json(), { error: 'unsupported_media_type' })
  assert.deepEqual(ledger.calls, [])
})

test('F6: a JSON body that is not an object is 400 and writes nothing', async () => {
  for (const body of ['[]', '"a string"', '12', 'null', '{ not json']) {
    clear()
    const response = await readingPost(jsonRequest(body))
    assert.equal(response.status, 400, `${body} was accepted`)
    assert.deepEqual(await response.json(), { error: 'bad_request' })
    assert.deepEqual(ledger.calls, [], `${body} reached ${ledger.calls.join(', ')}`)
  }
})

test('an unauthenticated POST is still refused before anything else', async () => {
  // Unchanged behaviour, asserted so the new checks cannot be read as having
  // replaced the session check rather than joined it.
  globalThis.__reviewerContext = async () => null
  try {
    clear()
    const response = await readingPost(jsonRequest('{"op":"position"}'))
    assert.equal(response.status, 401)
    assert.deepEqual(ledger.calls, [])
  } finally {
    globalThis.__reviewerContext = async () => ({
      viewer: { kind: 'reviewer', id: 'anna', books: ['the-backward-becoming'] },
    })
  }
})

/* ============================================ C2-4: strict UTF-8, handlers */

/*
 * Each of the five POST endpoints, given a body that passes the media-type and
 * size checks and is not well-formed UTF-8 -- raw, or percent-encoded in a
 * form -- must answer its generic refusal with an empty ledger: no store, no
 * limiter, no mail, no session, no business call. The positive controls below
 * prove the same routes still carry a well-formed literal U+FFFD and a
 * multibyte body of exactly the limit through to the first recorded call.
 */

function bytes(...parts: Array<string | number[]>): Uint8Array<ArrayBuffer> {
  const out: number[] = []
  for (const part of parts) {
    if (typeof part === 'string') out.push(...Array.from(new TextEncoder().encode(part)))
    else out.push(...part)
  }
  return new Uint8Array(out)
}

function rawFormRequest(path: string, body: Uint8Array<ArrayBuffer>): Request {
  return new Request(`${SITE}${path}`, {
    method: 'POST',
    headers: { 'content-type': FORM_TYPE, host: 'reader.example.test' },
    body,
  })
}

/** Ill-formed bodies for a form route, labelled by class. `field` is the route's own. */
function illFormedForms(field: string): Array<[label: string, body: Uint8Array<ArrayBuffer>]> {
  return [
    ['invalid leading byte', bytes(`${field}=`, [0x80])],
    ['invalid lead 0xFF', bytes(`${field}=ok`, [0xff])],
    ['truncated sequence', bytes(`${field}=`, [0xc3, 0x28])],
    ['truncated at end', bytes(`${field}=`, [0xe2, 0x82])],
    ['bad continuation', bytes(`${field}=`, [0xe2, 0x28, 0xa1])],
    ['overlong', bytes(`${field}=`, [0xc0, 0xaf])],
    ['percent-encoded invalid', bytes(`${field}=%80`)],
    ['percent-encoded truncated', bytes(`${field}=%C3%28`)],
    ['percent-encoded overlong', bytes(`${field}=%C0%AF`)],
    ['percent-encoded surrogate', bytes(`${field}=%ED%A0%80`)],
    ['malformed percent escape', bytes(`${field}=%G1`)],
    ['bare percent', bytes(`${field}=%`)],
  ]
}

test('C2-4: ill-formed UTF-8 on every form endpoint is refused with zero calls', async () => {
  assert.equal(FORM_ROUTES.length, 4, 'the form route table was not populated')
  for (const route of FORM_ROUTES) {
    const { POST } = (await import(route.module)) as unknown as {
      POST: (request: Request) => Promise<Response>
    }
    for (const [label, body] of illFormedForms(route.field)) {
      clear()
      const response = await POST(rawFormRequest(route.path, body))
      assert.ok(
        response.status >= 300 && response.status < 400,
        `${route.name}: ${label} was not refused (${response.status})`,
      )
      assert.deepEqual(
        ledger.calls,
        [],
        `${route.name}: ${label} reached ${ledger.calls.join(', ')}`,
      )
    }
  }
})

test('C2-4: a well-formed U+FFFD and an exact-limit multibyte body still reach each form route', async () => {
  for (const route of FORM_ROUTES) {
    const { POST } = (await import(route.module)) as unknown as {
      POST: (request: Request) => Promise<Response>
    }
    for (const [label, body] of [
      ['raw U+FFFD', bytes(`${route.field}=a`, [0xef, 0xbf, 0xbd], 'b')],
      ['percent-encoded U+FFFD', bytes(`${route.field}=a%EF%BF%BDb`)],
    ] as const) {
      clear()
      await POST(rawFormRequest(route.path, body)).catch(() => undefined)
      assert.ok(ledger.calls.length > 0, `${route.name}: ${label} was refused`)
    }

    // Exactly the limit in bytes, made of 3-byte characters where it fits.
    const prefix = `${route.field}=`
    const room = route.limit - prefix.length
    const exact = bytes(prefix, '€'.repeat(Math.floor(room / 3)), 'x'.repeat(room % 3))
    assert.equal(exact.byteLength, route.limit)
    clear()
    await POST(rawFormRequest(route.path, exact)).catch(() => undefined)
    assert.ok(ledger.calls.length > 0, `${route.name}: an exact-limit multibyte body was refused`)

    clear()
    const over = await POST(rawFormRequest(route.path, bytes(prefix, '€'.repeat(Math.floor(room / 3)), 'x'.repeat(room % 3), 'x')))
    assert.ok(over.status >= 300 && over.status < 400, `${route.name}: limit + 1 was accepted`)
    assert.deepEqual(ledger.calls, [], `${route.name}: limit + 1 reached ${ledger.calls.join(', ')}`)
  }
})

test('C2-4: ill-formed UTF-8 on the reviewer JSON endpoint is 400 with zero calls', async () => {
  for (const [label, bad] of [
    ['invalid leading byte', [0x80]],
    ['truncated sequence', [0xc3, 0x28]],
    ['truncated at end of value', [0xe2, 0x82]],
    ['bad continuation', [0xf0, 0x28, 0x8c, 0xbc]],
    ['overlong', [0xe0, 0x80, 0xaf]],
    ['surrogate', [0xed, 0xa0, 0x80]],
  ] as const) {
    clear()
    const response = await readingPost(
      new Request(`${SITE}/review/api/reading`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'reader.example.test',
          origin: SITE,
        },
        body: bytes('{"op":"position","v":"', [...bad], '"}'),
      }),
    )
    assert.equal(response.status, 400, `${label} was accepted`)
    assert.deepEqual(await response.json(), { error: 'bad_request' })
    assert.deepEqual(ledger.calls, [], `${label} reached ${ledger.calls.join(', ')}`)
  }
})

test('C2-4: a well-formed U+FFFD in reviewer JSON reaches the service exactly once', async () => {
  clear()
  await readingPost(
    new Request(`${SITE}/review/api/reading`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'reader.example.test', origin: SITE },
      body: bytes('{"op":"position","v":"a', [0xef, 0xbf, 0xbd], 'b"}'),
    }),
  ).catch(() => undefined)
  assert.deepEqual(ledger.calls, ['reading-api.readingPost'])
})

/* ============================================= C2-5: Origin, at the handler */

/*
 * The authenticated reviewer POST, with a signed-in reviewer, driven through
 * the real route and the real predicate. Every refusal is 403 with an empty
 * ledger; every accepted case reaches `readingPost` exactly once. The target's
 * scheme is the request URL's and its host and port are `Host`'s, so the valid
 * cases include a LAN host behind a `0.0.0.0` bind and a custom port.
 */

function originRequest(url: string, host: string | null, origin: string | null, extra: Record<string, string> = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extra }
  if (host !== null) headers.host = host
  if (origin !== null) headers.origin = origin
  return new Request(url, { method: 'POST', headers, body: '{"op":"position"}' })
}

const PROD_URL = `${SITE}/review/api/reading`
const PROD_HOST = 'reader.example.test'

test('C2-5 handler: valid same-origin JSON reaches the service exactly once', async () => {
  for (const [label, url, host, origin] of [
    ['HTTPS production-like', PROD_URL, PROD_HOST, SITE],
    ['localhost', 'http://localhost:3000/review/api/reading', 'localhost:3000', 'http://localhost:3000'],
    ['LAN host behind a 0.0.0.0 bind', 'http://0.0.0.0:3000/review/api/reading', '192.168.1.111:3000', 'http://192.168.1.111:3000'],
    ['custom port', 'https://reader.example.test:8443/review/api/reading', 'reader.example.test:8443', 'https://reader.example.test:8443'],
  ] as const) {
    clear()
    await readingPost(originRequest(url, host, origin)).catch(() => undefined)
    assert.deepEqual(ledger.calls, ['reading-api.readingPost'], `${label} did not reach the service exactly once`)
  }
})

test('C2-5 handler: every wrong or non-canonical Origin is 403 and writes nothing', async () => {
  for (const [label, origin] of [
    ['wrong scheme', 'http://reader.example.test'],
    ['wrong host', 'https://attacker.test'],
    ['wrong port', 'https://reader.example.test:8443'],
    ['sibling host', 'https://evil.example.test'],
    ['credentials', 'https://user:pw@reader.example.test'],
    ['path', 'https://reader.example.test/not-an-origin'],
    ['query', 'https://reader.example.test/?x=1'],
    ['fragment', 'https://reader.example.test#frag'],
    ['explicit default port', 'https://reader.example.test:443'],
    ['opaque null', 'null'],
    ['missing', null],
    ['malformed', 'not a url'],
    ['multiple origins', `${SITE}, ${SITE}`],
  ] as const) {
    clear()
    const response = await readingPost(originRequest(PROD_URL, PROD_HOST, origin))
    assert.equal(response.status, 403, `${label} was accepted`)
    assert.deepEqual(await response.json(), { error: 'forbidden_origin' })
    assert.deepEqual(ledger.calls, [], `${label} reached ${ledger.calls.join(', ')}`)
  }
})

test('C2-5 handler: an https Origin to a plain-http request, and forwarded headers, are refused', async () => {
  for (const [label, request] of [
    ['https Origin, http request', originRequest('http://localhost:3000/review/api/reading', 'localhost:3000', 'https://localhost:3000')],
    ['wrong port on localhost', originRequest('http://localhost:3000/review/api/reading', 'localhost:3000', 'http://localhost:3001')],
    ['x-forwarded-host as a second host', originRequest(PROD_URL, 'internal.local', SITE, { 'x-forwarded-host': PROD_HOST })],
    ['x-forwarded-proto as a second scheme', originRequest('http://localhost:3000/review/api/reading', 'localhost:3000', 'https://localhost:3000', { 'x-forwarded-proto': 'https' })],
    ['no Host', originRequest(PROD_URL, null, SITE)],
  ] as const) {
    clear()
    const response = await readingPost(request)
    assert.equal(response.status, 403, `${label} was accepted`)
    assert.deepEqual(ledger.calls, [], `${label} reached ${ledger.calls.join(', ')}`)
  }
})
