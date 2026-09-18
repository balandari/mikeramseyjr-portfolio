import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

/*
 * The note contract, end to end, against the real production build.
 *
 * These are the tests that decide whether the contract is real, because every
 * claim it makes is a claim about what a *request* can do -- not about what a
 * function returns when it is called correctly. So they serve the real handlers
 * through Next's own request handler, with real signed cookies, and try to do
 * the things that must not work:
 *
 *   - writing a note that reaches Mike without saying so
 *   - an author note that claims to be shareable
 *   - a reviewer reading, editing or deleting another reviewer's note
 *   - Mike reaching a reviewer's private note at any scope, on any surface
 *   - a reviewer reaching one of Mike's notes
 *   - submitting a comment through the retired endpoint by hand
 *   - a note quoting words the manuscript does not contain
 *
 * and the things that must: the one composer's one save at every scope, notes
 * surviving the roster, edits that preserve when something was written, and
 * every byte of the old stores still exactly as it was.
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
const AUTHOR_ONLY_BOOK = 'persistent'
const ADMIN_EMAIL = 'author@example.test'

const CODES = {
  anna: 'AAAABBBBCCCCDDDD',
  ben: 'EEEEFFFFGGGGHHHH',
  carla: 'JJJJKKKKLLLLMMMM',
  /*
   * Dina is deliberately **not** in the roster this suite starts with. She is
   * added, entitled, used and removed inside the one test that is about
   * entitlement, so nothing else in this file sees a fourth reviewer. Her code
   * lives here only so `call({ reviewer: 'dina' })` type-checks.
   */
  dina: 'NNNNPPPPQQQQRRRR',
}

let server: Server | null = null
let base = ''
let app: {
  prepare(): Promise<void>
  getRequestHandler(): (req: unknown, res: unknown) => void
  close(): Promise<void>
} | null = null
let workDir = ''
let rosterPath = ''
let feedbackDir = ''
let readingDir = ''
const cookies: Record<string, string> = {}
let adminCookie = ''
let adminCsrf = ''

type Answer = {
  status: number
  body: Record<string, unknown>
  text: string
  headers: Headers
}

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
  return { status: response.status, body, text, headers: response.headers }
}

/** Write one note as one reader, and answer with what the server stored. */
async function writeNote(
  who: { reviewer?: keyof typeof CODES; admin?: boolean },
  fields: Record<string, unknown>,
): Promise<Answer> {
  return call(who.admin ? '/admin/api/reading' : '/review/api/reading', {
    method: 'POST',
    ...who,
    body: {
      op: 'note-create',
      bookSlug: BOOK,
      ...(who.admin ? { csrf: adminCsrf } : {}),
      ...fields,
    },
  })
}

type StoredNote = {
  id: string
  ownerKind: string
  ownerId: string
  scope: string
  body: string
  visibility: string
  status: string
  anchor: Record<string, unknown>
  revision: number
  createdAt: string
  updatedAt: string
  anchorState: string
  paragraphId: string | null
}

async function notesOf(who: {
  reviewer?: keyof typeof CODES
  admin?: boolean
}): Promise<StoredNote[]> {
  const url = who.admin ? '/admin/api/reading' : '/review/api/reading'
  const answer = await call(`${url}?book=${BOOK}`, who)
  return (answer.body.notes ?? []) as StoredNote[]
}

/** Every file beneath a directory, with its bytes. The byte-unchanged proof. */
function fingerprintTree(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (current: string, prefix: string) => {
    if (!existsSync(current)) return
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(current, entry.name)
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(full, rel)
      else out.set(rel, createHash('sha256').update(readFileSync(full)).digest('hex'))
    }
  }
  walk(dir, '')
  return out
}

test.before(async () => {
  if (skip) return

  workDir = mkdtempSync(join(tmpdir(), 'mrj-notes-routes-'))
  const rosterDir = join(workDir, 'roster')
  feedbackDir = join(workDir, 'feedback')
  readingDir = join(workDir, 'reading')
  mkdirSync(rosterDir, { recursive: true })
  mkdirSync(feedbackDir, { recursive: true })
  rosterPath = join(rosterDir, 'roster.json')

  process.env.REVIEWER_AUTH_SECRET = 'test-reviewer-secret-not-a-real-one'
  process.env.ADMIN_AUTH_SECRET = 'test-admin-secret-not-a-real-one'
  process.env.ADMIN_ALLOWED_EMAILS = ADMIN_EMAIL
  process.env.REVIEWER_ROSTER_DRIVER = 'fs'
  process.env.REVIEWER_ROSTER_DIR = rosterDir
  process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
  process.env.REVIEWER_FEEDBACK_DIR = feedbackDir
  process.env.REVIEWER_READING_DIR = readingDir
  delete process.env.REVIEWER_ROSTER

  const { fingerprintAccessCode, mintReviewerToken } = await import('../lib/reviewer-access.ts')
  const { mintAdminToken, adminCsrfToken } = await import('../lib/admin-auth.ts')

  async function entry(id: keyof typeof CODES, name: string, books: string[]) {
    const codeHash = await fingerprintAccessCode(CODES[id])
    assert.ok(codeHash, 'the test roster needs a signing secret')
    return {
      id,
      name,
      email: `${id}@example.test`,
      books,
      status: 'active' as const,
      codeHash,
      createdAt: new Date(0).toISOString(),
      codeUpdatedAt: new Date(0).toISOString(),
      lastAccessAt: null,
    }
  }

  const reviewers = [
    await entry('anna', 'Anna', [BOOK]),
    await entry('ben', 'Ben', [BOOK]),
    // Entitled to this book now. Her entry is removed part-way through, to
    // prove what that does and does not do to what she shared.
    await entry('carla', 'Carla', [BOOK]),
  ]

  writeFileSync(
    rosterPath,
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

  /*
   * One row in the retired store, written directly rather than through the
   * endpoint -- because the endpoint no longer accepts one, which is the point.
   * It stands for every comment submitted before notes existed, and its bytes
   * are checked at the end of this file.
   */
  writeFileSync(
    join(feedbackDir, `${BOOK}.ndjson`),
    `${JSON.stringify({
      schema: 1,
      id: '11111111-2222-3333-4444-555555555555',
      createdAt: '2026-02-01T09:00:00.000Z',
      reviewerId: 'anna',
      bookSlug: BOOK,
      chapterSlug: CHAPTER,
      chapterNumber: 1,
      scope: 'chapter',
      paragraphId: null,
      paragraphOrdinal: null,
      quote: null,
      comment: 'ANNA SUBMITTED THIS UNDER THE OLD MODEL',
    })}\n`,
    'utf8',
  )

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

/* ------------------------------------------------- the one composer's save */

test('one save writes a note at every scope a reviewer has', { skip }, async () => {
  const passage = await writeNote(
    { reviewer: 'anna' },
    {
      scope: 'passage',
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p002`,
      startOffset: 0,
      endOffset: 12,
      body: 'ANNA ON A PASSAGE',
      visibility: 'private',
    },
  )
  assert.equal(passage.status, 201)
  const passageNote = passage.body.note as StoredNote
  assert.equal(passageNote.scope, 'passage')
  assert.equal((passageNote.anchor.quote as string).length, 12)
  assert.match(passageNote.anchor.manuscriptSha256 as string, /^[a-f0-9]{64}$/)

  const paragraph = await writeNote(
    { reviewer: 'anna' },
    {
      scope: 'paragraph',
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p003`,
      body: 'ANNA ON A PARAGRAPH',
      visibility: 'private',
    },
  )
  assert.equal(paragraph.status, 201)
  const paragraphNote = paragraph.body.note as StoredNote
  assert.equal(paragraphNote.scope, 'paragraph')
  // The complete paragraph, copied from the manuscript, and its fingerprint.
  assert.ok((paragraphNote.anchor.paragraphText as string).length > 0)
  assert.match(paragraphNote.anchor.manuscriptSha256 as string, /^[a-f0-9]{64}$/)
  assert.equal(paragraphNote.anchor.startOffset, undefined, 'no fabricated offsets')

  const chapterNote = await writeNote(
    { reviewer: 'anna' },
    { scope: 'chapter', chapterSlug: CHAPTER, body: 'ANNA ON A CHAPTER', visibility: 'private' },
  )
  assert.equal(chapterNote.status, 201)
  const row = chapterNote.body.note as StoredNote
  assert.equal(row.scope, 'chapter')
  assert.match(row.anchor.manuscriptSha256 as string, /^[a-f0-9]{64}$/)
  assert.equal(row.anchor.paragraphId, undefined, 'no fabricated paragraph')
})

test('a note quotes the manuscript, never the request', { skip }, async () => {
  const created = await writeNote(
    { reviewer: 'anna' },
    {
      scope: 'passage',
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p004`,
      startOffset: 0,
      endOffset: 10,
      body: 'quoting check',
      visibility: 'private',
      // A quotation, a paragraph text and a fingerprint the caller would like
      // stored. Every one of them must be ignored.
      quote: 'SOMETHING THE BOOK DOES NOT SAY',
      paragraphText: 'NOR THIS',
      manuscriptSha256: 'f'.repeat(64),
      anchor: { scope: 'book' },
    },
  )
  assert.equal(created.status, 201)
  const note = created.body.note as StoredNote
  assert.equal(note.scope, 'passage', 'the anchor is built here, never accepted')
  assert.notEqual(note.anchor.quote, 'SOMETHING THE BOOK DOES NOT SAY')
  assert.equal((note.anchor.quote as string).length, 10)
  assert.notEqual(note.anchor.manuscriptSha256, 'f'.repeat(64))
})

test('a reviewer cannot write a note about the whole book', { skip }, async () => {
  // The contract supports the scope; the reviewer composer does not offer it,
  // and the server refuses it rather than trusting the composer to have.
  const answer = await writeNote(
    { reviewer: 'anna' },
    { scope: 'book', body: 'not mine to write', visibility: 'private' },
  )
  assert.equal(answer.status, 400)
})

test('a note with nothing written in it is refused', { skip }, async () => {
  for (const body of ['', '   \n  ', null, 42, undefined, 'x'.repeat(4001)]) {
    const answer = await writeNote(
      { reviewer: 'anna' },
      { scope: 'chapter', chapterSlug: CHAPTER, body, visibility: 'private' },
    )
    assert.equal(answer.status, 400, JSON.stringify(body) ?? 'undefined')
  }
})

test('an unreleased chapter and an invented paragraph are both refused', { skip }, async () => {
  const noChapter = await writeNote(
    { reviewer: 'anna' },
    { scope: 'chapter', chapterSlug: 'chapter-nine-hundred', body: 'nope', visibility: 'private' },
  )
  assert.equal(noChapter.status, 404)

  const noParagraph = await writeNote(
    { reviewer: 'anna' },
    {
      scope: 'paragraph',
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p999`,
      body: 'nope',
      visibility: 'private',
    },
  )
  assert.equal(noParagraph.status, 400)
})

/* ---------------------------------------------------------- fail private */

test('a note whose visibility is missing or unrecognised is private', { skip }, async () => {
  for (const visibility of [
    undefined,
    null,
    '',
    'author',
    'link',
    'public',
    'Shared',
    'shared ',
    1,
    true,
    ['shared'],
  ]) {
    const answer = await writeNote(
      { reviewer: 'anna' },
      {
        scope: 'chapter',
        chapterSlug: CHAPTER,
        body: `fail private ${String(visibility)}`,
        ...(visibility === undefined ? {} : { visibility }),
      },
    )
    assert.equal(answer.status, 201)
    assert.equal(
      (answer.body.note as StoredNote).visibility,
      'private',
      `${JSON.stringify(visibility) ?? 'undefined'} must not reach Mike`,
    )
  }
})

test('sharing is only ever an explicit, recognised choice', { skip }, async () => {
  const answer = await writeNote(
    { reviewer: 'anna' },
    {
      scope: 'chapter',
      chapterSlug: CHAPTER,
      body: 'ANNA SHARED THIS DELIBERATELY',
      visibility: 'shared',
    },
  )
  assert.equal(answer.status, 201)
  assert.equal((answer.body.note as StoredNote).visibility, 'shared')
})

/* ------------------------------------------------------------- edit rules */

test('editing preserves when it was written and records when it was revised', { skip }, async () => {
  const created = await writeNote(
    { reviewer: 'ben' },
    { scope: 'chapter', chapterSlug: CHAPTER, body: 'BEN FIRST DRAFT', visibility: 'private' },
  )
  assert.equal(created.status, 201)
  const note = created.body.note as StoredNote

  await new Promise((resolve) => setTimeout(resolve, 5))

  const edited = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'ben',
    body: {
      op: 'note-update',
      bookSlug: BOOK,
      id: note.id,
      expectedRevision: note.revision,
      body: 'BEN SECOND DRAFT',
      visibility: 'shared',
    },
  })
  assert.equal(edited.status, 200)
  const after = edited.body.note as StoredNote

  assert.equal(after.body, 'BEN SECOND DRAFT')
  assert.equal(after.visibility, 'shared', 'the visibility change took effect')
  assert.equal(after.createdAt, note.createdAt, 'when it was written does not move')
  assert.ok(Date.parse(after.updatedAt) > Date.parse(note.updatedAt), 'when it was revised does')
  assert.deepEqual(after.anchor, note.anchor, 'and the anchor is written once')
})

test('a reviewer can take a shared note back to private', { skip }, async () => {
  const created = await writeNote(
    { reviewer: 'ben' },
    {
      scope: 'chapter',
      chapterSlug: CHAPTER,
      body: 'BEN CHANGED HIS MIND ABOUT THIS',
      visibility: 'shared',
    },
  )
  const note = created.body.note as StoredNote

  const shown = await call('/admin/read', { admin: true })
  assert.ok(shown.text.includes('BEN CHANGED HIS MIND ABOUT THIS'))

  const narrowed = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'ben',
    body: {
      op: 'note-update',
      bookSlug: BOOK,
      id: note.id,
      expectedRevision: note.revision,
      visibility: 'private',
    },
  })
  assert.equal(narrowed.status, 200)
  assert.equal((narrowed.body.note as StoredNote).visibility, 'private')

  const after = await call('/admin/read', { admin: true })
  assert.ok(
    !after.text.includes('BEN CHANGED HIS MIND ABOUT THIS'),
    'a note taken back is gone from every author surface',
  )
})

test('an invented visibility or status on an edit is refused, not ignored', { skip }, async () => {
  const created = await writeNote(
    { reviewer: 'ben' },
    { scope: 'chapter', chapterSlug: CHAPTER, body: 'BEN ON SCOPES', visibility: 'private' },
  )
  const note = created.body.note as StoredNote

  for (const changes of [
    { visibility: 'author' },
    { visibility: 'link' },
    { visibility: 'public' },
    // A reviewer has no triage state. Claiming one is refused rather than
    // silently dropped, so a caller is never told a change landed when it did not.
    { status: 'resolved' },
    { body: '' },
  ]) {
    const answer = await call('/review/api/reading', {
      method: 'POST',
      reviewer: 'ben',
      body: {
        op: 'note-update',
        bookSlug: BOOK,
        id: note.id,
        expectedRevision: note.revision,
        ...changes,
      },
    })
    assert.equal(answer.status, 400, JSON.stringify(changes))
  }

  const unchanged = (await notesOf({ reviewer: 'ben' })).find((row) => row.id === note.id)
  assert.equal(unchanged?.visibility, 'private')
  assert.equal(unchanged?.body, 'BEN ON SCOPES')
})

/* -------------------------------------------------------------- the author */

test("the author's note is private, and no request can make it otherwise", { skip }, async () => {
  const created = await writeNote(
    { admin: true },
    {
      scope: 'book',
      body: 'MIKE ON THE WHOLE BOOK',
      // Asked for directly. It must not be honoured anywhere.
      visibility: 'shared',
    },
  )
  assert.equal(created.status, 201)
  const note = created.body.note as StoredNote
  assert.equal(note.ownerKind, 'author')
  assert.equal(note.visibility, 'private')
  assert.deepEqual(note.anchor, { scope: 'book' }, 'a book note anchors to nothing')
  assert.equal(note.status, 'open')

  const edited = await call('/admin/api/reading', {
    method: 'POST',
    admin: true,
    body: {
      op: 'note-update',
      csrf: adminCsrf,
      bookSlug: BOOK,
      id: note.id,
      expectedRevision: note.revision,
      visibility: 'shared',
    },
  })
  assert.equal(edited.status, 400, 'he has no sharing control, so there is no such request')
})

test("the author can resolve and reopen one of his own notes", { skip }, async () => {
  const created = await writeNote(
    { admin: true },
    { scope: 'chapter', chapterSlug: CHAPTER, body: 'MIKE TO DEAL WITH' },
  )
  const note = created.body.note as StoredNote
  assert.equal(note.status, 'open')

  const resolved = await call('/admin/api/reading', {
    method: 'POST',
    admin: true,
    body: {
      op: 'note-update',
      csrf: adminCsrf,
      bookSlug: BOOK,
      id: note.id,
      expectedRevision: note.revision,
      status: 'resolved',
    },
  })
  assert.equal(resolved.status, 200)
  assert.equal((resolved.body.note as StoredNote).status, 'resolved')

  const reopened = await call('/admin/api/reading', {
    method: 'POST',
    admin: true,
    body: {
      op: 'note-update',
      csrf: adminCsrf,
      bookSlug: BOOK,
      id: note.id,
      // The resolve above was accepted, so the note is one revision on.
      expectedRevision: (resolved.body.note as StoredNote).revision,
      status: 'open',
    },
  })
  assert.equal((reopened.body.note as StoredNote).status, 'open')
})

test("the author's notes never appear on a reviewer surface", { skip }, async () => {
  await writeNote({ admin: true }, { scope: 'chapter', chapterSlug: CHAPTER, body: 'MIKE PRIVATE THOUGHT' })

  for (const [what, path, who] of [
    ['the reviewer reading API', `/review/api/reading?book=${BOOK}`, { reviewer: 'anna' as const }],
    ['the reviewer chapter', `/review/${BOOK}/${CHAPTER}`, { reviewer: 'anna' as const }],
    ['the reviewer contents', `/review/${BOOK}`, { reviewer: 'anna' as const }],
    ['the reviewer workspace', '/review/my-reading', { reviewer: 'anna' as const }],
    ['the legacy feedback read', `/review/api/feedback?book=${BOOK}`, { reviewer: 'anna' as const }],
  ] as const) {
    const answer = await call(path, who)
    assert.ok(!answer.text.includes('MIKE PRIVATE THOUGHT'), what)
    assert.ok(!answer.text.includes('MIKE ON THE WHOLE BOOK'), what)
  }

  // And a reviewer's own listing carries nothing of his.
  assert.equal(
    (await notesOf({ reviewer: 'anna' })).filter((row) => row.ownerKind === 'author').length,
    0,
  )
})

test("a reviewer cannot reach the author's note by its identifier", { skip }, async () => {
  const his = (await notesOf({ admin: true }))[0]
  assert.ok(his, 'the author has written one by now')

  const edit = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: {
      op: 'note-update',
      bookSlug: BOOK,
      id: his.id,
      expectedRevision: his.revision,
      body: 'not yours',
    },
  })
  assert.equal(edit.status, 404)

  const remove = await call(
    `/review/api/reading?book=${BOOK}&note=${his.id}&revision=${his.revision}`,
    { method: 'DELETE', reviewer: 'anna' },
  )
  // 404 even though the revision is right: the path that would name his note is
  // never built on her prefix, so the revision never gets a chance to matter.
  assert.equal(remove.status, 404)

  // Still exactly as he wrote it.
  assert.ok((await notesOf({ admin: true })).some((row) => row.id === his.id))
})

/* --------------------------------------------------- reviewer isolation */

test("one reviewer cannot read, edit or delete another's note", { skip }, async () => {
  const created = await writeNote(
    { reviewer: 'anna' },
    { scope: 'chapter', chapterSlug: CHAPTER, body: 'ANNA ONLY', visibility: 'private' },
  )
  const note = created.body.note as StoredNote

  const bensView = await notesOf({ reviewer: 'ben' })
  assert.ok(!bensView.some((row) => row.id === note.id))

  const edit = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'ben',
    body: {
      op: 'note-update',
      bookSlug: BOOK,
      id: note.id,
      expectedRevision: note.revision,
      body: 'BEN OVERWROTE IT',
    },
  })
  assert.equal(edit.status, 404, 'and not 403 -- an id must not be a way to enumerate')

  const remove = await call(
    `/review/api/reading?book=${BOOK}&note=${note.id}&revision=${note.revision}`,
    { method: 'DELETE', reviewer: 'ben' },
  )
  assert.equal(remove.status, 404)

  const survivor = (await notesOf({ reviewer: 'anna' })).find((row) => row.id === note.id)
  assert.equal(survivor?.body, 'ANNA ONLY')
})

test('an unauthenticated caller can write no note at all', { skip }, async () => {
  const answer = await call('/review/api/reading', {
    method: 'POST',
    body: { op: 'note-create', bookSlug: BOOK, scope: 'chapter', chapterSlug: CHAPTER, body: 'x' },
  })
  assert.equal(answer.status, 401)
  assert.equal(answer.body.error, 'not_authorized')
})

/* ------------------------------------------- private notes and the author */

test('a private reviewer note at every scope is absent from every author surface', { skip }, async () => {
  const marks = {
    passage: 'CARLA PRIVATE PASSAGE NOTE',
    paragraph: 'CARLA PRIVATE PARAGRAPH NOTE',
    chapter: 'CARLA PRIVATE CHAPTER NOTE',
  }

  await writeNote(
    { reviewer: 'carla' },
    {
      scope: 'passage',
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p006`,
      startOffset: 0,
      endOffset: 9,
      body: marks.passage,
      visibility: 'private',
    },
  )
  await writeNote(
    { reviewer: 'carla' },
    {
      scope: 'paragraph',
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p007`,
      body: marks.paragraph,
      visibility: 'private',
    },
  )
  await writeNote(
    { reviewer: 'carla' },
    { scope: 'chapter', chapterSlug: CHAPTER, body: marks.chapter, visibility: 'private' },
  )
  // One shared note from the same reviewer, so "nothing of Carla's is here" is
  // not what makes the assertions below pass.
  const shared = await writeNote(
    { reviewer: 'carla' },
    { scope: 'chapter', chapterSlug: CHAPTER, body: 'CARLA SHARED THIS ONE', visibility: 'shared' },
  )
  assert.equal(shared.status, 201)

  for (const [what, path] of [
    ['the author library and inbox', '/admin/read'],
    ['the author reading API', `/admin/api/reading?book=${BOOK}`],
    ["the author's contents", `/admin/read/${BOOK}`],
    ["the author's chapter", `/admin/read/${BOOK}/${CHAPTER}`],
    ['the dashboard', '/admin'],
  ] as const) {
    const answer = await call(path, { admin: true })
    for (const [scope, mark] of Object.entries(marks)) {
      assert.ok(!answer.text.includes(mark), `${scope}-scoped private note leaked into ${what}`)
    }
  }

  const page = await call('/admin/read', { admin: true })
  assert.ok(page.text.includes('CARLA SHARED THIS ONE'), 'what she shared is there')
})

test('a private note is not counted anywhere the author can see a count', { skip }, async () => {
  /*
   * The count is its own disclosure. "3 notes" beside a reviewer's name tells
   * Mike that three things were written about his book whether or not he can
   * read them, and that is exactly what a private note must not say.
   */
  const page = await call('/admin/read', { admin: true })

  const carlas = await notesOf({ reviewer: 'carla' })
  assert.equal(carlas.length, 4, 'she has written four notes on this book')
  const shared = carlas.filter((row) => row.visibility === 'shared')
  assert.equal(shared.length, 1, 'and shared exactly one of them')

  // The one she shared is named on the page. None of the others is, at any
  // scope -- not their words, and not even their identifiers.
  assert.ok(page.text.includes(shared[0].body))
  for (const hidden of carlas.filter((row) => row.visibility === 'private')) {
    assert.ok(!page.text.includes(hidden.body), `${hidden.scope}-scoped private note was named`)
    assert.ok(!page.text.includes(hidden.id), `${hidden.scope}-scoped private note's id appeared`)
  }
})

/* ------------------------------------------- notes outliving the roster */

test('a shared note stays visible to the author after the reviewer leaves the roster', { skip }, async () => {
  const before = await call('/admin/read', { admin: true })
  assert.ok(before.text.includes('CARLA SHARED THIS ONE'))

  const roster = JSON.parse(readFileSync(rosterPath, 'utf8')) as {
    reviewers: { id: string }[]
  }
  const kept = { ...roster, reviewers: roster.reviewers.filter((row) => row.id !== 'carla') }
  writeFileSync(rosterPath, JSON.stringify(kept, null, 2), 'utf8')

  try {
    // She is gone: her cookie no longer identifies anybody.
    const hers = await call(`/review/api/reading?book=${BOOK}`, { reviewer: 'carla' })
    assert.equal(hers.status, 401, 'the roster is the live answer to who may read')

    /*
     * And what she told Mike is still what she told Mike. This is the property
     * the storage layout exists for: a note is gathered by book, not by walking
     * whoever is currently a reviewer, so removing somebody from a list cannot
     * delete what they said about an unpublished manuscript.
     */
    const after = await call('/admin/read', { admin: true })
    assert.ok(
      after.text.includes('CARLA SHARED THIS ONE'),
      'a shared note must not disappear with its author’s roster entry',
    )
    // Her private notes are still private, roster or no roster.
    assert.ok(!after.text.includes('CARLA PRIVATE CHAPTER NOTE'))
  } finally {
    writeFileSync(rosterPath, JSON.stringify(roster, null, 2), 'utf8')
  }
})

/* ---------------------------------------------------------- delete rules */

test('deleting a note removes it, and leaves nothing of what it said', { skip }, async () => {
  const created = await writeNote(
    { reviewer: 'ben' },
    { scope: 'chapter', chapterSlug: CHAPTER, body: 'BEN RETRACTS THIS', visibility: 'shared' },
  )
  const note = created.body.note as StoredNote

  const seen = await call('/admin/read', { admin: true })
  assert.ok(seen.text.includes('BEN RETRACTS THIS'))

  const removed = await call(
    `/review/api/reading?book=${BOOK}&note=${note.id}&revision=${note.revision}`,
    { method: 'DELETE', reviewer: 'ben' },
  )
  assert.equal(removed.status, 200)

  assert.ok(!(await notesOf({ reviewer: 'ben' })).some((row) => row.id === note.id))

  const after = await call('/admin/read', { admin: true })
  assert.ok(!after.text.includes('BEN RETRACTS THIS'), 'a retracted note is gone from the inbox')

  // And nowhere on disk is there a copy of what it said.
  const walk = (dir: string): string[] => {
    if (!existsSync(dir)) return []
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(full))
      else out.push(full)
    }
    return out
  }
  for (const file of walk(workDir)) {
    assert.ok(
      !readFileSync(file, 'utf8').includes('BEN RETRACTS THIS'),
      `the retracted body survived at ${file}`,
    )
  }

  // Deleting it again is "not found", not an error and not a second success.
  const again = await call(
    `/review/api/reading?book=${BOOK}&note=${note.id}&revision=${note.revision}`,
    { method: 'DELETE', reviewer: 'ben' },
  )
  assert.equal(again.status, 404)
})

/* ------------------------------------------------------- the retired POST */

test('the old comment endpoint refuses a new write, by method', { skip }, async () => {
  const answer = await call('/review/api/feedback', {
    method: 'POST',
    reviewer: 'anna',
    body: {
      bookSlug: BOOK,
      chapterSlug: CHAPTER,
      scope: 'chapter',
      paragraphId: null,
      comment: 'A HAND-MADE SUBMISSION THAT MUST NOT BE STORED',
    },
  })

  assert.equal(answer.status, 405)
  assert.equal(answer.body.error, 'method_not_allowed')
  assert.equal(answer.headers.get('allow'), 'GET')
  assert.match(String(answer.body.message), /note/i)
})

test('the refusal does not depend on the body being well formed', { skip }, async () => {
  /*
   * A signed-in caller is refused by *method*, whatever they send. The handler
   * does not parse the body, resolve the reviewer, consult the manuscript or
   * open the store, so there is no shape of request that reaches a write.
   */
  for (const options of [
    { method: 'POST', reviewer: 'ben' as const },
    { method: 'POST', reviewer: 'anna' as const, body: 'not an object' },
    { method: 'POST', reviewer: 'anna' as const, body: { comment: 'x'.repeat(10) } },
    { method: 'POST', reviewer: 'anna' as const, body: {} },
  ]) {
    const answer = await call('/review/api/feedback', options)
    assert.equal(answer.status, 405, JSON.stringify(options))
    assert.equal(answer.headers.get('allow'), 'GET')
  }

  /*
   * An unauthenticated caller never gets as far as the method: the request
   * boundary turns them away first. That is a different refusal and the right
   * one -- what matters is that no caller, signed in or not, can write.
   */
  for (const options of [{ method: 'POST' }, { method: 'POST', body: 'not an object' }]) {
    const answer = await call('/review/api/feedback', options)
    assert.ok(
      answer.status === 401 || answer.status === 405,
      `an unauthenticated POST answered ${answer.status}`,
    )
  }
})

test('nothing a refused POST carried was written anywhere', { skip }, async () => {
  const rows = readFileSync(join(feedbackDir, `${BOOK}.ndjson`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
  assert.equal(rows.length, 1, 'still only the one row this suite seeded')
  assert.ok(!rows[0].includes('A HAND-MADE SUBMISSION THAT MUST NOT BE STORED'))
})

/* ------------------------------------------------------ the legacy reads */

test('the legacy read path still answers, for the reviewer who wrote it', { skip }, async () => {
  const answer = await call(`/review/api/feedback?book=${BOOK}`, { reviewer: 'anna' })
  assert.equal(answer.status, 200)
  const entries = answer.body.entries as { comment: string }[]
  assert.equal(entries.length, 1)
  assert.equal(entries[0].comment, 'ANNA SUBMITTED THIS UNDER THE OLD MODEL')

  // And only for her.
  const bens = await call(`/review/api/feedback?book=${BOOK}`, { reviewer: 'ben' })
  assert.deepEqual(bens.body.entries, [])
})

test('the old model is labelled "Earlier submitted comments" wherever it is shown', { skip }, async () => {
  const workspace = await call('/review/my-reading', { reviewer: 'anna' })
  assert.equal(workspace.status, 200)
  assert.ok(workspace.text.includes('ANNA SUBMITTED THIS UNDER THE OLD MODEL'))
  assert.ok(workspace.text.includes('Earlier submitted comments'))

  const inbox = await call('/admin/read', { admin: true })
  assert.ok(inbox.text.includes('ANNA SUBMITTED THIS UNDER THE OLD MODEL'))
  assert.ok(inbox.text.includes('Earlier submitted comments'))
})

/* ----------------------------------------------------- the reader surface */

test('the reader offers one way into writing, and the old Send path is gone', { skip }, async () => {
  /*
   * The composer itself lives in a sheet that is closed until somebody opens
   * it, so what it *says* is asserted against the pure module it renders
   * (`tests/note-composer.test.ts`). What a server render can prove, and what
   * this proves, is the shape of the page a reader actually lands on: every way
   * into writing goes to the same composer, and the retired submission control
   * is not on the page in either voice.
   */
  for (const [what, path, who] of [
    ['the reviewer reader', `/review/${BOOK}/${CHAPTER}`, { reviewer: 'anna' as const }],
    ['the author reader', `/admin/read/${BOOK}/${CHAPTER}`, { admin: true }],
  ] as const) {
    const page = await call(path, who)
    assert.equal(page.status, 200, what)

    // One vocabulary, in both voices: a paragraph offers a note, and so does
    // the chapter. There is no second composer beside either of them.
    assert.ok(page.text.includes('Note on this chapter'), `${what}: chapter note`)
    assert.match(page.text, /Write a note on paragraph \d+/, `${what}: paragraph note`)

    // The retired model's controls are gone from the interface entirely.
    assert.ok(!page.text.includes('Comment on this chapter'), `${what}: old chapter control`)
    assert.ok(!page.text.includes('Comment on paragraph'), `${what}: old paragraph control`)
    assert.ok(!/>Send</.test(page.text), `${what}: the Send button`)

    // The highlight shortcut is still offered, and is still its own thing --
    // the row that carries it appears only over a live selection, so what a
    // server render can show is the page telling a reader it is there.
    assert.match(page.text, /Select any words to highlight them/, `${what}: highlighting`)
  }
})

test('the reviewer reader is told that a note is hers to change', { skip }, async () => {
  const page = await call(`/review/${BOOK}/${CHAPTER}`, { reviewer: 'anna' })
  assert.match(page.text, /you choose who can see it/i)
  assert.match(page.text, /change it or delete it later/i)
})

test('the author reader is never told anything about sharing with Mike', { skip }, async () => {
  const page = await call(`/admin/read/${BOOK}/${CHAPTER}`, { admin: true })
  assert.equal(page.status, 200)
  assert.ok(!page.text.includes('Share with Mike'), 'he is Mike')
  assert.ok(!page.text.includes('send Mike'), 'and there is nobody to send one to')
  assert.match(page.text, /notes are private to you|nobody else can see them/i)
})

/* -------------------------------------------------------- anchor movement */

test('a note reports whether it still points at the text it was written about', { skip }, async () => {
  const notes = await notesOf({ reviewer: 'anna' })

  const passage = notes.find((row) => row.scope === 'passage')
  assert.equal(passage?.anchorState, 'ok')
  assert.ok(passage?.paragraphId)

  const chapterScoped = notes.find((row) => row.scope === 'chapter')
  assert.equal(chapterScoped?.anchorState, 'ok')
  assert.equal(chapterScoped?.paragraphId, null, 'a chapter note points at no paragraph')

  const book = (await notesOf({ admin: true })).find((row) => row.scope === 'book')
  assert.equal(book?.anchorState, 'unanchored', 'and a book note was never anchored')
})

/* ------------------------------------------------- the author-only book */

test('a reviewer cannot write a note about an author-only manuscript', { skip }, async () => {
  const answer = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: {
      op: 'note-create',
      bookSlug: AUTHOR_ONLY_BOOK,
      scope: 'chapter',
      chapterSlug: 'chapter-one',
      body: 'should never exist',
      visibility: 'shared',
    },
  })
  // The same 404 a book that is not here would get.
  assert.equal(answer.status, 404)
})

/* -------------------------------------------- the stored bytes, unchanged */

test('no note operation rewrote a single byte of the old stores', { skip }, async () => {
  /*
   * The whole point of adapting at read time rather than migrating. Every row
   * that existed before notes did is still, byte for byte, the row a reviewer's
   * words were written as -- not a re-serialisation of them, not a re-indented
   * copy, not a version with a field added.
   */
  const before = new Map([
    [
      `${BOOK}.ndjson`,
      createHash('sha256')
        .update(
          `${JSON.stringify({
            schema: 1,
            id: '11111111-2222-3333-4444-555555555555',
            createdAt: '2026-02-01T09:00:00.000Z',
            reviewerId: 'anna',
            bookSlug: BOOK,
            chapterSlug: CHAPTER,
            chapterNumber: 1,
            scope: 'chapter',
            paragraphId: null,
            paragraphOrdinal: null,
            quote: null,
            comment: 'ANNA SUBMITTED THIS UNDER THE OLD MODEL',
          })}\n`,
        )
        .digest('hex'),
    ],
  ])

  assert.deepEqual(
    Object.fromEntries(fingerprintTree(feedbackDir)),
    Object.fromEntries(before),
    'a submitted comment was rewritten',
  )
})

test('annotation records are untouched by everything notes do', { skip }, async () => {
  const created = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: {
      op: 'annotate',
      bookSlug: BOOK,
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p010`,
      startOffset: 0,
      endOffset: 8,
    },
  })
  assert.equal(created.status, 201)

  /*
   * A body, written the way the retired model wrote one, because the endpoint
   * will not write one any more. The row this protects therefore looks exactly
   * like a row from before notes existed -- which is the row that matters.
   */
  const annotationId = (created.body.annotation as { id: string }).id
  const annotationFile = join(
    readingDir,
    'reading',
    'v1',
    'reviewer',
    'anna',
    BOOK,
    'annotations',
    `${annotationId}.json`,
  )
  const row = JSON.parse(readFileSync(annotationFile, 'utf8')) as Record<string, unknown>
  row.note = 'AN ANNOTATION FROM BEFORE'
  row.visibility = 'author'
  writeFileSync(annotationFile, `${JSON.stringify(row, null, 2)}
`, 'utf8')

  const annotationsDir = join(readingDir, 'reading', 'v1')
  const root = existsSync(annotationsDir) ? annotationsDir : readingDir
  const before = fingerprintTree(root)
  const annotationFiles = Array.from(before.keys()).filter((path) =>
    path.includes('annotations/'),
  )
  assert.ok(annotationFiles.length > 0, 'there is an annotation on disk to protect')

  // Now do everything a note can do, to every owner, and check again.
  const note = (
    await writeNote(
      { reviewer: 'anna' },
      { scope: 'chapter', chapterSlug: CHAPTER, body: 'NOTE ALONGSIDE', visibility: 'shared' },
    )
  ).body.note as StoredNote
  await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: {
      op: 'note-update',
      bookSlug: BOOK,
      id: note.id,
      expectedRevision: note.revision,
      body: 'NOTE REVISED',
    },
  })
  await call(
    // Revision 2: the edit above was accepted, so the row has moved on.
    `/review/api/reading?book=${BOOK}&note=${note.id}&revision=${note.revision + 1}`,
    { method: 'DELETE', reviewer: 'anna' },
  )
  await call('/admin/read', { admin: true })
  await call('/review/my-reading', { reviewer: 'anna' })

  const after = fingerprintTree(root)
  for (const path of annotationFiles) {
    assert.equal(after.get(path), before.get(path), `${path} was rewritten`)
  }
})

test('the ordinary reader still works, unchanged', { skip }, async () => {
  const chapter = await call(`/review/${BOOK}/${CHAPTER}`, { reviewer: 'anna' })
  assert.equal(chapter.status, 200)
  // Prose, bookmarks, highlights and the automatic place are all still there.
  assert.ok(chapter.text.includes('rv-para'))
  assert.match(chapter.text, /Select any words to highlight them/)
  assert.ok(chapter.text.includes('Bookmark'))
  // The chapter's own header line. React splits interpolated text with comment
  // markers, so this asserts the element and its words rather than one string.
  assert.ok(chapter.text.includes('rv-chapter-meta'))
  assert.ok(chapter.text.includes('paragraphs'))

  const bookmark = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: { op: 'bookmark', bookSlug: BOOK, chapterSlug: CHAPTER, paragraphId: `${CHAPTER}-p012` },
  })
  assert.equal(bookmark.status, 201)

  const position = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: {
      op: 'position',
      bookSlug: BOOK,
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p013`,
    },
  })
  assert.equal(position.status, 200)

  const unknown = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: { op: 'something-else', bookSlug: BOOK },
  })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.error, 'unknown_operation')
})

/* ------------------------------------------------- the note's private link */

/*
 * The link is an action on a **saved** note, and it is a locator: the book and
 * the note's identifier, and nothing else. These tests are the whole of what
 * that has to mean -- who it opens for, what it does not carry, and what
 * happens to it when the note is gone.
 */

/** The reviewer's door and the author's door onto the same note. */
function reviewerLink(id: string): string {
  return `/review/note/${BOOK}/${id}`
}

function authorLink(id: string): string {
  return `/admin/note/${BOOK}/${id}`
}

/** The one page everybody who may not see a note is given. */
function refusedReviewerPage(answer: Answer): boolean {
  return answer.text.includes('You need access to open this')
}

function refusedAuthorPage(answer: Answer): boolean {
  return answer.text.includes('That link does not open anything you can see')
}

test('the private link opens on the access matrix, and on nothing else', { skip }, async () => {
  const BODY = 'ANNA LINK MATRIX BODY'

  const created = await writeNote(
    { reviewer: 'anna' },
    {
      scope: 'passage',
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p020`,
      startOffset: 0,
      endOffset: 10,
      body: BODY,
      visibility: 'private',
    },
  )
  assert.equal(created.status, 201)
  const note = created.body.note as StoredNote

  /* -------------------------------------------- while it is only hers */

  const hers = await call(reviewerLink(note.id), { reviewer: 'anna' })
  assert.equal(hers.status, 200)
  assert.ok(hers.text.includes(BODY), 'its owner can open her own note')

  for (const other of ['ben', 'carla'] as const) {
    const theirs = await call(reviewerLink(note.id), { reviewer: other })
    assert.ok(refusedReviewerPage(theirs), `${other} was not refused`)
    assert.ok(!theirs.text.includes(BODY), `${other} was shown the body`)
  }

  const anonymous = await call(reviewerLink(note.id))
  assert.ok(refusedReviewerPage(anonymous))
  assert.ok(!anonymous.text.includes(BODY))

  /*
   * Mike, at his own door, on a note she has not shared. There is no exception
   * for the author in `canViewNote`, and holding the link is not one either.
   */
  const mike = await call(authorLink(note.id), { admin: true })
  assert.ok(refusedAuthorPage(mike), 'a private note opened for the author')
  assert.ok(!mike.text.includes(BODY))

  /* ------------------------------------------------ once she shares it */

  const shared = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: {
      op: 'note-update',
      bookSlug: BOOK,
      id: note.id,
      expectedRevision: note.revision,
      visibility: 'shared',
    },
  })
  assert.equal(shared.status, 200)

  const mikeNow = await call(authorLink(note.id), { admin: true })
  assert.equal(mikeNow.status, 200)
  assert.ok(mikeNow.text.includes(BODY), 'a shared note opens for Mike')

  const annaStill = await call(reviewerLink(note.id), { reviewer: 'anna' })
  assert.ok(annaStill.text.includes(BODY), 'and still for its owner')

  // Sharing is with Mike. It is not with whoever holds the link.
  const benStill = await call(reviewerLink(note.id), { reviewer: 'ben' })
  assert.ok(refusedReviewerPage(benStill))
  assert.ok(!benStill.text.includes(BODY))

  /* ------------------------------------------------- and Mike's own note */

  const mikes = await writeNote(
    { admin: true },
    { scope: 'chapter', chapterSlug: CHAPTER, body: 'MIKE LINK MATRIX BODY' },
  )
  assert.equal(mikes.status, 201)
  const his = mikes.body.note as StoredNote

  const opened = await call(authorLink(his.id), { admin: true })
  assert.equal(opened.status, 200)
  assert.ok(opened.text.includes('MIKE LINK MATRIX BODY'))

  // A reviewer holding the identifier of one of Mike's notes reaches nothing,
  // at either door.
  const reviewerTries = await call(reviewerLink(his.id), { reviewer: 'anna' })
  assert.ok(refusedReviewerPage(reviewerTries))
  assert.ok(!reviewerTries.text.includes('MIKE LINK MATRIX BODY'))

  // An identifier nobody ever minted answers exactly the same way, so the link
  // cannot be used to find out whether a note exists.
  const invented = await call(reviewerLink('00000000-0000-4000-8000-000000000000'), {
    reviewer: 'anna',
  })
  assert.ok(refusedReviewerPage(invented))
})

test('the link carries the book and the note, and nothing of the note', { skip }, async () => {
  const BODY = 'ANNA LINK SECRECY BODY'

  const created = await writeNote(
    { reviewer: 'anna' },
    {
      scope: 'passage',
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p021`,
      startOffset: 0,
      endOffset: 24,
      body: BODY,
      visibility: 'shared',
    },
  )
  assert.equal(created.status, 201)
  const note = created.body.note as StoredNote
  const link = reviewerLink(note.id)

  /*
   * The address is two segments: the book, and the identifier. No body, no
   * quotation, no query string, no fragment, nothing to hide anything in.
   */
  assert.equal(link, `/review/note/${BOOK}/${note.id}`)
  assert.ok(!link.includes('?') && !link.includes('#'))
  assert.ok(!link.includes(BODY))
  assert.ok(!/token|secret/i.test(link))
  assert.ok(!link.includes(note.anchor.quote as string))

  /*
   * And the record mints nothing to go with the link. An annotation's link has
   * a `shareToken`; a note's has no such thing, because a note's link grants
   * nothing and so has nothing to grant with.
   */
  const row = (await notesOf({ reviewer: 'anna' })).find((item) => item.id === note.id)
  assert.ok(row)
  const fields = row as unknown as Record<string, unknown>
  for (const key of Object.keys(fields)) {
    assert.ok(!/token|secret/i.test(key), `a note carries "${key}"`)
  }
  assert.equal(fields.shareToken, undefined)
  assert.equal(fields.sharePath, undefined)

  /*
   * Nor does anything on disk. The annotation share store is where a capability
   * would have to live to be resolvable, and no note ever puts one there.
   */
  const shareDir = join(readingDir, 'reading', 'v1', 'share')
  const capabilities = existsSync(shareDir) ? readdirSync(shareDir) : []
  for (const file of capabilities) {
    const ref = JSON.parse(readFileSync(join(shareDir, file), 'utf8')) as Record<string, unknown>
    assert.equal(ref.noteId, undefined, `${file} is a capability for a note`)
    assert.notEqual(ref.annotationId, undefined, `${file} is not an annotation locator`)
  }

  // The page behind the link shows the note to its owner, and the address it
  // was reached by is still just the address.
  const page = await call(link, { reviewer: 'anna' })
  assert.equal(page.status, 200)
  assert.ok(page.text.includes(BODY))
})

test('a deleted note link stops opening, with nothing to withdraw', { skip }, async () => {
  const BODY = 'ANNA LINK DELETION BODY'

  const created = await writeNote(
    { reviewer: 'anna' },
    { scope: 'chapter', chapterSlug: CHAPTER, body: BODY, visibility: 'shared' },
  )
  assert.equal(created.status, 201)
  const note = created.body.note as StoredNote
  const link = reviewerLink(note.id)

  assert.ok((await call(link, { reviewer: 'anna' })).text.includes(BODY))
  assert.ok((await call(authorLink(note.id), { admin: true })).text.includes(BODY))

  const removed = await call(
    `/review/api/reading?book=${BOOK}&note=${note.id}&revision=${note.revision}`,
    { method: 'DELETE', reviewer: 'anna' },
  )
  assert.equal(removed.status, 200)

  const after = await call(link, { reviewer: 'anna' })
  assert.ok(refusedReviewerPage(after), 'a deleted note still opened')
  assert.ok(!after.text.includes(BODY))

  const mikeAfter = await call(authorLink(note.id), { admin: true })
  assert.ok(refusedAuthorPage(mikeAfter))
  assert.ok(!mikeAfter.text.includes(BODY))
})

/* --------------------------------------- the closed annotation body path */

/** Every annotation one reviewer has, as the API returns them. */
async function annotationsOf(
  reviewer: keyof typeof CODES,
): Promise<{ id: string; note: string | null; visibility: string }[]> {
  const answer = await call(`/review/api/reading?book=${BOOK}`, { reviewer })
  return (answer.body.annotations ?? []) as {
    id: string
    note: string | null
    visibility: string
  }[]
}

/** Where one reviewer's annotation is stored, so a test can seed an old body. */
function annotationFile(reviewerId: string, id: string): string {
  return join(readingDir, 'reading', 'v1', 'reviewer', reviewerId, BOOK, 'annotations', `${id}.json`)
}

test('annotate mints a bodyless highlight, and it is private', { skip }, async () => {
  // Absent.
  const absent = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'ben',
    body: {
      op: 'annotate',
      bookSlug: BOOK,
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p022`,
      startOffset: 0,
      endOffset: 8,
    },
  })
  assert.equal(absent.status, 201)
  const first = absent.body.annotation as { note: string | null; visibility: string }
  assert.equal(first.note, null)
  assert.equal(first.visibility, 'private')

  // Explicitly null.
  const nulled = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'ben',
    body: {
      op: 'annotate',
      bookSlug: BOOK,
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p023`,
      startOffset: 0,
      endOffset: 8,
      note: null,
    },
  })
  assert.equal(nulled.status, 201)
  assert.equal((nulled.body.annotation as { note: string | null }).note, null)

  /*
   * And it is private however the request was dressed. A highlight is not
   * writing addressed to anybody, so it never starts out reaching Mike, and it
   * never inherits the composer's shared default.
   */
  const dressed = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'ben',
    body: {
      op: 'annotate',
      bookSlug: BOOK,
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p024`,
      startOffset: 0,
      endOffset: 8,
      visibility: 'author',
    },
  })
  assert.equal(dressed.status, 201)
  assert.equal((dressed.body.annotation as { visibility: string }).visibility, 'private')
})

test('a hand-made annotation body is refused, and nothing is written', { skip }, async () => {
  const before = fingerprintTree(readingDir)
  const countBefore = (await annotationsOf('ben')).length

  const SMUGGLED = 'A BODY SMUGGLED THROUGH THE OLD DOOR'

  for (const note of [SMUGGLED, '', ' ', 0, 1, true, [], {}, { text: SMUGGLED }]) {
    const answer = await call('/review/api/reading', {
      method: 'POST',
      reviewer: 'ben',
      body: {
        op: 'annotate',
        bookSlug: BOOK,
        chapterSlug: CHAPTER,
        paragraphId: `${CHAPTER}-p025`,
        startOffset: 0,
        endOffset: 8,
        note,
      },
    })
    assert.equal(answer.status, 400, JSON.stringify(note))
    assert.equal(answer.body.error, 'invalid_request', JSON.stringify(note))
  }

  // Not one of them wrote anything: no new annotation, and not a byte moved.
  assert.equal((await annotationsOf('ben')).length, countBefore)
  assert.deepEqual(
    Object.fromEntries(fingerprintTree(readingDir)),
    Object.fromEntries(before),
    'a refused annotate wrote to the store',
  )
})

test('annotation-update refuses a request that contains a note at all', { skip }, async () => {
  const target = (await annotationsOf('ben'))[0]
  assert.ok(target, 'there is an annotation to try this against')

  /*
   * Give it a body the way the retired model gave it one, so the refusals below
   * are refusals to change a real stored body rather than refusals to create
   * one. The endpoint will not write a body any more; that is the correction.
   */
  const path = annotationFile('ben', target.id)
  const row = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  row.note = 'BEN WROTE THIS UNDER THE OLD MODEL'
  writeFileSync(path, `${JSON.stringify(row, null, 2)}\n`, 'utf8')

  const before = fingerprintTree(readingDir)

  /*
   * Refused by the field's presence, not by its value. `null` is refused with
   * the rest: erasing a stored body is a write to it, and this operation no
   * longer writes bodies at all.
   */
  for (const note of ['REPLACED', null, '', 0, false, [], { text: 'x' }]) {
    const answer = await call('/review/api/reading', {
      method: 'POST',
      reviewer: 'ben',
      body: { op: 'annotation-update', bookSlug: BOOK, id: target.id, note },
    })
    assert.equal(answer.status, 400, JSON.stringify(note))
    assert.equal(answer.body.error, 'invalid_request', JSON.stringify(note))
  }

  /*
   * A note smuggled in beside a legitimate visibility change is refused too,
   * and the visibility change does not happen either: the refusal is the first
   * thing the operation does, so there is no half of it that lands.
   */
  const beside = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'ben',
    body: {
      op: 'annotation-update',
      bookSlug: BOOK,
      id: target.id,
      visibility: 'author',
      note: 'REPLACED',
    },
  })
  assert.equal(beside.status, 400)

  assert.deepEqual(
    Object.fromEntries(fingerprintTree(readingDir)),
    Object.fromEntries(before),
    'a refused annotation-update wrote to the store',
  )

  const after = (await annotationsOf('ben')).find((item) => item.id === target.id)
  assert.equal(after?.note, 'BEN WROTE THIS UNDER THE OLD MODEL', 'the old body is as it was')
  assert.equal(after?.visibility, 'private', 'and the smuggled visibility did not take')
})

test('reads, visibility changes and deletes of old annotations still work', { skip }, async () => {
  const target = (await annotationsOf('ben'))[0]
  assert.ok(target)
  assert.equal(target.note, 'BEN WROTE THIS UNDER THE OLD MODEL', 'the seeded body is still there')

  // Visibility still changes, and the stored body still reads back.
  const widened = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'ben',
    body: { op: 'annotation-update', bookSlug: BOOK, id: target.id, visibility: 'author' },
  })
  assert.equal(widened.status, 200)
  const updated = widened.body.annotation as { visibility: string; note: string | null }
  assert.equal(updated.visibility, 'author')
  assert.equal(updated.note, 'BEN WROTE THIS UNDER THE OLD MODEL', 'the body came back untouched')

  // Mike can read what was shared with him, exactly as before.
  const inbox = await call('/admin/read', { admin: true })
  assert.ok(inbox.text.includes('BEN WROTE THIS UNDER THE OLD MODEL'))

  // And it still deletes.
  const removed = await call(`/review/api/reading?book=${BOOK}&annotation=${target.id}`, {
    method: 'DELETE',
    reviewer: 'ben',
  })
  assert.equal(removed.status, 200)
  assert.ok(!(await annotationsOf('ben')).some((item) => item.id === target.id))
})

/* =================================================== C2: the note contract
 *                                                     under concurrency,
 *                                                     entitlement and failure
 */

/* ---------------------------------------- revision-bound note updates */

test('an update must say which revision it was written against', { skip }, async () => {
  const created = await writeNote(
    { reviewer: 'anna' },
    { scope: 'chapter', chapterSlug: CHAPTER, body: 'ANNA REVISION ONE', visibility: 'private' },
  )
  assert.equal(created.status, 201)
  const note = created.body.note as StoredNote
  assert.equal(note.revision, 1, 'a new note is the first version of itself')

  const before = fingerprintTree(readingDir)

  /*
   * Missing, or present and not a revision. Every one of them is a blind write
   * -- a save that cannot say what it was composed against -- and is refused as
   * invalid input rather than being allowed through on an assumed 1.
   */
  const bad: Record<string, unknown>[] = [
    {},
    { expectedRevision: null },
    { expectedRevision: 0 },
    { expectedRevision: -1 },
    { expectedRevision: 1.5 },
    { expectedRevision: '1' },
    { expectedRevision: 'one' },
    { expectedRevision: true },
    { expectedRevision: [1] },
    { expectedRevision: { revision: 1 } },
  ]

  for (const shape of bad) {
    const answer = await call('/review/api/reading', {
      method: 'POST',
      reviewer: 'anna',
      body: { op: 'note-update', bookSlug: BOOK, id: note.id, body: 'BLIND', ...shape },
    })
    assert.equal(answer.status, 400, JSON.stringify(shape))
    assert.equal(answer.body.error, 'invalid_request', JSON.stringify(shape))
  }

  assert.deepEqual(
    Object.fromEntries(fingerprintTree(readingDir)),
    Object.fromEntries(before),
    'a refused update wrote to the store',
  )

  const unchanged = (await notesOf({ reviewer: 'anna' })).find((row) => row.id === note.id)
  assert.equal(unchanged?.body, 'ANNA REVISION ONE')
  assert.equal(unchanged?.revision, 1)
})

test('a save against a stale revision is 409, writes nothing, and is not an absence', { skip }, async () => {
  const created = await writeNote(
    { reviewer: 'anna' },
    { scope: 'chapter', chapterSlug: CHAPTER, body: 'ANNA FIRST VERSION', visibility: 'private' },
  )
  const note = created.body.note as StoredNote

  /*
   * Two clients holding the same rendered note -- the same reviewer on a phone
   * and a laptop, or one request retried. Both are hers, both are well formed,
   * and both say they were written against revision 1.
   */
  const first = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: {
      op: 'note-update',
      bookSlug: BOOK,
      id: note.id,
      expectedRevision: note.revision,
      body: 'SAVED FROM THE LAPTOP',
    },
  })
  assert.equal(first.status, 200)
  assert.equal((first.body.note as StoredNote).revision, 2, 'an accepted edit moves the revision')

  const before = fingerprintTree(readingDir)

  const stale = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: {
      op: 'note-update',
      bookSlug: BOOK,
      id: note.id,
      expectedRevision: note.revision,
      body: 'SAVED FROM THE PHONE',
    },
  })

  assert.equal(stale.status, 409, 'not 200, not 404, and not 503')
  assert.equal(stale.body.error, 'conflict')
  assert.match(String(stale.body.message ?? ''), /reload/i, 'and says what to do about it')

  assert.deepEqual(
    Object.fromEntries(fingerprintTree(readingDir)),
    Object.fromEntries(before),
    'a conflict wrote to the store',
  )

  const after = (await notesOf({ reviewer: 'anna' })).find((row) => row.id === note.id)
  assert.equal(after?.body, 'SAVED FROM THE LAPTOP', 'the accepted edit stands')
  assert.equal(after?.revision, 2, 'and the refused one did not move anything')

  // Repeating the identical stale request is refused identically. There is no
  // state in which retrying a conflict eventually lands it.
  const again = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: {
      op: 'note-update',
      bookSlug: BOOK,
      id: note.id,
      expectedRevision: note.revision,
      body: 'SAVED FROM THE PHONE',
    },
  })
  assert.equal(again.status, 409)

  // And the current revision still saves, so a conflict is a refusal of one
  // stale attempt rather than of the note.
  const current = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: {
      op: 'note-update',
      bookSlug: BOOK,
      id: note.id,
      expectedRevision: 2,
      body: 'SAVED FROM THE PHONE, AFTER A RELOAD',
    },
  })
  assert.equal(current.status, 200)
  assert.equal((current.body.note as StoredNote).revision, 3)
})

test('an update in flight when a note is deleted does not recreate it', { skip }, async () => {
  const created = await writeNote(
    { reviewer: 'anna' },
    {
      scope: 'chapter',
      chapterSlug: CHAPTER,
      body: 'ANNA WILL RETRACT THIS',
      visibility: 'shared',
    },
  )
  const note = created.body.note as StoredNote

  assert.ok((await call('/admin/read', { admin: true })).text.includes('ANNA WILL RETRACT THIS'))

  const removed = await call(
    `/review/api/reading?book=${BOOK}&note=${note.id}&revision=${note.revision}`,
    { method: 'DELETE', reviewer: 'anna' },
  )
  assert.equal(removed.status, 200)

  /*
   * The stale editor still holds the note as it was, and saves. Deletion is
   * deletion: this must fail rather than mint the object again -- shared, with
   * the words its author withdrew.
   */
  const late = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: {
      op: 'note-update',
      bookSlug: BOOK,
      id: note.id,
      expectedRevision: note.revision,
      body: 'ANNA WILL RETRACT THIS, EDITED',
      visibility: 'shared',
    },
  })
  assert.equal(late.status, 404, 'there is no such note any more')

  assert.ok(!(await notesOf({ reviewer: 'anna' })).some((row) => row.id === note.id))
  const page = await call('/admin/read', { admin: true })
  assert.ok(!page.text.includes('ANNA WILL RETRACT THIS'))

  // Its link stops opening, for its owner and for Mike alike.
  const owner = await call(`/review/note/${BOOK}/${note.id}`, { reviewer: 'anna' })
  assert.ok(!owner.text.includes('ANNA WILL RETRACT THIS'))
  const author = await call(`/admin/note/${BOOK}/${note.id}`, { admin: true })
  assert.ok(!author.text.includes('ANNA WILL RETRACT THIS'))
})

test('a stale visibility save cannot re-share a note its author narrowed', { skip }, async () => {
  const created = await writeNote(
    { reviewer: 'anna' },
    {
      scope: 'chapter',
      chapterSlug: CHAPTER,
      body: 'ANNA SHARED THEN THOUGHT BETTER OF IT',
      visibility: 'shared',
    },
  )
  const note = created.body.note as StoredNote
  assert.ok(
    (await call('/admin/read', { admin: true })).text.includes(
      'ANNA SHARED THEN THOUGHT BETTER OF IT',
    ),
  )

  // She narrows it on one client.
  const narrowed = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: {
      op: 'note-update',
      bookSlug: BOOK,
      id: note.id,
      expectedRevision: note.revision,
      visibility: 'private',
    },
  })
  assert.equal(narrowed.status, 200)
  assert.equal((narrowed.body.note as StoredNote).visibility, 'private')

  /*
   * The other client still shows it as shared and sends body and visibility
   * together, exactly as the reader does. Widening is the direction this whole
   * contract exists to make impossible, so this is the one that must not land.
   */
  const stale = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: {
      op: 'note-update',
      bookSlug: BOOK,
      id: note.id,
      expectedRevision: note.revision,
      body: 'ANNA SHARED THEN THOUGHT BETTER OF IT, TWEAKED',
      visibility: 'shared',
    },
  })
  assert.equal(stale.status, 409)

  const after = (await notesOf({ reviewer: 'anna' })).find((row) => row.id === note.id)
  assert.equal(after?.visibility, 'private', 'the narrowing stands')
  assert.equal(
    after?.body,
    'ANNA SHARED THEN THOUGHT BETTER OF IT',
    'and nothing of the stale save landed',
  )

  const page = await call('/admin/read', { admin: true })
  assert.ok(!page.text.includes('ANNA SHARED THEN THOUGHT BETTER OF IT'))
})

test('the author own notes are revision-bound in the same way', { skip }, async () => {
  const created = await writeNote(
    { admin: true },
    { scope: 'chapter', chapterSlug: CHAPTER, body: 'MIKE TO TRIAGE TWICE' },
  )
  const note = created.body.note as StoredNote
  assert.equal(note.revision, 1)

  const missing = await call('/admin/api/reading', {
    method: 'POST',
    admin: true,
    body: { op: 'note-update', csrf: adminCsrf, bookSlug: BOOK, id: note.id, status: 'resolved' },
  })
  assert.equal(missing.status, 400, 'his endpoint is the same endpoint')

  const resolved = await call('/admin/api/reading', {
    method: 'POST',
    admin: true,
    body: {
      op: 'note-update',
      csrf: adminCsrf,
      bookSlug: BOOK,
      id: note.id,
      expectedRevision: 1,
      status: 'resolved',
    },
  })
  assert.equal(resolved.status, 200)
  assert.equal((resolved.body.note as StoredNote).revision, 2)

  const stale = await call('/admin/api/reading', {
    method: 'POST',
    admin: true,
    body: {
      op: 'note-update',
      csrf: adminCsrf,
      bookSlug: BOOK,
      id: note.id,
      expectedRevision: 1,
      status: 'open',
    },
  })
  assert.equal(stale.status, 409)
  assert.equal(
    (await notesOf({ admin: true })).find((row) => row.id === note.id)?.status,
    'resolved',
  )
})

/* ------------------------------------------- book entitlement, proved */

/**
 * Put one reviewer on the roster, use them, and take them off again.
 *
 * The suite's own roster is left exactly as it was found, whatever the body
 * does. Dina exists only inside the entitlement tests, so nothing else in this
 * file ever sees a fourth reviewer.
 */
async function withDina(
  books: string[],
  body: (control: { entitleTo: (books: string[]) => void }) => Promise<void>,
): Promise<void> {
  const { fingerprintAccessCode, mintReviewerToken } = await import('../lib/reviewer-access.ts')
  const original = readFileSync(rosterPath, 'utf8')
  const roster = JSON.parse(original) as {
    reviewers: Record<string, unknown>[]
    [key: string]: unknown
  }

  const codeHash = await fingerprintAccessCode(CODES.dina)
  assert.ok(codeHash, 'the test roster needs a signing secret')

  const entry = (entitled: string[]) => ({
    id: 'dina',
    name: 'Dina',
    email: 'dina@example.test',
    books: entitled,
    status: 'active' as const,
    codeHash,
    createdAt: new Date(0).toISOString(),
    codeUpdatedAt: new Date(0).toISOString(),
    lastAccessAt: null,
  })

  const write = (entitled: string[]) => {
    writeFileSync(
      rosterPath,
      JSON.stringify({ ...roster, reviewers: [...roster.reviewers, entry(entitled)] }, null, 2),
      'utf8',
    )
  }

  write(books)

  /*
   * Her cookie is minted once, naming the books she starts with, and is never
   * re-minted. That is deliberate: every refusal below must come from the live
   * roster rather than from her token having been reissued, which is the whole
   * point of the check being re-read on every request.
   */
  const token = await mintReviewerToken({
    id: 'dina',
    name: 'Dina',
    books,
    codeHash: codeHash as string,
  })
  assert.ok(token)
  cookies.dina = token

  try {
    await body({ entitleTo: write })
  } finally {
    writeFileSync(rosterPath, original, 'utf8')
    delete cookies.dina
  }
}

test(
  'a reviewer with a valid session and no entitlement is refused before any note is resolved',
  { skip },
  async () => {
    const PRIVATE_BODY = 'DINA KEPT THIS ONE TO HERSELF'
    const SHARED_BODY = 'DINA SHARED THIS ONE WITH MIKE'

    await withDina([BOOK], async ({ entitleTo }) => {
      /* --------------------------------------- while she is entitled */

      const kept = await writeNote(
        { reviewer: 'dina' },
        { scope: 'chapter', chapterSlug: CHAPTER, body: PRIVATE_BODY, visibility: 'private' },
      )
      assert.equal(kept.status, 201)
      const privateNote = kept.body.note as StoredNote

      const told = await writeNote(
        { reviewer: 'dina' },
        { scope: 'chapter', chapterSlug: CHAPTER, body: SHARED_BODY, visibility: 'shared' },
      )
      assert.equal(told.status, 201)
      const sharedNote = told.body.note as StoredNote

      assert.equal((await notesOf({ reviewer: 'dina' })).length, 2)
      assert.equal(
        (await call(`/review/note/${BOOK}/${privateNote.id}`, { reviewer: 'dina' })).status,
        200,
      )
      assert.ok(
        (await call(`/review/note/${BOOK}/${privateNote.id}`, { reviewer: 'dina' })).text.includes(
          PRIVATE_BODY,
        ),
        'the locator opens for its owner while she may read the book',
      )

      /* ------------------------- now the book is taken off her entry */

      // Active, same code, same cookie. Only the entitlement changes, which is
      // the one variable this test is about.
      entitleTo([])

      /*
       * She is still somebody. This is what separates this test from the
       * roster-removal test above, where the cookie stops identifying anybody
       * and everything answers 401 at the session layer -- proving revocation
       * rather than entitlement scoping.
       */
      const stillSignedIn = await call('/review/my-reading', { reviewer: 'dina' })
      assert.equal(stillSignedIn.status, 200, 'her session is valid: this is not a 401')
      assert.ok(!stillSignedIn.text.includes(PRIVATE_BODY))
      assert.ok(!stillSignedIn.text.includes(SHARED_BODY))

      /* ------------------------------------------ listing and creation */

      const listing = await call(`/review/api/reading?book=${BOOK}`, { reviewer: 'dina' })
      assert.equal(listing.status, 404, 'listing a book she may not read')
      assert.ok(!listing.text.includes(PRIVATE_BODY))
      assert.ok(!listing.text.includes(SHARED_BODY))

      for (const scope of ['passage', 'paragraph', 'chapter'] as const) {
        const written = await writeNote(
          { reviewer: 'dina' },
          {
            scope,
            chapterSlug: CHAPTER,
            paragraphId: `${CHAPTER}-p002`,
            startOffset: 0,
            endOffset: 8,
            body: 'DINA SHOULD NOT BE ABLE TO WRITE THIS',
            visibility: 'private',
          },
        )
        assert.equal(written.status, 404, `creating a ${scope} note on a book she may not read`)
      }

      /* -------------------- locator access to a note she used to own */

      for (const [what, note] of [
        ['her private note', privateNote],
        ['her shared note', sharedNote],
      ] as const) {
        const page = await call(`/review/note/${BOOK}/${note.id}`, { reviewer: 'dina' })
        assert.ok(refusedReviewerPage(page), `the locator opened ${what}`)
        assert.ok(!page.text.includes(PRIVATE_BODY), `${what} disclosed the private body`)
        assert.ok(!page.text.includes(SHARED_BODY), `${what} disclosed the shared body`)
      }

      /* ------------------------------ mutation of a note she used to own */

      const edit = await call('/review/api/reading', {
        method: 'POST',
        reviewer: 'dina',
        body: {
          op: 'note-update',
          bookSlug: BOOK,
          id: privateNote.id,
          expectedRevision: privateNote.revision,
          body: 'DINA EDITED IT ANYWAY',
        },
      })
      assert.equal(edit.status, 404, 'and not 409 -- the book is refused before the note is read')

      const reshare = await call('/review/api/reading', {
        method: 'POST',
        reviewer: 'dina',
        body: {
          op: 'note-update',
          bookSlug: BOOK,
          id: privateNote.id,
          expectedRevision: privateNote.revision,
          visibility: 'shared',
        },
      })
      assert.equal(reshare.status, 404)

      const removed = await call(
        `/review/api/reading?book=${BOOK}&note=${privateNote.id}&revision=${privateNote.revision}`,
        { method: 'DELETE', reviewer: 'dina' },
      )
      assert.equal(removed.status, 404)

      // The chapter itself is refused too, so there is no surface where the
      // manuscript or her own material comes back.
      const reading = await call(`/review/${BOOK}/${CHAPTER}`, { reviewer: 'dina' })
      assert.equal(reading.status, 404)

      /* --------------------- nothing was written, and nothing was lost */

      const inbox = await call('/admin/read', { admin: true })
      assert.ok(inbox.text.includes(SHARED_BODY), 'what she told Mike outlives her entitlement')
      assert.ok(!inbox.text.includes(PRIVATE_BODY), 'and her private note is still private')
      assert.ok(!inbox.text.includes('DINA EDITED IT ANYWAY'))

      /* ------------------------------------------ give the book back */

      entitleTo([BOOK])
      const hers = await notesOf({ reviewer: 'dina' })
      assert.equal(hers.length, 2, 'every refusal above was scoping, not deletion')
      assert.deepEqual(
        hers.map((row) => row.body).sort(),
        [PRIVATE_BODY, SHARED_BODY].sort(),
      )
      assert.equal(
        hers.find((row) => row.id === privateNote.id)?.visibility,
        'private',
        'and the refused re-share did not land',
      )

      // Clean up after herself, so the rest of the file sees the store it
      // would have seen without this test.
      for (const note of hers) {
        const gone = await call(
          `/review/api/reading?book=${BOOK}&note=${note.id}&revision=${note.revision}`,
          { method: 'DELETE', reviewer: 'dina' },
        )
        assert.equal(gone.status, 200)
      }
    })
  },
)

test('a roster entry naming a book this deployment has not loaded is still skipped', { skip }, async () => {
  await withDina([BOOK, 'a-book-nobody-loaded'], async () => {
    /*
     * The workspace's legitimate unknown-book case, unchanged by this
     * correction: a stale entitlement is passed over silently -- it is not
     * hers to be told about -- and the books that are there still build.
     */
    const page = await call('/review/my-reading', { reviewer: 'dina' })
    assert.equal(page.status, 200)
    assert.ok(!page.text.includes('a-book-nobody-loaded'))

    const listing = await call('/review/api/reading?book=a-book-nobody-loaded', {
      reviewer: 'dina',
    })
    assert.equal(listing.status, 404)
  })
})

/* -------------------------------- a note-storage failure is never "nothing" */

/**
 * Make exactly one owner's notes on one book unreadable, and put them back.
 *
 * A regular file where that owner's notes directory belongs. `existsSync` says
 * the prefix is there and `readdirSync` refuses it, so the store's own `list`
 * throws -- a real failure of the real driver, scoped to one owner, with every
 * other read in the process still working. It is the right *kind* of failure
 * too: a live Blob read failure throws; it does not answer `storage-unavailable`
 * and quietly become an empty list.
 */
function withUnreadableNotes(owner: { kind: 'reviewer' | 'author'; id: string }, run: () => Promise<void>) {
  const prefix = `notes/v1/${BOOK}/${owner.kind}/${owner.id}`
  const full = join(readingDir, prefix)
  const aside = `${full}.aside`

  assert.ok(existsSync(full), `${prefix} must exist for this test to break anything`)
  renameSync(full, aside)
  writeFileSync(full, 'not a directory', 'utf8')

  return run().finally(() => {
    rmSync(full, { force: true })
    renameSync(aside, full)
  })
}

test('a note-storage failure never renders as an empty notes list', { skip }, async () => {
  const REVIEWER_BODY = 'ANNA WROTE THIS AND IT MUST NOT VANISH'
  const AUTHOR_BODY = 'MIKE WROTE THIS AND IT MUST NOT VANISH'

  const hers = await writeNote(
    { reviewer: 'anna' },
    { scope: 'chapter', chapterSlug: CHAPTER, body: REVIEWER_BODY, visibility: 'private' },
  )
  assert.equal(hers.status, 201)
  const his = await writeNote(
    { admin: true },
    { scope: 'chapter', chapterSlug: CHAPTER, body: AUTHOR_BODY },
  )
  assert.equal(his.status, 201)

  const { authorOwnerId } = await import('../lib/reading-owner.ts')
  const authorId = await authorOwnerId(ADMIN_EMAIL)
  assert.ok(authorId, 'the author owner id is derivable in this environment')

  const reviewerSurfaces = [
    [
      'the reviewer chapter reader',
      `/review/${BOOK}/${CHAPTER}`,
      { reviewer: 'anna' as const },
      REVIEWER_BODY,
    ],
    [
      'the reviewer workspace',
      '/review/my-reading',
      { reviewer: 'anna' as const },
      REVIEWER_BODY,
    ],
  ] as const

  const authorSurfaces = [
    ['the author chapter reader', `/admin/read/${BOOK}/${CHAPTER}`, { admin: true }, AUTHOR_BODY],
    /*
     * The book page shows a *count* rather than any body -- "N notes in this
     * book" -- which is the same claim in one number, and the number a
     * swallowed failure made zero. There is nothing of the note in its markup
     * to look for, so the discrimination here is the whole page: 200 while the
     * store answers, and never 200 with a confident count when it does not.
     */
    ['the author book page', `/admin/read/${BOOK}`, { admin: true }, null],
    ['the author workspace', '/admin/read', { admin: true }, AUTHOR_BODY],
  ] as const

  // Healthy first, so the failing case below is a difference and not a claim.
  for (const [what, path, who, shows] of [...reviewerSurfaces, ...authorSurfaces]) {
    const answer = await call(path, who)
    assert.equal(answer.status, 200, what)
    if (shows !== null) {
      assert.ok(answer.text.includes(shows), `${what} did not show the note to begin with`)
    }
  }

  await withUnreadableNotes({ kind: 'reviewer', id: 'anna' }, async () => {
    for (const [what, path, who] of reviewerSurfaces) {
      const answer = await call(path, who)
      assert.notEqual(answer.status, 200, `${what} answered as though nothing were wrong`)
      assert.ok(answer.status >= 500, `${what} answered ${answer.status}`)
      assert.ok(!answer.text.includes(REVIEWER_BODY), `${what} leaked the note it could not read`)
    }
  })

  await withUnreadableNotes({ kind: 'author', id: authorId as string }, async () => {
    for (const [what, path, who] of authorSurfaces) {
      const answer = await call(path, who)
      assert.notEqual(answer.status, 200, `${what} answered as though nothing were wrong`)
      assert.ok(answer.status >= 500, `${what} answered ${answer.status}`)
      assert.ok(!answer.text.includes(AUTHOR_BODY), `${what} leaked the note it could not read`)
    }
  })

  // Put back, and everything reads exactly as it did. The failure was the
  // store's, and nothing about it was written down or lost.
  for (const [what, path, who, shows] of [...reviewerSurfaces, ...authorSurfaces]) {
    const answer = await call(path, who)
    assert.equal(answer.status, 200, what)
    if (shows !== null) assert.ok(answer.text.includes(shows), what)
  }
})

test('the reading endpoint does not answer an unreadable notes store with an empty list', { skip }, async () => {
  const healthy = await call(`/review/api/reading?book=${BOOK}`, { reviewer: 'anna' })
  assert.equal(healthy.status, 200)
  assert.ok(((healthy.body.notes ?? []) as unknown[]).length > 0, 'she has notes to lose')

  await withUnreadableNotes({ kind: 'reviewer', id: 'anna' }, async () => {
    const answer = await call(`/review/api/reading?book=${BOOK}`, { reviewer: 'anna' })
    assert.notEqual(answer.status, 200)
    assert.equal(
      (answer.body.notes ?? undefined),
      undefined,
      'a failed read must not come back as notes: []',
    )
  })
})

/* ------------------------------------------- deletion is bound to a revision */

/*
 * Package 1 documented the hole these close, in its own words: a client still
 * holding revision 1 can delete a note that another of that same person's
 * clients has since edited to revision 2, destroying a body it never saw, and
 * be told the delete succeeded.
 *
 * Every one of these is a claim about what a **request** can do, which is why
 * they are here and not only at the store: the revision has to survive the
 * browser, the query string, the route handler, the API layer and the service
 * before it reaches the check, and a break anywhere along that chain leaves the
 * store's own tests passing.
 */

test('a delete that names no revision is refused, and removes nothing', { skip }, async () => {
  const created = await writeNote(
    { reviewer: 'anna' },
    { scope: 'chapter', chapterSlug: CHAPTER, body: 'UNVERSIONED DELETE', visibility: 'shared' },
  )
  const note = created.body.note as StoredNote

  const blind = await call(`/review/api/reading?book=${BOOK}&note=${note.id}`, {
    method: 'DELETE',
    reviewer: 'anna',
  })
  // 400, not 404 and not 200. The note is there and it is hers; the request is
  // the thing that is wrong, and saying 404 would tell her it had gone.
  assert.equal(blind.status, 400)
  assert.ok((await notesOf({ reviewer: 'anna' })).some((row) => row.id === note.id))

  for (const bad of ['', 'abc', '0', '-1', '1.5', 'NaN', '1e3']) {
    const answer = await call(
      `/review/api/reading?book=${BOOK}&note=${note.id}&revision=${encodeURIComponent(bad)}`,
      { method: 'DELETE', reviewer: 'anna' },
    )
    assert.equal(answer.status, 400, `"${bad}" was accepted as a revision`)
  }
  assert.ok(
    (await notesOf({ reviewer: 'anna' })).some((row) => row.id === note.id),
    'a malformed revision removed the note anyway',
  )

  // And the right one works, so the refusals above are about the revision and
  // not about the note.
  const good = await call(
    `/review/api/reading?book=${BOOK}&note=${note.id}&revision=${note.revision}`,
    { method: 'DELETE', reviewer: 'anna' },
  )
  assert.equal(good.status, 200)
})

test('a delete at a stale revision is 409 and destroys nothing', { skip }, async () => {
  const created = await writeNote(
    { reviewer: 'anna' },
    { scope: 'chapter', chapterSlug: CHAPTER, body: 'FIRST WORDS', visibility: 'shared' },
  )
  const note = created.body.note as StoredNote

  // Her other tab edits it. The first tab is still holding revision 1.
  const edited = await call('/review/api/reading', {
    method: 'POST',
    reviewer: 'anna',
    body: {
      op: 'note-update',
      bookSlug: BOOK,
      id: note.id,
      expectedRevision: note.revision,
      body: 'SECOND THOUGHTS',
    },
  })
  assert.equal(edited.status, 200)

  const stale = await call(
    `/review/api/reading?book=${BOOK}&note=${note.id}&revision=${note.revision}`,
    { method: 'DELETE', reviewer: 'anna' },
  )
  assert.equal(stale.status, 409, 'a stale delete was not refused')

  const survivor = (await notesOf({ reviewer: 'anna' })).find((row) => row.id === note.id)
  assert.equal(survivor?.body, 'SECOND THOUGHTS', 'a stale delete destroyed the newer words')

  // Mike still has it too: nothing was withdrawn, so nothing was said to have been.
  assert.ok((await call('/admin/read', { admin: true })).text.includes('SECOND THOUGHTS'))

  const now = await call(
    `/review/api/reading?book=${BOOK}&note=${note.id}&revision=${survivor?.revision}`,
    { method: 'DELETE', reviewer: 'anna' },
  )
  assert.equal(now.status, 200)
})

/* ------------------------------------------------------- withdrawal events */

/** Every withdrawal object on disk, parsed. The store's own bytes. */
function withdrawalObjects(): Record<string, unknown>[] {
  const root = join(readingDir, 'withdrawals')
  return walkFiles(root).map(
    (file) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>,
  )
}

/** Every file beneath a directory, recursively. */
function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

test('retracting a shared note leaves one bodyless event and no body', { skip }, async () => {
  const before = withdrawalObjects().length
  const created = await writeNote(
    { reviewer: 'anna' },
    {
      scope: 'paragraph',
      chapterSlug: CHAPTER,
      paragraphId: `${CHAPTER}-p002`,
      body: 'SHARED THEN WITHDRAWN',
      visibility: 'shared',
    },
  )
  assert.equal(created.status, 201, created.text)
  const note = created.body.note as StoredNote

  const removed = await call(
    `/review/api/reading?book=${BOOK}&note=${note.id}&revision=${note.revision}`,
    { method: 'DELETE', reviewer: 'anna' },
  )
  assert.equal(removed.status, 200)

  const events = withdrawalObjects()
  assert.equal(events.length, before + 1, 'a shared retraction did not leave exactly one event')
  const event = events.find((row) => row.noteId === note.id)
  assert.ok(event, 'the event does not name the note that was withdrawn')

  // Exactly the permitted fields, and no others. A field list rather than a
  // spot check: the failure mode here is an extra key nobody noticed.
  assert.deepEqual(
    Object.keys(event as Record<string, unknown>).sort(),
    ['bookSlug', 'chapterSlug', 'noteId', 'revision', 'schema', 'scope', 'withdrawnAt'],
    'a withdrawal event carries a field it may not carry',
  )
  assert.equal(event.scope, 'paragraph')
  assert.equal(event.revision, note.revision)

  // Nothing of the note survives anywhere in the store, the event included.
  for (const file of walkFiles(workDir)) {
    const text = readFileSync(file, 'utf8')
    assert.ok(!text.includes('SHARED THEN WITHDRAWN'), `the withdrawn body survived at ${file}`)
  }
  const serialized = JSON.stringify(event)
  assert.ok(!serialized.includes('anna'), 'the event names the reviewer who withdrew it')
  assert.ok(
    !/paragraphId|quote|paragraphText|startOffset|"body"/.test(serialized),
    'the event carries an anchor payload or a body',
  )

  // And Mike's inbox no longer shows the words.
  assert.ok(!(await call('/admin/read', { admin: true })).text.includes('SHARED THEN WITHDRAWN'))
})

test('deleting a private note leaves no event and no trace at all', { skip }, async () => {
  const before = withdrawalObjects()
  const created = await writeNote(
    { reviewer: 'anna' },
    { scope: 'chapter', chapterSlug: CHAPTER, body: 'PRIVATE THEN GONE', visibility: 'private' },
  )
  const note = created.body.note as StoredNote

  const removed = await call(
    `/review/api/reading?book=${BOOK}&note=${note.id}&revision=${note.revision}`,
    { method: 'DELETE', reviewer: 'anna' },
  )
  assert.equal(removed.status, 200)

  const after = withdrawalObjects()
  assert.equal(after.length, before.length, 'a private deletion created an event')
  assert.ok(
    !after.some((row) => row.noteId === note.id),
    'a private deletion named its note somewhere Mike can read',
  )
  // Not even the identifier: a record saying "note X was withdrawn" about a
  // note Mike was never allowed to see is still a disclosure that it existed.
  assert.ok(!JSON.stringify(after).includes(note.id))
})

test('deleting one of Mike own notes leaves no event either', { skip }, async () => {
  const before = withdrawalObjects().length
  const created = await writeNote(
    { admin: true },
    { scope: 'chapter', chapterSlug: CHAPTER, body: 'MIKE DELETES HIS OWN' },
  )
  assert.equal(created.status, 201, created.text)
  const note = created.body.note as StoredNote

  const removed = await call(
    `/admin/api/reading?book=${BOOK}&note=${note.id}&revision=${note.revision}&csrf=${adminCsrf}`,
    { method: 'DELETE', admin: true },
  )
  assert.equal(removed.status, 200)
  assert.equal(withdrawalObjects().length, before, 'Mike own deletion created an event')
})
