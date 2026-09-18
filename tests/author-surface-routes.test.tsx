/**
 * The two new author routes, rendered as the server renders them.
 *
 * `tests/author-inbox-render.test.tsx` drives the components from props, which
 * proves the controls. What it cannot prove is the thing the assignment calls
 * the first truthful state: that the **server component** reads the real
 * stores, decides between "there is nothing here" and "some of this could not
 * be read", and puts that decision in the HTML before any script runs.
 *
 * So the real page functions are imported and awaited, and the element tree
 * they return is mounted. The session, the CSRF derivation, the source read,
 * the per-book triage reads, the saved-view read and the mark-on-open are all
 * shipped code running against a real filesystem store. Only `next/headers` is
 * replaced -- `cookies()` and `headers()` need a request store that only a Next
 * server creates -- and the test supplies a real minted token to it.
 *
 * ## The privacy scan
 *
 * A world is seeded with one sentinel of every kind that must never reach an
 * author surface: private reviewer notes at all four scopes, a private
 * highlight, a reading position, an address, a reviewer id, a token-shaped
 * string and a storage path. The whole rendered document is then scanned for
 * each one by name. Scanning the **rendered bytes** rather than a returned
 * object is the only form of the question a future template change cannot pass
 * by accident.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

import { installDom, type DomHandle } from './helpers/dom.ts'

register('./helpers/author-route-hooks.mjs', import.meta.url)

const ROOT = pathToFileURL(join(process.cwd(), '/')).href

const ADMIN = 'mike@example.com'
const BOOK = 'the-backward-becoming'
const CHAPTER = 'chapter-one'
const PARAGRAPH = `${CHAPTER}-p002`

/**
 * Every sentinel, by the name of the thing it stands for.
 *
 * A reviewer is not offered book scope at all -- the composer does not have it
 * and `createNote` refuses it -- so the three scopes a reviewer can actually
 * write privately are the three that are seeded. Book scope is covered by
 * `MIKE_OWN_NOTE` below, from the other direction: it is Mike's own private
 * note, it *must* appear, and it is the positive control that keeps this scan
 * from passing over a page that simply rendered nothing.
 */
const SECRETS = {
  'a private passage note': 'ANNA-PRIVATE-PASSAGE-SENTINEL',
  'a private paragraph note': 'ANNA-PRIVATE-PARAGRAPH-SENTINEL',
  'a private chapter note': 'ANNA-PRIVATE-CHAPTER-SENTINEL',
  'a reviewer address': 'anna@example.test',
  'a reviewer id': 'anna-0001-reviewer-id',
  'an access-code hash': 'c'.repeat(64),
  'a storage path': 'reading/v1/reviewer/',
  'the metadata prefix': 'author-meta/v1/',
}

/** Mike's own private note, at book scope. A positive control, not a secret. */
const MIKE_OWN_NOTE = 'MIKE-OWN-BOOK-NOTE'

/**
 * A private highlight carries no words at all.
 *
 * `addAnnotation` mints a bodyless mark and **refuses** a `note` outright -- the
 * annotation body was closed when the note contract arrived, so there is one
 * way to write about a passage and one vocabulary for who may read it. The
 * scannable thing a private highlight has is therefore its **id**, which is
 * minted per run and added to the sentinels by `seedSecrets`.
 */
type Seeded = { privateHighlightId: string }

const ROSTER = JSON.stringify([
  {
    id: 'anna-0001-reviewer-id',
    name: 'Anna Reviewer',
    email: 'anna@example.test',
    books: [BOOK],
    codeHash: 'c'.repeat(64),
  },
])

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

declare global {
  // eslint-disable-next-line no-var
  var __adminCookies: Record<string, string> | undefined
  // eslint-disable-next-line no-var
  var __requestHeaders: Record<string, string> | undefined
}

const ANNA = { kind: 'reviewer' as const, id: 'anna-0001-reviewer-id', books: [BOOK] }

let dir = ''
let reading = ''
let cookieName = ''
let dom: DomHandle
let rtl: typeof import('@testing-library/react')

let FeedbackPage: () => Promise<JSX.Element>
let ItemPage: (props: { params: { book: string; id: string } }) => Promise<JSX.Element>

let services: {
  createNote: typeof import('../lib/note-service.ts').createNote
  deleteNote: typeof import('../lib/note-service.ts').deleteNote
  addAnnotation: typeof import('../lib/reading-service.ts').addAnnotation
  savePosition: typeof import('../lib/reading-service.ts').savePosition
  loadAuthorBoard: typeof import('../lib/author-dashboard.ts').loadAuthorBoard
  authorMetadataPath: typeof import('../lib/author-metadata.ts').authorMetadataPath
  reset: () => void
}
let authorId = ''

const saved = new Map<string, string | undefined>()

/*
 * ## Why the order in here is load-bearing
 *
 * Every server module in this codebase refuses to load in a browser, by a
 * `typeof window !== 'undefined'` check that runs when the module is evaluated.
 * `installDom()` publishes a `window`, so anything imported **after** it looks
 * like a browser to that check and throws.
 *
 * Testing Library has the opposite requirement: `@testing-library/dom` captures
 * `window` once, when it is first loaded, and queries the document of whatever
 * window it captured.
 *
 * So the order is: environment, then every server module, then the pages, then
 * the DOM, then Testing Library. Module evaluation happens once, so the pages
 * and their whole `lib` graph are already loaded by the time a window exists,
 * and nothing is stubbed to make that true.
 */
test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mrj-author-routes-'))
  reading = join(dir, 'reading')
  mkdirSync(join(dir, 'feedback'), { recursive: true })

  for (const key of KEYS) saved.set(key, process.env[key])
  process.env.ADMIN_AUTH_SECRET = 'admin-secret-for-tests-only-not-a-real-one'
  process.env.ADMIN_ALLOWED_EMAILS = ADMIN
  process.env.REVIEWER_AUTH_SECRET = 'reviewer-secret-for-tests-only-not-a-real-one'
  process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
  process.env.REVIEWER_FEEDBACK_DIR = join(dir, 'feedback')
  process.env.REVIEWER_READING_DIR = reading
  process.env.REVIEWER_ROSTER_DRIVER = 'env'
  process.env.REVIEWER_ROSTER = ROSTER

  const auth = (await import(`${ROOT}lib/admin-auth.ts`)) as typeof import('../lib/admin-auth.ts')
  const token = await auth.mintAdminToken(ADMIN)
  assert.ok(token)
  cookieName = auth.ADMIN_COOKIE_NAME
  globalThis.__adminCookies = { [cookieName]: token }
  // The default request every test starts from is one Mike actually made: a
  // browser navigating to a page. Both halves are needed now -- a `document`
  // destination on its own is also what a hidden frame sends.
  globalThis.__requestHeaders = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' }

  const owner = (await import(`${ROOT}lib/reading-owner.ts`)) as typeof import('../lib/reading-owner.ts')
  authorId = (await owner.authorOwnerId(ADMIN)) as string

  const notes = (await import(`${ROOT}lib/note-service.ts`)) as typeof import('../lib/note-service.ts')
  const readingService = (await import(`${ROOT}lib/reading-service.ts`)) as typeof import('../lib/reading-service.ts')
  const board = (await import(`${ROOT}lib/author-dashboard.ts`)) as typeof import('../lib/author-dashboard.ts')
  const meta = (await import(`${ROOT}lib/author-metadata.ts`)) as typeof import('../lib/author-metadata.ts')
  const noteStore = (await import(`${ROOT}lib/notes-store.ts`)) as typeof import('../lib/notes-store.ts')
  const readingStore = (await import(`${ROOT}lib/reviewer-reading.ts`)) as typeof import('../lib/reviewer-reading.ts')
  const withdrawals = (await import(`${ROOT}lib/withdrawal-events.ts`)) as typeof import('../lib/withdrawal-events.ts')
  const roster = (await import(`${ROOT}lib/reviewer-roster.ts`)) as typeof import('../lib/reviewer-roster.ts')
  const feedbackStore = (await import(`${ROOT}lib/reviewer-feedback.ts`)) as typeof import('../lib/reviewer-feedback.ts')

  services = {
    createNote: notes.createNote,
    deleteNote: notes.deleteNote,
    addAnnotation: readingService.addAnnotation,
    savePosition: readingService.savePosition,
    loadAuthorBoard: board.loadAuthorBoard,
    authorMetadataPath: meta.authorMetadataPath,
    reset: () => {
      noteStore.__resetNoteStore()
      readingStore.__resetReadingStore()
      withdrawals.__resetWithdrawalStore()
      meta.__resetAuthorMetadataStore()
      roster.__resetRosterStore()
      feedbackStore.__resetFeedbackStore()
    },
  }
  services.reset()

  // The pages, and through them every remaining server module, all still with
  // no window in sight.
  FeedbackPage = (await import(`${ROOT}app/admin/feedback/page.tsx`)).default
  ItemPage = (await import(`${ROOT}app/admin/feedback/[book]/[id]/page.tsx`)).default

  dom = installDom({ url: 'https://mikeramseyjr.test/admin/feedback' })
  rtl = await import('@testing-library/react')
})

test.afterEach(() => {
  rtl.cleanup()
  globalThis.__requestHeaders = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' }
})

test.after(() => {
  globalThis.__adminCookies = undefined
  globalThis.__requestHeaders = undefined
  for (const key of KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  dom.restore()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ helpers */

function fresh(): void {
  rmSync(reading, { recursive: true, force: true })
  rmSync(join(dir, 'feedback'), { recursive: true, force: true })
  mkdirSync(join(dir, 'feedback'), { recursive: true })
  services.reset()
}

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

async function shared(body: string, over: Record<string, unknown> = {}) {
  const created = await services.createNote(ANNA, {
    bookSlug: BOOK,
    scope: 'chapter',
    chapterSlug: CHAPTER,
    body,
    visibility: 'shared',
    ...over,
  })
  assert.equal(created.ok, true, `creating "${body}" failed`)
  if (!created.ok) throw new Error('unreachable')
  return created.value
}

/** Every sentinel this product must never surface, written where it belongs. */
async function seedSecrets(): Promise<Seeded> {
  const MIKE = { kind: 'author' as const, id: authorId }

  /*
   * Each one built whole rather than spread over a chapter-shaped base: a
   * book-scope note anchors to nothing and is refused if it is handed a
   * chapter, and a seed that quietly failed would make the scan below vacuous.
   * Every `createNote` here is asserted.
   */
  const privateNotes: Record<string, unknown>[] = [
    {
      bookSlug: BOOK,
      scope: 'chapter',
      chapterSlug: CHAPTER,
      body: SECRETS['a private chapter note'],
      visibility: 'private',
    },
    {
      bookSlug: BOOK,
      scope: 'paragraph',
      chapterSlug: CHAPTER,
      paragraphId: PARAGRAPH,
      body: SECRETS['a private paragraph note'],
      visibility: 'private',
    },
    {
      bookSlug: BOOK,
      scope: 'passage',
      chapterSlug: CHAPTER,
      paragraphId: PARAGRAPH,
      startOffset: 0,
      endOffset: 8,
      body: SECRETS['a private passage note'],
      visibility: 'private',
    },
  ]

  for (const input of privateNotes) {
    const written = await services.createNote(ANNA, input as never)
    assert.equal(written.ok, true, `seeding "${String(input.body)}" failed`)
  }

  /*
   * His own note, at book scope, kept private. It is his record about his own
   * manuscript and it belongs on his own surfaces -- so it is asserted
   * *present* below, which is what stops the scan being satisfied by a page
   * that rendered nothing at all.
   */
  const own = await services.createNote(MIKE, {
    bookSlug: BOOK,
    scope: 'book',
    body: MIKE_OWN_NOTE,
    visibility: 'private',
  } as never)
  assert.equal(own.ok, true, 'seeding the author own note failed')

  /*
   * A private highlight, and a reading position. Neither is author-visible: a
   * highlight is private until its writer changes its visibility, and a
   * position is never anybody's but the reader's.
   */
  const highlight = await services.addAnnotation(ANNA, {
    bookSlug: BOOK,
    chapterSlug: CHAPTER,
    paragraphId: PARAGRAPH,
    startOffset: 0,
    endOffset: 8,
  })
  assert.equal(highlight.ok, true, 'seeding the private highlight failed')
  if (!highlight.ok) throw new Error('unreachable')

  const position = await services.savePosition(ANNA, {
    bookSlug: BOOK,
    chapterSlug: CHAPTER,
    paragraphId: PARAGRAPH,
  })
  assert.equal(position.ok, true, 'seeding the reading position failed')

  return { privateHighlightId: highlight.value.id }
}

/* ---------------------------------------------------- the inbox route */

test('the feedback page renders the rows the server read, before any script runs', async () => {
  fresh()
  const note = await shared('WHAT-ANNA-SHARED')

  const tree = await FeedbackPage()
  rtl.render(tree)

  assert.ok(rtl.screen.getByText(/WHAT-ANNA-SHARED/), 'the first paint listed nothing')
  assert.ok(rtl.screen.getByText('1 new'))
  assert.equal(
    (rtl.screen.getAllByRole('link', { name: 'Open this' })[0] as HTMLAnchorElement).getAttribute('href'),
    `/admin/feedback/${BOOK}/${encodeURIComponent(`note:${note.id}`)}`,
  )
  assert.ok(rtl.screen.getByText(`Signed in as ${ADMIN}`))
})

test('rendering the feedback page writes nothing at all', async () => {
  fresh()
  await shared('WHAT-ANNA-SHARED')
  const before = fingerprint()

  rtl.render(await FeedbackPage())
  assert.deepEqual(fingerprint(), before, 'opening the inbox wrote to the store')
})

test('an anonymous caller is redirected rather than shown a page', async () => {
  const jar = globalThis.__adminCookies
  globalThis.__adminCookies = {}
  try {
    await assert.rejects(() => FeedbackPage(), /NEXT_REDIRECT/)
    await assert.rejects(
      () => ItemPage({ params: { book: BOOK, id: 'note:anything' } }),
      /NEXT_REDIRECT/,
    )
  } finally {
    globalThis.__adminCookies = jar
  }
})

test('a server read failure is in the first paint, and is not an empty list', async () => {
  fresh()
  await shared('WHAT-ANNA-SHARED')

  // A triage document that is bytes and not a document.
  const path = join(reading, services.authorMetadataPath(authorId, BOOK))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'not a document at all', 'utf8')
  services.reset()

  rtl.render(await FeedbackPage())

  assert.ok(rtl.screen.getByText('Some of this could not be read'))
  assert.ok(
    rtl.screen.getAllByRole('alert').some((node) => /could not be read/.test(node.textContent ?? '')),
    'a storage failure produced no alert on the first paint',
  )
  assert.ok(rtl.screen.getByText(/WHAT-ANNA-SHARED/), 'the available rows were hidden')
  assert.ok(rtl.screen.getByText(/State unknown/), 'an unreadable state was rendered as a state')
  assert.ok(!document.body.textContent?.includes('0 new'))
})

/* ----------------------------------------------------- the detail route */

test('opening an item marks exactly that item read, and only on a navigation', async () => {
  fresh()
  const one = await shared('THE-FIRST')
  const two = await shared('THE-SECOND')

  const readAt = async (id: string): Promise<string | null> => {
    const board = await services.loadAuthorBoard({ kind: 'author', id: authorId })
    return board.rows.find((row) => row.itemId === id)?.lastReadAt ?? null
  }

  assert.equal(await readAt(`note:${one.id}`), null)

  rtl.render(await ItemPage({ params: { book: BOOK, id: `note:${one.id}` } }))
  assert.ok(rtl.screen.getByText(/THE-FIRST/))
  assert.ok(rtl.screen.getByText(/Opening this counted as reading it/))

  assert.ok(await readAt(`note:${one.id}`), 'opening an item did not mark it read')
  assert.equal(await readAt(`note:${two.id}`), null, 'opening one item marked another')
})

test('a subresource fetch of the detail page marks nothing', async () => {
  fresh()
  const one = await shared('THE-FIRST')

  globalThis.__requestHeaders = { 'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors' }
  const before = fingerprint()

  rtl.render(await ItemPage({ params: { book: BOOK, id: `note:${one.id}` } }))

  assert.deepEqual(fingerprint(), before, 'a cross-site subresource marked an item read')
  assert.ok(rtl.screen.getByText(/Nothing was recorded about this being read/))
})

test('the inbox list marks nothing, and the detail page marks one thing', async () => {
  fresh()
  const one = await shared('THE-FIRST')
  await shared('THE-SECOND')

  const beforeList = fingerprint()
  rtl.render(await FeedbackPage())
  assert.deepEqual(fingerprint(), beforeList, 'listing marked something read')
  rtl.cleanup()

  rtl.render(await ItemPage({ params: { book: BOOK, id: `note:${one.id}` } }))
  const afterOpen = fingerprint()
  assert.notDeepEqual(afterOpen, beforeList, 'opening an item recorded nothing')

  // And a second render of the *list* after that changes nothing further.
  rtl.cleanup()
  rtl.render(await FeedbackPage())
  assert.deepEqual(fingerprint(), afterOpen, 'listing wrote after an item had been opened')
})

test('an item with no safe destination still has a detail surface', async () => {
  fresh()
  // A withdrawal: no private link exists for one, and it must still be openable
  // rather than markable from the list.
  const written = await shared('SHARED-THEN-WITHDRAWN')
  const removed = await services.deleteNote(ANNA, BOOK, written.id, written.revision)
  assert.equal(removed.ok, true)

  rtl.render(await ItemPage({ params: { book: BOOK, id: `withdrawal:${written.id}` } }))
  assert.ok(rtl.screen.getByText(/Nothing of what it said was kept/))
  assert.ok(
    !document.body.textContent?.includes('SHARED-THEN-WITHDRAWN'),
    'a withdrawal detail page showed the body it stood for',
  )
})

test('an item that does not exist and one that cannot be read are different pages', async () => {
  fresh()
  rtl.render(await ItemPage({ params: { book: BOOK, id: 'note:no-such-note' } }))
  assert.ok(rtl.screen.getByText(/does not open anything you can see/))
  rtl.cleanup()

  // A malformed id and the saved-view slug are refused without reading anything.
  rtl.render(await ItemPage({ params: { book: BOOK, id: 'not-an-item-id' } }))
  assert.ok(rtl.screen.getByText(/does not open anything you can see/))
  rtl.cleanup()

  rtl.render(await ItemPage({ params: { book: 'saved-views', id: 'note:one' } }))
  assert.ok(rtl.screen.getByText(/does not open anything you can see/))
})

/* ------------------------------------------------------------- the privacy scan */

test('no author surface renders a private note, a private highlight, a position, an address or a path', async () => {
  fresh()
  const seeded = await seedSecrets()
  const visible = await shared('WHAT-ANNA-ACTUALLY-SHARED')

  const sentinels: [string, string][] = [
    ...Object.entries(SECRETS),
    ["a private highlight's id", seeded.privateHighlightId],
    ['the reading position paragraph', PARAGRAPH],
  ]

  const surfaces: [string, string][] = []

  rtl.render(await FeedbackPage())
  surfaces.push(['the inbox', document.body.innerHTML])
  // The positive controls: a page that rendered nothing would pass every
  // assertion below, so it is required to have rendered the two things it
  // should.
  assert.ok(
    document.body.textContent?.includes('WHAT-ANNA-ACTUALLY-SHARED'),
    'the scan would have passed over a page with no shared note on it',
  )
  assert.ok(
    document.body.textContent?.includes(MIKE_OWN_NOTE),
    "the scan would have passed over a page with none of Mike's own notes on it",
  )
  rtl.cleanup()

  rtl.render(await ItemPage({ params: { book: BOOK, id: `note:${visible.id}` } }))
  surfaces.push(['the detail page', document.body.innerHTML])
  rtl.cleanup()

  rtl.render(await ItemPage({ params: { book: BOOK, id: 'note:no-such-note' } }))
  surfaces.push(['the refusal page', document.body.innerHTML])

  for (const [name, sentinel] of sentinels) {
    for (const [surface, html] of surfaces) {
      assert.ok(!html.includes(sentinel), `${surface} rendered ${name}`)
    }
  }

  // The administrator's own secret and session never reach a page either.
  for (const [surface, html] of surfaces) {
    assert.ok(!html.includes(process.env.ADMIN_AUTH_SECRET as string), `${surface} rendered the admin secret`)
    assert.ok(
      !html.includes(globalThis.__adminCookies?.[cookieName] as string),
      `${surface} rendered the session token`,
    )
    assert.ok(!html.includes(authorId), `${surface} rendered the author storage id`)
    assert.ok(!html.includes(tmpdir()), `${surface} rendered a filesystem path`)
  }
})

test('a shared highlight and a shared note both reach the inbox, so the scan is not vacuous', async () => {
  fresh()
  const seeded = await seedSecrets()
  await shared('WHAT-ANNA-ACTUALLY-SHARED')

  const board = await services.loadAuthorBoard({ kind: 'author', id: authorId })
  const bodies = board.rows.map((row) => row.body)

  assert.ok(bodies.includes('WHAT-ANNA-ACTUALLY-SHARED'))
  assert.ok(bodies.includes(MIKE_OWN_NOTE), "Mike's own note did not reach his own board")
  for (const sentinel of [...Object.values(SECRETS), seeded.privateHighlightId, PARAGRAPH]) {
    assert.ok(
      !JSON.stringify(board).includes(sentinel),
      `the board itself carries ${sentinel.slice(0, 32)}`,
    )
  }
})

/* ------------------------------------- C1: read marking needs a navigation */

/**
 * Three requests that are not Mike opening a page, and one that is.
 *
 * `Sec-Fetch-Dest: document` alone does not say a human navigated: a same-site
 * page can embed this URL in a hidden frame, the browser attaches the host-scoped
 * administrator cookie, and the GET-side write happens before any frame policy
 * could matter. An absent header claims nothing at all. Only the exact pair
 * `document` + `navigate` is an affirmative browser navigation, so only that pair
 * may move `lastReadAt`. Everything else still renders the authorized page -- Mike
 * is looking at his own item either way -- and says nothing was recorded.
 */
test('an embedded frame of the detail page marks nothing', async () => {
  fresh()
  const one = await shared('THE-FIRST')

  globalThis.__requestHeaders = { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' }
  const before = fingerprint()

  rtl.render(await ItemPage({ params: { book: BOOK, id: `note:${one.id}` } }))

  assert.ok(rtl.screen.getByText(/THE-FIRST/), 'an authorized frame was refused the item')
  assert.deepEqual(fingerprint(), before, 'a same-site iframe marked an item read')
  assert.ok(rtl.screen.getByText(/Nothing was recorded about this being read/))
})

test('a request with no Sec-Fetch headers at all marks nothing', async () => {
  fresh()
  const one = await shared('THE-FIRST')

  globalThis.__requestHeaders = {}
  const before = fingerprint()

  rtl.render(await ItemPage({ params: { book: BOOK, id: `note:${one.id}` } }))

  assert.ok(rtl.screen.getByText(/THE-FIRST/), 'a header-less request was refused the item')
  assert.deepEqual(fingerprint(), before, 'a request claiming nothing marked an item read')
  assert.ok(rtl.screen.getByText(/Nothing was recorded about this being read/))
})

test('a document destination without a navigation mode marks nothing', async () => {
  fresh()
  const one = await shared('THE-FIRST')

  globalThis.__requestHeaders = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'no-cors' }
  const before = fingerprint()

  rtl.render(await ItemPage({ params: { book: BOOK, id: `note:${one.id}` } }))

  assert.deepEqual(fingerprint(), before, 'a non-navigation document fetch marked an item read')
  assert.ok(rtl.screen.getByText(/Nothing was recorded about this being read/))
})

test('an affirmative navigation marks exactly one item', async () => {
  fresh()
  const one = await shared('THE-FIRST')
  const two = await shared('THE-SECOND')

  const readAt = async (id: string): Promise<string | null> => {
    const board = await services.loadAuthorBoard({ kind: 'author', id: authorId })
    return board.rows.find((row) => row.itemId === id)?.lastReadAt ?? null
  }

  globalThis.__requestHeaders = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' }
  rtl.render(await ItemPage({ params: { book: BOOK, id: `note:${one.id}` } }))

  assert.ok(rtl.screen.getByText(/Opening this counted as reading it/))
  assert.ok(await readAt(`note:${one.id}`), 'a real navigation did not mark the item read')
  assert.equal(await readAt(`note:${two.id}`), null, 'one navigation marked a second item')
})
