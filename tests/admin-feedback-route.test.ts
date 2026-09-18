import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

/*
 * `/admin/api/feedback`, imported and called.
 *
 * The **real** POST handler runs here: the session check against a genuinely
 * minted token, the genuine CSRF derivation, the body bound, the intent switch,
 * the committed metadata writes and the committed export. Only `next/headers`
 * is replaced, because `cookies()` needs a request store that only a Next
 * server creates.
 *
 * What this file is trying to break, stated plainly:
 *
 *   **The author gate.** A reviewer and an anonymous caller must be refused
 *   before a prefix is built or a store is touched.
 *
 *   **The separation of triage from reading.** Resolving must not mark read;
 *   exporting must not resolve, must not mark read, and must not touch a
 *   reviewer's bytes; and no listing of any kind may write.
 *
 *   **The saved-view ownership rule.** One document, named by a constant, never
 *   one per book the view mentions.
 *
 *   **The closed error vocabulary.** No storage path, address, token or
 *   provider message may appear in any response body, successful or refused.
 */

register('./helpers/author-route-hooks.mjs', import.meta.url)

import { MAX_VIEW_CHAPTERS, SAVED_VIEW_HOME_SLUG } from '../lib/author-metadata.ts'

const ROOT = pathToFileURL(join(process.cwd(), '/')).href

const ADMIN = 'mike@example.com'
const BOOK = 'the-backward-becoming'
const OTHER_BOOK = 'persistent'
const CHAPTER = 'chapter-one'

const ROSTER = JSON.stringify([
  { id: 'anna', name: 'Anna Reviewer', books: [BOOK], codeHash: 'a'.repeat(64) },
])

declare global {
  // eslint-disable-next-line no-var
  var __adminCookies: Record<string, string> | undefined
  // eslint-disable-next-line no-var
  var __requestHeaders: Record<string, string> | undefined
}

const KEYS = [
  'ADMIN_AUTH_SECRET',
  'ADMIN_ALLOWED_EMAILS',
  'REVIEWER_AUTH_SECRET',
  'REVIEWER_FEEDBACK_DRIVER',
  'REVIEWER_FEEDBACK_DIR',
  'REVIEWER_READING_DIR',
  'REVIEWER_ROSTER_DRIVER',
  'REVIEWER_ROSTER',
] as const

let dir = ''
let reading = ''
let token = ''
let csrf = ''
let authorId = ''
let POST: (request: Request) => Promise<Response>

let metadataPath: (authorId: string, bookSlug: string) => string
let metadataPrefix: (authorId: string) => string
let resetStores: () => void
let createNote: typeof import('../lib/note-service.ts').createNote

const saved = new Map<string, string | undefined>()

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mrj-feedback-route-'))
  reading = join(dir, 'reading')
  const feedback = join(dir, 'feedback')
  mkdirSync(feedback, { recursive: true })

  for (const key of KEYS) saved.set(key, process.env[key])
  process.env.ADMIN_AUTH_SECRET = 'admin-secret-for-tests-only-not-a-real-one'
  process.env.ADMIN_ALLOWED_EMAILS = ADMIN
  process.env.REVIEWER_AUTH_SECRET = 'reviewer-secret-for-tests-only-not-a-real-one'
  process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
  process.env.REVIEWER_FEEDBACK_DIR = feedback
  process.env.REVIEWER_READING_DIR = reading
  process.env.REVIEWER_ROSTER_DRIVER = 'env'
  process.env.REVIEWER_ROSTER = ROSTER

  const auth = (await import(`${ROOT}lib/admin-auth.ts`)) as typeof import('../lib/admin-auth.ts')
  const minted = await auth.mintAdminToken(ADMIN)
  assert.ok(minted, 'the test session could not be minted')
  token = minted
  const derived = await auth.adminCsrfToken(token)
  assert.ok(derived, 'the test CSRF token could not be derived')
  csrf = derived
  globalThis.__adminCookies = { [auth.ADMIN_COOKIE_NAME]: token }

  const owner = (await import(`${ROOT}lib/reading-owner.ts`)) as typeof import('../lib/reading-owner.ts')
  const derivedId = await owner.authorOwnerId(ADMIN)
  assert.ok(derivedId)
  authorId = derivedId

  const meta = (await import(`${ROOT}lib/author-metadata.ts`)) as typeof import('../lib/author-metadata.ts')
  metadataPath = meta.authorMetadataPath
  metadataPrefix = meta.authorMetadataPrefix

  const notes = (await import(`${ROOT}lib/note-service.ts`)) as typeof import('../lib/note-service.ts')
  createNote = notes.createNote

  const noteStore = (await import(`${ROOT}lib/notes-store.ts`)) as typeof import('../lib/notes-store.ts')
  const readingStore = (await import(`${ROOT}lib/reviewer-reading.ts`)) as typeof import('../lib/reviewer-reading.ts')
  const withdrawals = (await import(`${ROOT}lib/withdrawal-events.ts`)) as typeof import('../lib/withdrawal-events.ts')
  const roster = (await import(`${ROOT}lib/reviewer-roster.ts`)) as typeof import('../lib/reviewer-roster.ts')
  const feedbackStore = (await import(`${ROOT}lib/reviewer-feedback.ts`)) as typeof import('../lib/reviewer-feedback.ts')
  resetStores = () => {
    noteStore.__resetNoteStore()
    readingStore.__resetReadingStore()
    withdrawals.__resetWithdrawalStore()
    meta.__resetAuthorMetadataStore()
    roster.__resetRosterStore()
    feedbackStore.__resetFeedbackStore()
  }
  fresh()

  POST = (await import(`${ROOT}app/admin/api/feedback/route.ts`)).POST
})

test.after(() => {
  globalThis.__adminCookies = undefined
  globalThis.__requestHeaders = undefined
  for (const key of KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ helpers */

function post(body: Record<string, unknown>, options: { csrf?: boolean } = {}): Promise<Response> {
  const payload = options.csrf === false ? body : { ...body, csrf }
  return POST(
    new Request('https://example.test/admin/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }) as never,
  )
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

function storePath(bookSlug: string): string {
  return join(reading, metadataPath(authorId, bookSlug))
}

function readStored(bookSlug: string): string | null {
  const path = storePath(bookSlug)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** Every file beneath the reading root, with its bytes. */
function fingerprint(): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (at: string) => {
    if (!existsSync(at)) return
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.set(full, readFileSync(full, 'utf8'))
    }
  }
  walk(dir)
  return out
}

/**
 * A world with nothing in it.
 *
 * The stores are memoised per process, so resetting them is necessary and not
 * sufficient: bytes an earlier test wrote -- a deliberately corrupt document
 * most of all -- are still on disk and would silently become the next test's
 * starting state.
 */
function fresh(): void {
  rmSync(reading, { recursive: true, force: true })
  rmSync(join(dir, 'feedback'), { recursive: true, force: true })
  mkdirSync(join(dir, 'feedback'), { recursive: true })
  resetStores()
}

function corrupt(bookSlug: string, bytes: string): void {
  const path = storePath(bookSlug)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes, 'utf8')
}

async function sharedNote(body: string): Promise<string> {
  const created = await createNote(
    { kind: 'reviewer', id: 'anna', books: [BOOK] },
    { bookSlug: BOOK, scope: 'chapter', chapterSlug: CHAPTER, body, visibility: 'shared' },
  )
  assert.equal(created.ok, true)
  if (!created.ok) throw new Error('unreachable')
  return `note:${created.value.id}`
}

const VIEW = {
  id: 'unresolved-passages',
  name: 'Unresolved passages',
  books: [BOOK, OTHER_BOOK],
  chapters: [`${BOOK}/${CHAPTER}`],
  kinds: ['note'],
  scopes: ['chapter'],
  state: 'new',
}

/* --------------------------------------------------------------- the gate */

test('an anonymous caller is refused before anything is read or written', async () => {
  const jar = globalThis.__adminCookies
  globalThis.__adminCookies = {}
  try {
    const before = fingerprint()
    const response = await post({ intent: 'export', format: 'json' })
    assert.equal(response.status, 401)
    assert.equal((await json(response)).error, 'not_authorized')
    assert.deepEqual(fingerprint(), before, 'an unauthorized call wrote something')
  } finally {
    globalThis.__adminCookies = jar
  }
})

test('a reviewer session is not an author session', async () => {
  const jar = globalThis.__adminCookies
  // A real reviewer cookie value in the admin cookie's slot: it is not an
  // administrator token, and `verifyAdminToken` is what decides that.
  globalThis.__adminCookies = { mrj_admin: 'reviewer-looking-value' }
  try {
    const response = await post({ intent: 'resolve', bookSlug: BOOK, itemId: 'note:x', resolved: true })
    assert.equal(response.status, 401)
  } finally {
    globalThis.__adminCookies = jar
  }
})

test('a missing or wrong CSRF token refuses every intent', async () => {
  for (const intent of ['resolve', 'save-view', 'delete-view', 'export']) {
    const missing = await post({ intent }, { csrf: false })
    assert.equal(missing.status, 403, `${intent} was accepted with no CSRF token`)
    assert.equal((await json(missing)).error, 'bad_csrf')

    const wrong = await POST(
      new Request('https://example.test/admin/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intent, csrf: `${csrf}x` }),
      }) as never,
    )
    assert.equal(wrong.status, 403, `${intent} was accepted with a wrong CSRF token`)
  }
})

test('an unknown intent, a non-object body and an oversize body are all refused', async () => {
  assert.equal((await post({ intent: 'delete-everything' })).status, 400)
  assert.equal((await post({})).status, 400)

  const array = await POST(
    new Request('https://example.test/admin/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([1, 2, 3]),
    }) as never,
  )
  assert.equal(array.status, 400)

  const huge = await POST(
    new Request('https://example.test/admin/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'export', csrf, padding: 'x'.repeat(64 * 1024) }),
    }) as never,
  )
  assert.equal(huge.status, 413)
  assert.equal((await json(huge)).error, 'too_large')
})

test('every response is private and uncacheable', async () => {
  const response = await post({ intent: 'export', format: 'json' })
  assert.match(response.headers.get('Cache-Control') ?? '', /no-store/)
  assert.match(response.headers.get('X-Robots-Tag') ?? '', /noindex/)
})

/* -------------------------------------------------------------- resolving */

test('resolving one item changes that item only, and marks nothing read', async () => {
  fresh()
  const one = await sharedNote('The first.')
  const two = await sharedNote('The second.')

  const accepted = await post({ intent: 'resolve', bookSlug: BOOK, itemId: one, resolved: true })
  assert.equal(accepted.status, 200)
  const body = await json(accepted)
  assert.equal(body.resolved, true)
  assert.equal(body.lastReadAt, null, 'resolving marked the item read')

  const stored = JSON.parse(readStored(BOOK) as string) as {
    items: Record<string, { resolved: boolean; lastReadAt: string | null; lastExportedAt: string | null }>
  }
  assert.equal(stored.items[one].resolved, true)
  assert.equal(stored.items[one].lastReadAt, null)
  assert.equal(stored.items[one].lastExportedAt, null)
  assert.equal(stored.items[two], undefined, 'resolving one item touched another')

  const reopened = await post({ intent: 'resolve', bookSlug: BOOK, itemId: one, resolved: false })
  assert.equal((await json(reopened)).resolved, false, 'resolving is not reversible')
})

test('resolve refuses anything but a real boolean, a real slug and a real item id', async () => {
  for (const body of [
    { intent: 'resolve', bookSlug: BOOK, itemId: 'note:one' },
    { intent: 'resolve', bookSlug: BOOK, itemId: 'note:one', resolved: 'true' },
    { intent: 'resolve', bookSlug: BOOK, itemId: 'not-an-item-id', resolved: true },
    { intent: 'resolve', bookSlug: '../escape', itemId: 'note:one', resolved: true },
    { intent: 'resolve', bookSlug: SAVED_VIEW_HOME_SLUG, itemId: 'note:one', resolved: true },
  ]) {
    const response = await post(body)
    assert.equal(response.status, 400, `${JSON.stringify(body)} was accepted`)
  }
})

test('a triage write is never attempted against the saved-view document', async () => {
  fresh()
  const before = readStored(SAVED_VIEW_HOME_SLUG)
  await post({ intent: 'resolve', bookSlug: SAVED_VIEW_HOME_SLUG, itemId: 'note:x', resolved: true })
  assert.equal(readStored(SAVED_VIEW_HOME_SLUG), before, 'the view document was written by a triage intent')
})

/* ------------------------------------------------------------ saved views */

test('a saved view is written to one document and to no book', async () => {
  fresh()
  await sharedNote('Something to filter.')

  const response = await post({ intent: 'save-view', view: VIEW })
  assert.equal(response.status, 200)
  const views = (await json(response)).views as { id: string; chapters: string[] }[]
  assert.equal(views.length, 1)
  assert.deepEqual(views[0].chapters, [`${BOOK}/${CHAPTER}`])

  const prefix = join(reading, metadataPrefix(authorId))
  const holders = readdirSync(prefix, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => readFileSync(join(prefix, entry.name), 'utf8').includes(VIEW.id))
    .map((entry) => entry.name)

  assert.deepEqual(
    holders,
    [`${SAVED_VIEW_HOME_SLUG}.json`],
    'the view was copied into a per-book document, or into more than one file',
  )
})

test('a malformed or over-limit view is refused and the existing views survive', async () => {
  fresh()
  assert.equal((await post({ intent: 'save-view', view: VIEW })).status, 200)
  const before = readStored(SAVED_VIEW_HOME_SLUG)

  const chapters = (count: number) =>
    Array.from({ length: count }, (_, i) => `${BOOK}/chapter-${i}`)

  for (const view of [
    { ...VIEW, id: 'x', name: '' },
    { ...VIEW, id: 'NOT A SLUG' },
    { ...VIEW, id: 'y', state: 'whatever' },
    { ...VIEW, id: 'z', kinds: ['secrets'] },
    { ...VIEW, id: 'w', chapters: [CHAPTER] },
    { ...VIEW, id: 'v', chapters: chapters(MAX_VIEW_CHAPTERS + 1) },
    { ...VIEW, id: 'u', books: ['../escape'] },
  ]) {
    const response = await post({ intent: 'save-view', view })
    assert.equal(response.status, 400, `${JSON.stringify(view).slice(0, 80)} was accepted`)
    assert.equal((await json(response)).error, 'bad_request')
  }
  assert.equal((await post({ intent: 'save-view', view: 'not an object' })).status, 400)

  assert.equal(readStored(SAVED_VIEW_HOME_SLUG), before, 'a refused view changed the stored bytes')
})

test('a saved view can be replaced and deleted, and nothing else is', async () => {
  fresh()
  assert.equal((await post({ intent: 'save-view', view: VIEW })).status, 200)
  assert.equal((await post({ intent: 'save-view', view: { ...VIEW, id: 'second', name: 'Second' } })).status, 200)

  const replaced = await post({ intent: 'save-view', view: { ...VIEW, name: 'Renamed' } })
  const afterReplace = (await json(replaced)).views as { id: string; name: string }[]
  assert.equal(afterReplace.length, 2, 'replacing a view by id added a second copy')
  assert.equal(afterReplace.find((view) => view.id === VIEW.id)?.name, 'Renamed')

  const deleted = await post({ intent: 'delete-view', viewId: VIEW.id })
  const afterDelete = (await json(deleted)).views as { id: string }[]
  assert.deepEqual(afterDelete.map((view) => view.id), ['second'])

  assert.equal((await post({ intent: 'delete-view', viewId: 'NOT A SLUG' })).status, 400)
})

/* ----------------------------------------------------------------- export */

test('an export returns a rendering, stamps only what it contained, and changes no state', async () => {
  fresh()
  /*
   * Two items, one resolved and one deliberately **not**. With only a resolved
   * item, an exporter that set `resolved: true` on everything it stamped would
   * be indistinguishable from one that left it alone -- the assertion would be
   * comparing `true` with `true`. The unresolved item is what makes "changes no
   * state" a claim about both directions.
   */
  const one = await sharedNote('The first.')
  const two = await sharedNote('The second.')
  await post({ intent: 'resolve', bookSlug: BOOK, itemId: one, resolved: true })

  const before = JSON.parse(readStored(BOOK) as string) as {
    items: Record<string, { resolved: boolean; lastReadAt: string | null }>
  }
  assert.equal(before.items[one].resolved, true)
  assert.equal(before.items[two], undefined, 'the second item was triaged before the export')

  const response = await post({ intent: 'export', format: 'json' })
  assert.equal(response.status, 200)
  const body = await json(response)

  assert.equal(body.format, 'json')
  assert.equal(body.naming, 'pseudonym')
  assert.match(String(body.filename), /^author-feedback-\d{8}T\d{6}Z\.json$/)
  assert.ok(String(body.content).includes('"schema"'))
  assert.equal(body.stamped, 'recorded')
  assert.equal(body.itemCount, 2)

  const after = JSON.parse(readStored(BOOK) as string) as {
    items: Record<string, { resolved: boolean; lastReadAt: string | null; lastExportedAt: string | null }>
  }
  assert.equal(after.items[one].resolved, true, 'exporting un-resolved a resolved item')
  assert.equal(after.items[two].resolved, false, 'exporting resolved an unresolved item')
  assert.equal(after.items[one].lastReadAt, null, 'exporting marked an item read')
  assert.equal(after.items[two].lastReadAt, null, 'exporting marked an item read')
  assert.ok(after.items[one].lastExportedAt, 'the export stamped nothing')
  assert.ok(after.items[two].lastExportedAt, 'the export stamped only some of what it held')

  const markdown = await post({ intent: 'export', format: 'markdown' })
  const markdownBody = await json(markdown)
  assert.match(String(markdownBody.filename), /\.md$/)
  assert.ok(!String(markdownBody.content).includes('"schema"'))
})

test('a packet names reviewers by pseudonym unless this very request asked otherwise', async () => {
  fresh()
  await sharedNote('Something Anna shared.')

  const byDefault = await json(await post({ intent: 'export', format: 'markdown' }))
  assert.ok(String(byDefault.content).includes('Reviewer 1'))
  assert.ok(!String(byDefault.content).includes('Anna Reviewer'))

  const byName = await json(await post({ intent: 'export', format: 'markdown', naming: 'display-name' }))
  assert.equal(byName.naming, 'display-name')
  assert.ok(String(byName.content).includes('Anna Reviewer'))

  // The next request is pseudonymous again: there is nowhere for the choice to
  // have been remembered.
  const again = await json(await post({ intent: 'export', format: 'markdown' }))
  assert.equal(again.naming, 'pseudonym')
  assert.ok(!String(again.content).includes('Anna Reviewer'))

  assert.equal((await post({ intent: 'export', format: 'markdown', naming: 'real-names' })).status, 400)
})

test('the book subset is the explicit list in the request, and is validated', async () => {
  fresh()
  await sharedNote('Something Anna shared.')

  const subset = await json(await post({ intent: 'export', format: 'json', bookSlugs: [OTHER_BOOK] }))
  const packet = JSON.parse(String(subset.content)) as { books: { slug: string }[]; items: unknown[] }
  assert.deepEqual(packet.books.map((book) => book.slug), [OTHER_BOOK])
  assert.equal(packet.items.length, 0, 'a restricted packet carried another book')

  for (const bookSlugs of [[], ['../escape'], [3], Array.from({ length: 51 }, (_, i) => `b${i}`), 'nope']) {
    assert.equal(
      (await post({ intent: 'export', format: 'json', bookSlugs })).status,
      400,
      `${JSON.stringify(bookSlugs).slice(0, 40)} was accepted as a book subset`,
    )
  }

  assert.equal((await post({ intent: 'export', format: 'csv' })).status, 400)
})

test('an unreadable triage document refuses the export and stamps nothing anywhere', async () => {
  fresh()
  await sharedNote('Something Anna shared.')
  corrupt(BOOK, '{"schema":1,"bookSlug":"' + BOOK + '","items":{"not an id":3},"views":[],"updatedAt":"x"}')
  const before = fingerprint()

  const response = await post({ intent: 'export', format: 'json' })
  assert.equal(response.status, 409)
  const body = await json(response)
  assert.equal(body.error, 'metadata_unreadable')
  assert.equal(body.content, undefined, 'a refused export handed back a packet anyway')
  assert.deepEqual(
    body.failures,
    [{ source: 'author-metadata', bookSlug: BOOK }],
    'the failure list named something other than the source',
  )
  assert.deepEqual(fingerprint(), before, 'a refused export wrote something')
})

test('the export operation is called once per request, so a second download cannot re-stamp', async () => {
  fresh()
  const one = await sharedNote('The first.')

  const first = await json(await post({ intent: 'export', format: 'json' }))
  const stampedAt = (
    JSON.parse(readStored(BOOK) as string) as {
      items: Record<string, { lastExportedAt: string | null }>
    }
  ).items[one].lastExportedAt
  assert.ok(stampedAt)

  /*
   * Everything the browser does with `first` -- saving it, copying it, failing
   * at either -- happens after this response and is invisible from here. The
   * only way another stamp can be written is another request, which is the
   * point: there is no endpoint that stamps without generating.
   */
  const before = fingerprint()
  void String(first.content).length
  assert.deepEqual(fingerprint(), before, 'something wrote after the response was returned')

  const second = await json(await post({ intent: 'export', format: 'json' }))
  const restamped = (
    JSON.parse(readStored(BOOK) as string) as {
      items: Record<string, { lastExportedAt: string | null }>
    }
  ).items[one].lastExportedAt
  assert.ok(restamped)
  assert.equal(second.stamped, 'recorded')
  assert.equal(
    String(first.generatedAt) !== String(second.generatedAt) || stampedAt !== restamped,
    true,
    'a second export was indistinguishable from the first',
  )
})

/* ----------------------------------------------------------- what it says */

test('no response body carries a path, an address, a reviewer id or a provider message', async () => {
  fresh()
  await sharedNote('Something Anna shared.')

  const responses: Record<string, unknown>[] = []
  responses.push(await json(await post({ intent: 'export', format: 'json' })))
  responses.push(await json(await post({ intent: 'export', format: 'markdown' })))
  responses.push(await json(await post({ intent: 'save-view', view: VIEW })))
  responses.push(await json(await post({ intent: 'delete-view', viewId: VIEW.id })))
  responses.push(await json(await post({ intent: 'save-view', view: { id: '!' } })))
  responses.push(await json(await post({ intent: 'nope' })))

  corrupt(BOOK, 'not a document')
  responses.push(await json(await post({ intent: 'export', format: 'json' })))

  for (const body of responses) {
    const serialized = JSON.stringify(body)
    for (const sentinel of [
      ADMIN,
      authorId,
      'author-meta/',
      'reading/v1',
      tmpdir(),
      'mrj-feedback-route-',
      '"anna"',
      process.env.ADMIN_AUTH_SECRET as string,
      process.env.REVIEWER_AUTH_SECRET as string,
      token,
    ]) {
      assert.ok(
        !serialized.includes(sentinel),
        `a response body carries ${sentinel.slice(0, 24)}`,
      )
    }
  }
})

/* ------------------------------------------ C1: a resolve names a real row */

test('a phantom item and a right-id/wrong-book pair are refused, and the real one still resolves', async () => {
  fresh()
  const real = await sharedNote('The only real one.')

  const before = fingerprint()

  const phantom = await post({
    intent: 'resolve',
    bookSlug: BOOK,
    itemId: 'note:phantom-item',
    resolved: true,
  })
  assert.equal(phantom.status, 400, 'a syntactically valid phantom item was accepted')
  assert.equal((await json(phantom)).error, 'bad_request')
  assert.deepEqual(fingerprint(), before, 'a phantom resolve wrote metadata')

  const wrongBook = await post({
    intent: 'resolve',
    bookSlug: OTHER_BOOK,
    itemId: real,
    resolved: true,
  })
  assert.equal(wrongBook.status, 400, 'a real item was resolved under a book it is not in')
  assert.equal((await json(wrongBook)).error, 'bad_request')
  assert.deepEqual(fingerprint(), before, 'a wrong-book resolve wrote metadata')

  // And the coordinate that does exist is still accepted, unchanged.
  const accepted = await post({ intent: 'resolve', bookSlug: BOOK, itemId: real, resolved: true })
  assert.equal(accepted.status, 200, 'the real coordinate stopped resolving')
  assert.equal((await json(accepted)).resolved, true)
})

/* ------------------------------------------ C1: the 32 KiB bound is bytes */

/** What `MAX_BODY_BYTES` is, restated here because the route keeps it private. */
const CAP = 32 * 1024

test('a multibyte body over the byte cap is refused though its string length is under it', async () => {
  fresh()
  const before = fingerprint()

  const payload = JSON.stringify({
    intent: 'export',
    format: 'json',
    csrf,
    padding: '€'.repeat(11_000),
  })
  assert.ok(payload.length < CAP, 'the padding no longer hides under a UTF-16 measure')
  assert.ok(Buffer.byteLength(payload, 'utf8') > CAP, 'the padding is not over the byte cap')

  const response = await POST(
    new Request('https://example.test/admin/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    }) as never,
  )

  assert.equal(response.status, 413, 'a body over 32 KiB of UTF-8 was accepted')
  assert.equal((await json(response)).error, 'too_large')
  assert.deepEqual(fingerprint(), before, 'an oversize body mutated something')
})

test('a declared content-length over the cap is refused before the body is read', async () => {
  fresh()
  const before = fingerprint()

  const payload = JSON.stringify({
    intent: 'export',
    format: 'json',
    csrf,
    padding: '€'.repeat(11_000),
  })
  const declared = Buffer.byteLength(payload, 'utf8')
  assert.ok(declared > CAP)

  const response = await POST(
    new Request('https://example.test/admin/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(declared) },
      body: payload,
    }) as never,
  )

  assert.equal(response.status, 413, 'a declared over-cap length was not refused')
  assert.equal((await json(response)).error, 'too_large')
  assert.deepEqual(fingerprint(), before, 'an oversize declared body mutated something')
})

test('a streamed multibyte body over the byte cap is refused with no declared length', async () => {
  fresh()
  const before = fingerprint()

  const payload = JSON.stringify({
    intent: 'export',
    format: 'json',
    csrf,
    padding: '€'.repeat(11_000),
  })
  assert.ok(payload.length < CAP, 'the streamed padding is not multibyte enough')
  assert.ok(Buffer.byteLength(payload, 'utf8') > CAP)

  const bytes = Buffer.from(payload, 'utf8')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // In several chunks, so the bound has to hold while reading rather than
      // after one convenient buffer.
      for (let at = 0; at < bytes.length; at += 4096) {
        controller.enqueue(new Uint8Array(bytes.subarray(at, at + 4096)))
      }
      controller.close()
    },
  })

  const streamed = new Request('https://example.test/admin/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as RequestInit)
  assert.equal(streamed.headers.get('content-length'), null, 'the stream declared a length')

  const response = await POST(streamed as never)

  assert.equal(response.status, 413, 'a streamed body over 32 KiB of UTF-8 was accepted')
  assert.equal((await json(response)).error, 'too_large')
  assert.deepEqual(fingerprint(), before, 'an oversize streamed body mutated something')
})

test('a body just under the byte cap is still accepted', async () => {
  fresh()
  const shell = JSON.stringify({ intent: 'export', format: 'json', csrf, padding: '' })
  const room = CAP - Buffer.byteLength(shell, 'utf8') - 16
  const payload = JSON.stringify({
    intent: 'export',
    format: 'json',
    csrf,
    padding: 'x'.repeat(room),
  })
  assert.ok(Buffer.byteLength(payload, 'utf8') < CAP, 'the just-under body is not under the cap')
  assert.ok(Buffer.byteLength(payload, 'utf8') > CAP - 64, 'the just-under body is not near the cap')

  const response = await POST(
    new Request('https://example.test/admin/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    }) as never,
  )

  assert.equal(response.status, 200, 'a body inside the cap was refused')
  assert.equal((await json(response)).ok, true)
})

/* ------------------------- C1: duplicates normalise, and bytes are the bound */

test('a duplicate-heavy chapter filter normalises to its distinct set', async () => {
  fresh()
  const copies = 1_000
  assert.ok(copies > MAX_VIEW_CHAPTERS, 'the duplicate count no longer exceeds the entry cap')

  const payload = JSON.stringify({
    intent: 'save-view',
    csrf,
    view: { ...VIEW, chapters: Array.from({ length: copies }, () => `${OTHER_BOOK}/one`) },
  })
  assert.ok(Buffer.byteLength(payload, 'utf8') < CAP, 'the duplicate body is not within the cap')

  const response = await POST(
    new Request('https://example.test/admin/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    }) as never,
  )

  assert.equal(response.status, 200, 'a within-cap duplicate-heavy view was refused')
  const views = (await json(response)).views as { id: string; chapters: string[] }[]
  const stored = views.find((view) => view.id === VIEW.id)
  assert.ok(stored, 'the view was not stored')
  assert.deepEqual(stored.chapters, [`${OTHER_BOOK}/one`], 'duplicates were not normalised to one')
})

test('a duplicate-heavy chapter filter past the byte cap is refused by the route', async () => {
  fresh()
  const before = fingerprint()

  const payload = JSON.stringify({
    intent: 'save-view',
    csrf,
    view: { ...VIEW, chapters: Array.from({ length: 2_500 }, () => `${OTHER_BOOK}/one`) },
  })
  assert.ok(Buffer.byteLength(payload, 'utf8') > CAP, 'the over-cap body is not over the cap')

  const response = await POST(
    new Request('https://example.test/admin/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    }) as never,
  )

  assert.equal(response.status, 413, 'an over-cap view body was not refused')
  assert.equal((await json(response)).error, 'too_large')
  assert.deepEqual(fingerprint(), before, 'an over-cap view body mutated something')
})

/* -------------------------- C2: the bytes are UTF-8, or they are not a request */

/**
 * A body that arrives as exactly these chunks, in this order, with no declared
 * length -- the shape a chunked upload has on the wire, and the one in which a
 * multibyte character, or an invalid sequence, can straddle two reads.
 */
function chunked(chunks: Uint8Array[]): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  const request = new Request('https://example.test/admin/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as RequestInit)
  assert.equal(request.headers.get('content-length'), null, 'the stream declared a length')
  return request
}

/**
 * The bytes of a real `resolve` -- this session's CSRF token, a real
 * coordinate, `resolved: true` -- with `filler` placed, byte for byte, inside a
 * trailing string member the route never reads. `fillerAt` is its offset.
 */
function resolveBytes(itemId: string, filler: Buffer): { bytes: Buffer; fillerAt: number } {
  const text = JSON.stringify({ intent: 'resolve', csrf, bookSlug: BOOK, itemId, resolved: true, ignored: '' })
  assert.ok(text.endsWith('"ignored":""}'), 'the ignored member is not where the filler goes')
  const open = Buffer.from(text.slice(0, -'"}'.length), 'utf8')
  return { bytes: Buffer.concat([open, filler, Buffer.from('"}', 'utf8')]), fillerAt: open.byteLength }
}

/** The paths whose bytes differ between two fingerprints, in either direction. */
function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set<string>()
  before.forEach((_, path) => paths.add(path))
  after.forEach((_, path) => paths.add(path))
  return Array.from(paths)
    .filter((path) => before.get(path) !== after.get(path))
    .sort()
}

test('an invalid UTF-8 sequence inside an ignored string is refused, and nothing is written', async () => {
  fresh()
  const real = await sharedNote('The one that must stay unresolved.')
  const before = fingerprint()

  /*
   * Everything the route needs in order to write -- a real session, the
   * matching CSRF token, a real coordinate, a real boolean -- and, in a member
   * the route never reads, the bytes C3 28: a two-byte lead with no
   * continuation. Read leniently, that is U+FFFD followed by "(", which is
   * legal string content, and the request parses to exactly the resolve it
   * carries. Read exactly, it is not UTF-8, and so it is not a request.
   */
  const { bytes, fillerAt } = resolveBytes(real, Buffer.from([0xc3, 0x28]))
  assert.ok(bytes.byteLength < CAP, 'the invalid body is not under the cap')
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes), TypeError)
  const lenient = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  assert.equal(lenient.intent, 'resolve', 'the lenient reading is not the resolve it should be')
  assert.equal(lenient.itemId, real, 'the lenient reading does not name the real coordinate')

  // One chunk ends in C3 and the next begins with 28, so no single read holds
  // the whole sequence: the body is judged as a body or not at all.
  const at = fillerAt + 1
  assert.equal(bytes[at - 1], 0xc3)
  assert.equal(bytes[at], 0x28)
  const response = await POST(
    chunked([new Uint8Array(bytes.subarray(0, at)), new Uint8Array(bytes.subarray(at))]) as never,
  )

  const after = fingerprint()
  assert.equal(
    response.status,
    400,
    `an invalid UTF-8 body was accepted, and ${changedPaths(before, after).length} stored file(s) changed`,
  )
  assert.equal((await json(response)).error, 'bad_request')
  assert.deepEqual(after, before, 'an invalid UTF-8 body wrote metadata')
})

test('a valid multibyte character split across two chunks still resolves', async () => {
  fresh()
  const real = await sharedNote('The one to resolve.')

  const euro = Buffer.from('€', 'utf8')
  assert.deepEqual(Array.from(euro), [0xe2, 0x82, 0xac])
  const { bytes, fillerAt } = resolveBytes(real, euro)
  assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes))

  // E2 in one chunk, 82 AC in the next: valid as a whole, and only as a whole.
  // A decoder that judged each chunk on its own would refuse this real request.
  const at = fillerAt + 1
  assert.equal(bytes[at - 1], 0xe2)
  assert.equal(bytes[at], 0x82)
  const response = await POST(
    chunked([new Uint8Array(bytes.subarray(0, at)), new Uint8Array(bytes.subarray(at))]) as never,
  )

  assert.equal(response.status, 200, 'a valid UTF-8 body split inside a character was refused')
  const body = await json(response)
  assert.equal(body.ok, true)
  assert.equal(body.resolved, true)
  const stored = JSON.parse(readStored(BOOK) as string) as {
    items: Record<string, { resolved: boolean }>
  }
  assert.equal(stored.items[real].resolved, true, 'the resolve was answered but not written')
})

test('a leading byte-order mark is not quietly removed: a BOM-prefixed body is refused unwritten', async () => {
  fresh()
  const real = await sharedNote('The one behind a BOM.')
  const before = fingerprint()

  const payload = Buffer.from(
    JSON.stringify({ intent: 'resolve', csrf, bookSlug: BOOK, itemId: real, resolved: true }),
    'utf8',
  )
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), payload])
  // Valid UTF-8 throughout, and a valid request without its first three bytes;
  // U+FEFF is simply not JSON whitespace. A decoder that dropped it, as the
  // default one does, would turn this refusal into an accepted write.
  assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  assert.doesNotThrow(() => JSON.parse(payload.toString('utf8')))

  const response = await POST(chunked([new Uint8Array(bytes)]) as never)

  assert.equal(response.status, 400, 'a BOM-prefixed body was accepted')
  assert.equal((await json(response)).error, 'bad_request')
  assert.deepEqual(fingerprint(), before, 'a BOM-prefixed body wrote metadata')
})
