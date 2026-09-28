import test from 'node:test'
import assert from 'node:assert/strict'

import { isSameOriginRequest } from '../lib/request-origin.ts'

/*
 * C2-5 at the predicate: one canonical serialized Origin, equal to the
 * request's own scheme (from the request URL), host and effective port (from
 * `Host`).
 *
 * The partition:
 *
 *   Origin absent, empty, `null`, several, malformed, non-http(s)   -> refused
 *   Origin parseable but not canonical (path, query, fragment,
 *     credentials, trailing slash, explicit default port, case)     -> refused
 *   canonical, and scheme, host or effective port differs           -> refused
 *   canonical, and all three equal                                  -> accepted
 *
 * and on the target side: a missing or unusable `Host` refuses, and
 * `x-forwarded-host` / `x-forwarded-proto` are never a second way to match.
 * `tests/public-write-boundary.test.ts` drives the same cases through the
 * authenticated reviewer handler.
 */

type Target = { url: string; host: string | null; extra?: Record<string, string> }

const PRODUCTION: Target = { url: 'https://reader.example.test/review/api/reading', host: 'reader.example.test' }
const LOCALHOST: Target = { url: 'http://localhost:3000/review/api/reading', host: 'localhost:3000' }
/** `next start -H 0.0.0.0`: the URL names the bind address, `Host` the LAN one. */
const LAN: Target = { url: 'http://0.0.0.0:3000/review/api/reading', host: '192.168.1.111:3000' }
const CUSTOM_PORT: Target = {
  url: 'https://reader.example.test:8443/review/api/reading',
  host: 'reader.example.test:8443',
}
const IPV6: Target = { url: 'http://[::1]:3000/review/api/reading', host: '[::1]:3000' }

function requestFor(target: Target, origin: string | null): Request {
  const headers = new Headers()
  if (target.host !== null) headers.set('host', target.host)
  if (origin !== null) headers.set('origin', origin)
  for (const [name, value] of Object.entries(target.extra ?? {})) headers.set(name, value)
  return new Request(target.url, { method: 'POST', headers })
}

const ACCEPTED: Array<[label: string, target: Target, origin: string]> = [
  ['HTTPS production-like host', PRODUCTION, 'https://reader.example.test'],
  ['localhost with port', LOCALHOST, 'http://localhost:3000'],
  ['LAN address behind a 0.0.0.0 bind', LAN, 'http://192.168.1.111:3000'],
  ['custom HTTPS port', CUSTOM_PORT, 'https://reader.example.test:8443'],
  ['IPv6 loopback', IPV6, 'http://[::1]:3000'],
  [
    'Host naming the default port explicitly',
    { url: PRODUCTION.url, host: 'reader.example.test:443' },
    'https://reader.example.test',
  ],
  [
    'upper-case Host (the parser lower-cases it)',
    { url: PRODUCTION.url, host: 'Reader.Example.Test' },
    'https://reader.example.test',
  ],
]

const REFUSED: Array<[label: string, target: Target, origin: string | null]> = [
  // scheme
  ['wrong scheme (http for https)', PRODUCTION, 'http://reader.example.test'],
  ['wrong scheme (https for http)', LOCALHOST, 'https://localhost:3000'],
  // host
  ['wrong host', PRODUCTION, 'https://attacker.test'],
  ['sibling host', PRODUCTION, 'https://evil.example.test'],
  ['parent domain', PRODUCTION, 'https://example.test'],
  ['lookalike suffix', PRODUCTION, 'https://reader.example.test.attacker.test'],
  ['bind address instead of LAN host', LAN, 'http://0.0.0.0:3000'],
  // port
  ['wrong port (explicit where none)', PRODUCTION, 'https://reader.example.test:8443'],
  ['wrong port (none where explicit)', CUSTOM_PORT, 'https://reader.example.test'],
  ['wrong port (adjacent)', LOCALHOST, 'http://localhost:3001'],
  ['wrong port (80 over https)', PRODUCTION, 'https://reader.example.test:80'],
  // not a serialized origin
  ['credentials', PRODUCTION, 'https://user:pw@reader.example.test'],
  ['username only', PRODUCTION, 'https://user@reader.example.test'],
  ['path', PRODUCTION, 'https://reader.example.test/not-an-origin'],
  ['trailing slash', PRODUCTION, 'https://reader.example.test/'],
  ['query', PRODUCTION, 'https://reader.example.test?x=1'],
  ['path and query', PRODUCTION, 'https://reader.example.test/?x=1'],
  ['fragment', PRODUCTION, 'https://reader.example.test#frag'],
  ['explicit default port', PRODUCTION, 'https://reader.example.test:443'],
  ['upper case', PRODUCTION, 'https://Reader.example.test'],
  ['internal space', PRODUCTION, 'https://reader.example .test'],
  // absent, opaque, malformed, plural, other schemes
  ['missing', PRODUCTION, null],
  ['empty', PRODUCTION, ''],
  ['opaque null', PRODUCTION, 'null'],
  ['malformed', PRODUCTION, 'not a url'],
  ['bare host', PRODUCTION, 'reader.example.test'],
  ['scheme-relative', PRODUCTION, '//reader.example.test'],
  ['empty authority', PRODUCTION, 'https://'],
  ['multiple origins, comma', PRODUCTION, 'https://reader.example.test, https://reader.example.test'],
  ['multiple origins, space', PRODUCTION, 'https://reader.example.test https://attacker.test'],
  ['non-http scheme', PRODUCTION, 'ftp://reader.example.test'],
  ['file scheme', PRODUCTION, 'file://'],
  ['extension scheme', PRODUCTION, 'chrome-extension://abcdef'],
]

/** Cases where the Origin is fine and the target side is what refuses. */
const TARGET_REFUSED: Array<[label: string, target: Target, origin: string]> = [
  ['no Host header', { url: PRODUCTION.url, host: null }, 'https://reader.example.test'],
  ['Host with userinfo', { url: PRODUCTION.url, host: 'user@reader.example.test' }, 'https://reader.example.test'],
  ['Host with a path', { url: PRODUCTION.url, host: 'reader.example.test/x' }, 'https://reader.example.test'],
  ['Host list', { url: PRODUCTION.url, host: 'reader.example.test, attacker.test' }, 'https://reader.example.test'],
  [
    'x-forwarded-host is not a second host',
    { url: PRODUCTION.url, host: 'internal.local', extra: { 'x-forwarded-host': 'reader.example.test' } },
    'https://reader.example.test',
  ],
  [
    'x-forwarded-proto is not a second scheme',
    { url: LOCALHOST.url, host: 'localhost:3000', extra: { 'x-forwarded-proto': 'https' } },
    'https://localhost:3000',
  ],
]

test('C2-5 predicate: canonical same-origin requests are accepted', () => {
  for (const [label, target, origin] of ACCEPTED) {
    assert.equal(isSameOriginRequest(requestFor(target, origin)), true, `${label} was refused`)
  }
})

test('C2-5 predicate: every non-canonical or unequal Origin is refused', () => {
  for (const [label, target, origin] of REFUSED) {
    assert.equal(isSameOriginRequest(requestFor(target, origin)), false, `${label} was accepted`)
  }
})

test('C2-5 predicate: an unusable target, or a forwarded header, never produces a match', () => {
  for (const [label, target, origin] of TARGET_REFUSED) {
    assert.equal(isSameOriginRequest(requestFor(target, origin)), false, `${label} was accepted`)
  }
})
