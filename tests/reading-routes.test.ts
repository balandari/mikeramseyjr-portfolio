import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

/*
 * The reading API, end to end, against the real production build.
 *
 * These are the tests that matter most, because every claim about isolation is
 * a claim about what a *request* can do -- not about what a function returns
 * when called correctly. So they serve the real handlers through Next's own
 * request handler, with real signed cookies, and try to do the things that
 * must not work:
 *
 *   - reviewer B reading or deleting reviewer A's bookmark or annotation
 *   - guessing an identifier
 *   - a revoked reviewer using a cookie that has not expired
 *   - a reviewer reaching a book they were never given
 *   - opening a private link with no session, with the wrong entitlement, or
 *     when the annotation is not actually shared by link
 *   - the author reaching a reviewer's private annotation
 *   - the author's own reading touching a reviewer's records
 *
 * Every environment variable is set *before* Next is prepared, so this suite
 * drives its own temporary roster, feedback and reading stores and never
 * touches the ones Mike's local preview uses.
 */

const ROOT = process.cwd()
const built = existsSync(join(ROOT, '.next', 'BUILD_ID'))
const skip = built ? false : 'no production build in .next -- run `npm run build` first'

const BOOK = 'the-backward-becoming'
const CHAPTER = 'chapter-one'
/** Loaded, and author-only: Mike has not made his line-by-line pass over it. */
const AUTHOR_ONLY_BOOK = 'persistent'
const AUTHOR_ONLY_CHAPTER = 'chapter-one'
const OTHER_REVIEWER_BOOK = 'not-a-real-book'
const ADMIN_EMAIL = 'author@example.test'

/* Codes exist only inside this process and are thrown away with the directory. */
const CODES = {
  anna: 'AAAABBBBCCCCDDDD',
  ben: 'EEEEFFFFGGGGHHHH',
  carla: 'JJJJKKKKLLLLMMMM',
  dora: 'NNNNPPPPQQQQRRRR',
  elin: 'SSSSTTTTVVVVWWWW',
}

let server: Server | null = null
let base = ''
let app: { prepare(): Promise<void>; getRequestHandler(): (req: unknown, res: unknown) => void; close(): Promise<void> } | null = null
let workDir = ''
const cookies: Record<string, string> = {}
let adminCookie = ''
let adminCsrf = ''

type Answer = { status: number; body: Record<string, unknown>; text: string }

async function call(
  path: string,
  options: {
    method?: string
    reviewer?: keyof typeof CODES
    admin?: boolean
    body?: unknown
  } = {},
): Promise<Answer> {
  const headers: Record<string, string> = {}
  const jar: string[] = []
  if (options.reviewer) jar.push(`mrj_reviewer=${cookies[options.reviewer]}`)
  if (options.admin) jar.push(`mrj_admin=${adminCookie}`)
  if (jar.length > 0) headers.cookie = jar.join('; ')
  if (options.body !== undefined) headers['content-type'] = 'application/json'

  const response = await fetch(base + path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
  })

  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    // An HTML page, which several of these assertions are about.
  }
  return { status: response.status, body, text }
}

test.before(async () => {
  if (skip) return

  workDir = mkdtempSync(join(tmpdir(), 'mrj-routes-'))
  const rosterDir = join(workDir, 'roster')
  const feedbackDir = join(workDir, 'feedback')
  mkdirSync(rosterDir, { recursive: true })
  mkdirSync(feedbackDir, { recursive: true })

  // Set before anything imports the libraries, and before Next loads its own
  // env files -- Next does not overwrite a variable that is already set, so
  // these win over `.env.local` and this suite never reads Mike's local state.
  process.env.REVIEWER_AUTH_SECRET = 'test-reviewer-secret-not-a-real-one'
  process.env.ADMIN_AUTH_SECRET = 'test-admin-secret-not-a-real-one'
  process.env.ADMIN_ALLOWED_EMAILS = ADMIN_EMAIL
  process.env.REVIEWER_ROSTER_DRIVER = 'fs'
  process.env.REVIEWER_ROSTER_DIR = rosterDir
  process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
  process.env.REVIEWER_FEEDBACK_DIR = feedbackDir
  process.env.REVIEWER_READING_DIR = join(workDir, 'reading')
  delete process.env.REVIEWER_ROSTER

  const { fingerprintAccessCode, mintReviewerToken } = await import('../lib/reviewer-access.ts')
  const { mintAdminToken, adminCsrfToken } = await import('../lib/admin-auth.ts')

  async function entry(
    id: keyof typeof CODES,
    name: string,
    books: string[],
    status: 'active' | 'revoked' = 'active',
  ) {
    const codeHash = await fingerprintAccessCode(CODES[id])
    assert.ok(codeHash, 'the test roster needs a signing secret')
    return {
      id,
      name,
      email: `${id}@example.test`,
      books,
      status,
      codeHash,
      createdAt: new Date(0).toISOString(),
      codeUpdatedAt: new Date(0).toISOString(),
      lastAccessAt: null,
    }
  }

  const reviewers = [
    await entry('anna', 'Anna', [BOOK]),
    await entry('ben', 'Ben', [BOOK]),
    // Entitled to nothing that exists, so every book is unauthorized for her.
    await entry('carla', 'Carla', [OTHER_REVIEWER_BOOK]),
    // Revoked, but holding a cookie that has not expired.
    await entry('dora', 'Dora', [BOOK], 'revoked'),
    /*
     * The adversarial case for the author-only rule: an active reviewer whose
     * roster entry *names* PERSISTENT. The dashboard cannot produce this entry
     * and the API refuses to write it, so it stands for the ways one could
     * exist anyway -- a hand-edited roster, a restored backup, an entry written
     * while the book was open to reviewers. She must still be refused
     * everywhere, and must keep her ordinary access to the book she really has.
     */
    await entry('elin', 'Elin', [BOOK, AUTHOR_ONLY_BOOK]),
  ]

  writeFileSync(
    join(rosterDir, 'roster.json'),
    JSON.stringify({ schema: 1, updatedAt: new Date().toISOString(), reviewers }, null, 2),
    'utf8',
  )

  for (const reviewer of reviewers) {
    const token = await mintReviewerToken({
      id: reviewer.id,
      name: reviewer.name,
      books: reviewer.books,
      codeHash: reviewer.codeHash as string,
    })
    assert.ok(token)
    cookies[reviewer.id as keyof typeof CODES] = token
  }

  const admin = await mintAdminToken(ADMIN_EMAIL)
  assert.ok(admin)
  adminCookie = admin
  const csrf = await adminCsrfToken(admin)
  assert.ok(csrf)
  adminCsrf = csrf

  const next = (await import('next')).default as unknown as (options: {
    dev: boolean
    dir: string
  }) => NonNullable<typeof app>
  app = next({ dev: false, dir: ROOT })
  await app.prepare()
  const handle = app.getRequestHandler()
  server = createServer((req, res) => void handle(req, res))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
})

test.after(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  if (app) await app.close()
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

/* ------------------------------------------------------------ the basics */

test('a signed-in reviewer starts with nothing, and that is not an error', { skip }, async () => {
  const answer = await call(`/review/api/reading?book=${BOOK}`, { reviewer: 'anna' })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.position, null)
  assert.deepEqual(answer.body.bookmarks, [])
  assert.deepEqual(answer.body.annotations, [])
})

test('an unauthenticated caller is refused with an answer it can act on', { skip }, async () => {
  for (const [method, path] of [
    ['GET', `/review/api/reading?book=${BOOK}`],
    ['POST', '/review/api/reading'],
    ['DELETE', `/review/api/reading?book=${BOOK}&bookmark=x`],
  ] as const) {
    const answer = await call(path, { method })
    assert.equal(answer.status, 401, `${method} ${path}`)
    // Not a redirect to a sign-in page, which a fetch would read as success.
    assert.equal(answer.body.error, 'not_authorized')
  }
})

/* ------------------------------------------------- many bookmarks, resume */

test('many bookmarks coexist in one book and each is removed on its own', { skip }, async () => {
  const first = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: { op: 'bookmark', bookSlug: BOOK, chapterSlug: CHAPTER, paragraphId: `${CHAPTER}-p004` },
  })
  assert.equal(first.status, 201)

  const second = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: { op: 'bookmark', bookSlug: BOOK, chapterSlug: CHAPTER, paragraphId: `${CHAPTER}-p009` },
  })
  assert.equal(second.status, 201)

  const listed = await call(`/review/api/reading?book=${BOOK}`, { reviewer: 'anna' })
  const bookmarks = listed.body.bookmarks as { id: string; excerpt: string }[]
  assert.equal(bookmarks.length, 2, 'the second did not replace the first')
  // The excerpt is the manuscript's own words, copied server-side.
  assert.ok(bookmarks[0].excerpt.length > 0)

  const removed = await call(
    `/review/api/reading?book=${BOOK}&bookmark=${bookmarks[0].id}`,
    { method: 'DELETE', reviewer: 'anna' },
  )
  assert.equal(removed.status, 200)

  const after = await call(`/review/api/reading?book=${BOOK}`, { reviewer: 'anna' })
  assert.equal((after.body.bookmarks as unknown[]).length, 1)
})

test('the automatic position is separate from every bookmark', { skip }, async () => {
  const saved = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: {
      op: 'position',
      bookSlug: BOOK,
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p020`,
    },
  })
  assert.equal(saved.status, 200)

  const listed = await call(`/review/api/reading?book=${BOOK}`, { reviewer: 'anna' })
  const position = listed.body.position as { paragraphId: string } | null
  assert.equal(position?.paragraphId, `${CHAPTER}-p020`)

  // Saving a position again overwrites it, and touches no bookmark.
  const before = (listed.body.bookmarks as unknown[]).length
  await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: {
      op: 'position',
      bookSlug: BOOK,
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p021`,
    },
  })
  const again = await call(`/review/api/reading?book=${BOOK}`, { reviewer: 'anna' })
  assert.equal((again.body.position as { paragraphId: string }).paragraphId, `${CHAPTER}-p021`)
  assert.equal((again.body.bookmarks as unknown[]).length, before)
})

/* ------------------------------------------------------------ annotations */

test('an annotation quotes the manuscript, never the request', { skip }, async () => {
  const created = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: {
      op: 'annotate',
      bookSlug: BOOK,
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p002`,
      startOffset: 0,
      endOffset: 12,
      note: 'This is the line.',
      visibility: 'private',
      // A quotation the caller would like stored. It must be ignored.
      quote: 'SOMETHING THE BOOK DOES NOT SAY',
    },
  })

  assert.equal(created.status, 201)
  const annotation = created.body.annotation as { quote: string; manuscriptSha256: string }
  assert.notEqual(annotation.quote, 'SOMETHING THE BOOK DOES NOT SAY')
  assert.equal(annotation.quote.length, 12)
  assert.match(annotation.manuscriptSha256, /^[a-f0-9]{64}$/)
})

test('offsets that do not fit the paragraph are refused', { skip }, async () => {
  for (const offsets of [
    { startOffset: 5, endOffset: 5 },
    { startOffset: 9, endOffset: 2 },
    { startOffset: -1, endOffset: 4 },
    { startOffset: 0, endOffset: 9_000_000 },
    { startOffset: '0', endOffset: 4 },
  ]) {
    const answer = await call('/review/api/reading', {
      method: 'POST',
      reviewer: 'anna',
      body: {
        op: 'annotate',
        bookSlug: BOOK,
        chapterSlug: CHAPTER,
        paragraphId: `${CHAPTER}-p002`,
        note: null,
        visibility: 'private',
        ...offsets,
      },
    })
    assert.equal(answer.status, 400, JSON.stringify(offsets))
  }
})

test('a paragraph that is not in the chapter is refused', { skip }, async () => {
  const answer = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: {
      op: 'annotate',
      bookSlug: BOOK,
      chapterSlug: CHAPTER,
      paragraphId: 'chapter-one-p999',
      startOffset: 0,
      endOffset: 4,
      note: null,
      visibility: 'private',
    },
  })
  assert.equal(answer.status, 400)
})

/* ------------------------------------------------------- cross-reviewer */

test('reviewer B cannot retrieve or mutate reviewer A’s records', { skip }, async () => {
  const annas = await call(`/review/api/reading?book=${BOOK}`, { reviewer: 'anna' })
  const bookmarkId = (annas.body.bookmarks as { id: string }[])[0].id
  const annotationId = (annas.body.annotations as { id: string }[])[0].id

  // Ben is entitled to the same book, and still sees none of Anna's material.
  const bens = await call(`/review/api/reading?book=${BOOK}`, { reviewer: 'ben' })
  assert.equal(bens.status, 200)
  assert.deepEqual(bens.body.bookmarks, [])
  assert.deepEqual(bens.body.annotations, [])
  assert.equal(bens.body.position, null)

  // Nor can he delete them with their real identifiers.
  const deleteBookmark = await call(
    `/review/api/reading?book=${BOOK}&bookmark=${bookmarkId}`,
    { method: 'DELETE', reviewer: 'ben' },
  )
  assert.equal(deleteBookmark.status, 404)

  const deleteAnnotation = await call(
    `/review/api/reading?book=${BOOK}&annotation=${annotationId}`,
    { method: 'DELETE', reviewer: 'ben' },
  )
  assert.equal(deleteAnnotation.status, 404)

  const share = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'ben',
    body: { op: 'annotation-update', bookSlug: BOOK, id: annotationId, visibility: 'link' },
  })
  assert.equal(share.status, 404, 'Ben cannot re-share what is not his')

  // And Anna's records are exactly as she left them.
  const after = await call(`/review/api/reading?book=${BOOK}`, { reviewer: 'anna' })
  assert.equal((after.body.bookmarks as { id: string }[])[0].id, bookmarkId)
  assert.equal(
    (after.body.annotations as { visibility: string }[])[0].visibility,
    'private',
  )
})

test('a guessed identifier reaches nothing', { skip }, async () => {
  for (const id of [
    '00000000-0000-4000-8000-000000000000',
    '../../../etc/passwd',
    'x',
    '%2e%2e%2f',
  ]) {
    const bookmark = await call(
      `/review/api/reading?book=${BOOK}&bookmark=${encodeURIComponent(id)}`,
      { method: 'DELETE', reviewer: 'anna' },
    )
    assert.equal(bookmark.status, 404, `bookmark ${id}`)

    const annotation = await call(
      `/review/api/reading?book=${BOOK}&annotation=${encodeURIComponent(id)}`,
      { method: 'DELETE', reviewer: 'anna' },
    )
    assert.equal(annotation.status, 404, `annotation ${id}`)
  }
})

/* ----------------------------------------------- entitlement and revocation */

test('a reviewer cannot reach a book they were not given', { skip }, async () => {
  const read = await call(`/review/api/reading?book=${BOOK}`, { reviewer: 'carla' })
  assert.equal(read.status, 404, 'not 403 -- the two must be indistinguishable')

  const write = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'carla',
    body: { op: 'bookmark', bookSlug: BOOK, chapterSlug: CHAPTER, paragraphId: `${CHAPTER}-p004` },
  })
  assert.equal(write.status, 404)

  // And the reader page is the same 404, not a redirect and not a partial page.
  const page = await call(`/review/${BOOK}/${CHAPTER}`, { reviewer: 'carla' })
  assert.equal(page.status, 404)
  assert.ok(!page.text.includes('galvanized bucket'), 'no manuscript text leaks')
})

test('a revoked reviewer is refused even with a cookie that has not expired', { skip }, async () => {
  const read = await call(`/review/api/reading?book=${BOOK}`, { reviewer: 'dora' })
  assert.equal(read.status, 401)

  const write = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'dora',
    body: { op: 'bookmark', bookSlug: BOOK, chapterSlug: CHAPTER, paragraphId: `${CHAPTER}-p004` },
  })
  assert.equal(write.status, 401)
})

/* -------------------------------------------------------- private links */

test('a private link opens for an entitled reviewer, and for nobody else', { skip }, async () => {
  // Anna shares one of her annotations by link.
  const annas = await call(`/review/api/reading?book=${BOOK}`, { reviewer: 'anna' })
  const annotationId = (annas.body.annotations as { id: string }[])[0].id

  const shared = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: { op: 'annotation-update', bookSlug: BOOK, id: annotationId, visibility: 'link' },
  })
  assert.equal(shared.status, 200)
  const token = (shared.body.annotation as { shareToken: string }).shareToken
  assert.match(token, /^[a-f0-9]{32}$/)
  const link = `/review/shared/${token}`

  // Ben holds the link and is entitled to the book: he may read it.
  const bens = await call(link, { reviewer: 'ben' })
  assert.equal(bens.status, 200)
  assert.ok(bens.text.includes('This is the line.'), 'the note is shown')

  // Carla holds the same link and is not entitled to the book.
  const carlas = await call(link, { reviewer: 'carla' })
  assert.equal(carlas.status, 200, 'the page renders')
  assert.ok(carlas.text.includes('You need access to open this'), 'and refuses')
  assert.ok(!carlas.text.includes('This is the line.'), 'the note is not disclosed')

  // A revoked reviewer holding the link.
  const doras = await call(link, { reviewer: 'dora' })
  assert.ok(!doras.text.includes('This is the line.'))

  // Nobody at all.
  const anonymous = await call(link)
  assert.equal(anonymous.status, 200)
  assert.ok(anonymous.text.includes('You need access to open this'))
  assert.ok(!anonymous.text.includes('This is the line.'))

  // A token nobody minted looks exactly the same to an entitled reviewer, so
  // the link cannot be used to find out whether a note exists.
  const invented = await call(`/review/shared/${'a'.repeat(32)}`, { reviewer: 'ben' })
  assert.ok(invented.text.includes('You need access to open this'))
})

test('narrowing the sharing closes the link again', { skip }, async () => {
  const annas = await call(`/review/api/reading?book=${BOOK}`, { reviewer: 'anna' })
  const annotation = (annas.body.annotations as { id: string; shareToken: string }[])[0]
  const link = `/review/shared/${annotation.shareToken}`

  assert.ok((await call(link, { reviewer: 'ben' })).text.includes('This is the line.'))

  const narrowed = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: { op: 'annotation-update', bookSlug: BOOK, id: annotation.id, visibility: 'private' },
  })
  assert.equal(narrowed.status, 200)

  const after = await call(link, { reviewer: 'ben' })
  assert.ok(after.text.includes('You need access to open this'))
  assert.ok(!after.text.includes('This is the line.'))
})

/* ------------------------------------------------------------ the author */

test('the author reads every loaded manuscript, PERSISTENT included', { skip }, async () => {
  const library = await call('/admin/read', { admin: true })
  assert.equal(library.status, 200)
  assert.ok(library.text.includes('The Backward Becoming'))
  assert.ok(library.text.includes('PERSISTENT'), 'the author-only manuscript is his to read')

  const chapter = await call(`/admin/read/${BOOK}/${CHAPTER}`, { admin: true })
  assert.equal(chapter.status, 200)

  // Its contents list every one of the 29 chapters, and they open with prose.
  const contents = await call(`/admin/read/${AUTHOR_ONLY_BOOK}`, { admin: true })
  assert.equal(contents.status, 200)
  assert.ok(contents.text.includes('Chapter Twenty-Nine'))

  const first = await call(`/admin/read/${AUTHOR_ONLY_BOOK}/${AUTHOR_ONLY_CHAPTER}`, {
    admin: true,
  })
  assert.equal(first.status, 200)
  assert.ok(first.text.includes('The sentence was thirteen words long.'))

  const last = await call(`/admin/read/${AUTHOR_ONLY_BOOK}/chapter-twenty-nine`, {
    admin: true,
  })
  assert.equal(last.status, 200)
})

/* --------------------------------------------------- the author-only book */

/*
 * PERSISTENT is loaded so that Mike can read it, and for no other reason. What
 * follows is the "fails closed" half of that: every reviewer-facing door, tried
 * by somebody whose roster entry actually names the book.
 */

test('a reviewer granted the author-only book still cannot reach it', { skip }, async () => {
  // Her library names only the book she may really read.
  const library = await call('/review', { reviewer: 'elin' })
  assert.equal(library.status, 200)
  assert.ok(library.text.includes('The Backward Becoming'))
  assert.ok(!library.text.includes('PERSISTENT'), 'not listed to a reviewer')

  // Guessing the slug reaches nothing, and answers "not here" rather than "not
  // allowed", so the reader cannot be used to discover unpublished work.
  for (const path of [
    `/review/${AUTHOR_ONLY_BOOK}`,
    `/review/${AUTHOR_ONLY_BOOK}/${AUTHOR_ONLY_CHAPTER}`,
    `/review/${AUTHOR_ONLY_BOOK}/chapter-twenty-nine`,
  ]) {
    const answer = await call(path, { reviewer: 'elin' })
    assert.equal(answer.status, 404, path)
    assert.ok(!answer.text.includes('The sentence was thirteen words long.'), path)
  }

  const listed = await call(`/review/api/reading?book=${AUTHOR_ONLY_BOOK}`, {
    reviewer: 'elin',
  })
  assert.equal(listed.status, 404)

  const paragraph = `${AUTHOR_ONLY_CHAPTER}-p001`
  for (const body of [
    { op: 'position', bookSlug: AUTHOR_ONLY_BOOK, chapterSlug: AUTHOR_ONLY_CHAPTER, paragraphId: paragraph },
    { op: 'bookmark', bookSlug: AUTHOR_ONLY_BOOK, chapterSlug: AUTHOR_ONLY_CHAPTER, paragraphId: paragraph },
    {
      op: 'annotate',
      bookSlug: AUTHOR_ONLY_BOOK,
      chapterSlug: AUTHOR_ONLY_CHAPTER,
      paragraphId: paragraph,
      startOffset: 0,
      endOffset: 8,
    },
  ]) {
    const answer = await call('/review/api/reading', {
      method: 'POST',
      reviewer: 'elin',
      body,
    })
    assert.equal(answer.status, 404, String(body.op))
  }

  // And she cannot send Mike a comment on it either.
  const comment = await call('/review/api/feedback', {
    method: 'POST',
    reviewer: 'elin',
    body: {
      bookSlug: AUTHOR_ONLY_BOOK,
      chapterSlug: AUTHOR_ONLY_CHAPTER,
      scope: 'chapter',
      comment: 'This should never be recorded.',
    },
  })
  assert.equal(comment.status, 404)

  // Her real entitlement is untouched by any of that.
  assert.equal((await call(`/review/${BOOK}/${CHAPTER}`, { reviewer: 'elin' })).status, 200)
})

test('the author-only book is refused to every other kind of caller', { skip }, async () => {
  // An ordinary reviewer, never granted it.
  assert.equal((await call(`/review/${AUTHOR_ONLY_BOOK}`, { reviewer: 'anna' })).status, 404)
  assert.equal(
    (await call(`/review/api/reading?book=${AUTHOR_ONLY_BOOK}`, { reviewer: 'anna' })).status,
    404,
  )

  // A revoked reviewer holding an unexpired cookie.
  assert.equal(
    (await call(`/review/api/reading?book=${AUTHOR_ONLY_BOOK}`, { reviewer: 'dora' })).status,
    401,
  )

  // Nobody at all.
  const anonymous = await call(`/review/${AUTHOR_ONLY_BOOK}/${AUTHOR_ONLY_CHAPTER}`)
  assert.ok(anonymous.status === 307 || anonymous.status === 404)
  assert.ok(!anonymous.text.includes('The sentence was thirteen words long.'))

  const anonymousApi = await call(`/review/api/reading?book=${AUTHOR_ONLY_BOOK}`)
  assert.equal(anonymousApi.status, 401)
})

test('the entitlement controls do not offer the author-only book', { skip }, async () => {
  const dashboard = await call('/admin', { admin: true })
  assert.equal(dashboard.status, 200)
  assert.ok(dashboard.text.includes(BOOK))
  assert.ok(
    !dashboard.text.includes(`value="${AUTHOR_ONLY_BOOK}"`),
    'no checkbox for a book that cannot be granted',
  )

  // And the endpoint refuses the grant even when it is asked for directly.
  const granted = await call('/admin/api/reviewers', {
    method: 'POST',
    admin: true,
    body: {
      op: 'books',
      reviewerId: 'anna',
      books: [BOOK, AUTHOR_ONLY_BOOK],
      csrf: adminCsrf,
    },
  })
  assert.ok(granted.status >= 400, `expected a refusal, got ${granted.status}`)

  // Anna is unchanged, and still cannot reach it.
  assert.equal((await call(`/review/${AUTHOR_ONLY_BOOK}`, { reviewer: 'anna' })).status, 404)
  assert.equal((await call(`/review/${BOOK}`, { reviewer: 'anna' })).status, 200)
})

test('author reading is a separate namespace and never touches reviewer records', { skip }, async () => {
  const before = await call(`/review/api/reading?book=${BOOK}`, { reviewer: 'anna' })

  const saved = await call('/admin/api/reading', {
    method: 'POST',
    admin: true,
    body: {
      op: 'bookmark',
      bookSlug: BOOK,
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p004`,
      csrf: adminCsrf,
    },
  })
  assert.equal(saved.status, 201)

  const mine = await call(`/admin/api/reading?book=${BOOK}`, { admin: true })
  assert.equal((mine.body.bookmarks as unknown[]).length, 1)

  // Anna's records are untouched, and she cannot see the author's.
  const after = await call(`/review/api/reading?book=${BOOK}`, { reviewer: 'anna' })
  assert.deepEqual(after.body.bookmarks, before.body.bookmarks)
  assert.deepEqual(after.body.annotations, before.body.annotations)
  assert.deepEqual(after.body.position, before.body.position)
})

test('a reviewer cannot use the author’s endpoint, and the author cannot use a reviewer’s', { skip }, async () => {
  const reviewerAtAdmin = await call(`/admin/api/reading?book=${BOOK}`, { reviewer: 'anna' })
  assert.equal(reviewerAtAdmin.status, 401)

  const adminAtReview = await call(`/review/api/reading?book=${BOOK}`, { admin: true })
  assert.equal(adminAtReview.status, 401)
})

test('the author’s mutations require the session’s CSRF token', { skip }, async () => {
  const withoutToken = await call('/admin/api/reading', {
    method: 'POST',
    admin: true,
    body: { op: 'bookmark', bookSlug: BOOK, chapterSlug: CHAPTER, paragraphId: `${CHAPTER}-p006` },
  })
  assert.equal(withoutToken.status, 403)

  const wrongToken = await call('/admin/api/reading', {
    method: 'POST',
    admin: true,
    body: {
      op: 'bookmark',
      bookSlug: BOOK,
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p006`,
      csrf: 'not-the-token',
    },
  })
  assert.equal(wrongToken.status, 403)
})

test('the author sees what was shared with him, and never a private annotation', { skip }, async () => {
  // Anna has one private annotation. Ben writes one and shares it with Mike.
  const bensNote = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'ben',
    body: {
      op: 'annotate',
      bookSlug: BOOK,
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p005`,
      startOffset: 0,
      endOffset: 10,
      note: 'BEN SHARED THIS WITH MIKE',
      visibility: 'author',
    },
  })
  assert.equal(bensNote.status, 201)

  const page = await call('/admin/read', { admin: true })
  assert.equal(page.status, 200)
  assert.ok(page.text.includes('BEN SHARED THIS WITH MIKE'), 'the shared note is there')
  assert.ok(
    !page.text.includes('This is the line.'),
    'Anna’s private annotation is not, and never is',
  )
})

test('the author cannot open a reviewer’s private annotation by its link route', { skip }, async () => {
  const annas = await call(`/review/api/reading?book=${BOOK}`, { reviewer: 'anna' })
  const annotation = (annas.body.annotations as { shareToken: string | null }[])[0]
  // Its token still exists from the earlier share; the annotation is private now.
  assert.ok(annotation.shareToken)

  const answer = await call(`/admin/shared/${annotation.shareToken}`, { admin: true })
  assert.equal(answer.status, 200)
  assert.ok(!answer.text.includes('This is the line.'))
  assert.ok(answer.text.includes('does not open anything you can see'))
})

/* ------------------------------------------------------- the workspace */

test('the workspace lists a reviewer’s own material and links back to it', { skip }, async () => {
  const page = await call('/review/my-reading', { reviewer: 'anna' })
  assert.equal(page.status, 200)
  assert.ok(page.text.includes('My reading'))
  assert.ok(page.text.includes('The Backward Becoming'))
  // Every location-based item links to its exact passage.
  assert.match(page.text, new RegExp(`/review/${BOOK}/${CHAPTER}#${CHAPTER}-p\\d{3}`))
  // And nothing of Ben's is in it.
  assert.ok(!page.text.includes('BEN SHARED THIS WITH MIKE'))
})

test('the workspace shows submitted feedback as durable history', { skip }, async () => {
  const sent = await call('/review/api/feedback', {
    method: 'POST',
    reviewer: 'anna',
    body: {
      bookSlug: BOOK,
      chapterSlug: CHAPTER,
      scope: 'chapter',
      paragraphId: null,
      comment: 'A COMMENT ANNA SENT',
    },
  })
  assert.equal(sent.status, 201)

  const page = await call('/review/my-reading', { reviewer: 'anna' })
  assert.ok(page.text.includes('A COMMENT ANNA SENT'))
  assert.ok(page.text.includes('Comments you sent'))

  // Ben's workspace does not contain it.
  const bens = await call('/review/my-reading', { reviewer: 'ben' })
  assert.ok(!bens.text.includes('A COMMENT ANNA SENT'))
})

test('the workspace needs a session', { skip }, async () => {
  const answer = await call('/review/my-reading')
  assert.equal(answer.status, 307, 'redirected to the gate, not rendered')
})

/* ------------------------------------------------------- privacy headers */

test('every private reading response refuses caching and indexing', { skip }, async () => {
  for (const path of [
    `/review/api/reading?book=${BOOK}`,
    '/review/my-reading',
    `/review/${BOOK}/${CHAPTER}`,
  ]) {
    const response = await fetch(base + path, {
      headers: { cookie: `mrj_reviewer=${cookies.anna}` },
      redirect: 'manual',
    })
    assert.match(response.headers.get('cache-control') ?? '', /no-store/, path)
    assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/, path)
  }
})

/* ------------------------------------------------------- resolved on write */

/*
 * Found by looking at the page rather than by a test: a highlight was stored
 * correctly and then not drawn.
 *
 * The endpoint returned the raw stored record, which carries no `anchorState`,
 * while the reader only draws a highlight whose anchor it has been told is
 * `ok` -- deliberately, because drawing one it has not checked is exactly the
 * silent re-attachment this feature refuses. So the record came back, went into
 * state, and was filtered straight out again. Every mutation now answers in the
 * same resolved shape a listing uses.
 */
test('a record comes back in the same shape a listing returns', { skip }, async () => {
  const bookmark = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'ben',
    body: { op: 'bookmark', bookSlug: BOOK, chapterSlug: CHAPTER, paragraphId: `${CHAPTER}-p030` },
  })
  assert.equal(bookmark.status, 201)
  assert.equal((bookmark.body.bookmark as { anchorState: string }).anchorState, 'ok')

  const annotation = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'ben',
    body: {
      op: 'annotate',
      bookSlug: BOOK,
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p030`,
      startOffset: 0,
      endOffset: 8,
      note: null,
      visibility: 'private',
    },
  })
  assert.equal(annotation.status, 201)
  const created = annotation.body.annotation as {
    anchorState: string
    own: boolean
    sharePath: string | null
  }
  assert.equal(created.anchorState, 'ok', 'the browser can draw it immediately')
  assert.equal(created.own, true)
  assert.equal(created.sharePath, null, 'a private annotation has no link to show')

  const shared = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'ben',
    body: {
      op: 'annotation-update',
      bookSlug: BOOK,
      id: (annotation.body.annotation as { id: string }).id,
      visibility: 'link',
    },
  })
  assert.equal(shared.status, 200)
  const updated = shared.body.annotation as { anchorState: string; sharePath: string | null }
  assert.equal(updated.anchorState, 'ok')
  assert.match(updated.sharePath ?? '', /^\/review\/shared\/[a-f0-9]{32}$/)
})
