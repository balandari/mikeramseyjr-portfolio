import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/*
 * C3-2: a conditional DELETE accepts every sound revision, through the real
 * route handlers.
 *
 * `Number.MAX_SAFE_INTEGER` is a sound stored revision, and the documented
 * contract is that a note stored there reads, lists and deletes normally. The
 * shared query parser both DELETE doors use (`revisionParam` in
 * `lib/reading-api.ts`) allowed at most fifteen digits, and the two highest
 * sound revisions have sixteen, so both doors answered 400 and the note stayed.
 *
 * These tests import the shipped `app/review/api/reading/route.ts` and
 * `app/admin/api/reading/route.ts` and call their `DELETE` exports with a real
 * `NextRequest`. Only `next/headers` is replaced, by the existing admin-route
 * hooks, so a cookie jar can be presented; the reviewer token and the
 * administrator session are genuinely minted and genuinely verified against a
 * real on-disk roster, and the note is created by the real note service and
 * removed from real on-disk storage.
 *
 * Partitions:
 *
 *   **discriminating** -- fail against the frozen C2 parser, pass after the
 *   correction: reviewer delete at MAX - 1 and at MAX; admin delete at MAX.
 *
 *   **narrowing** (explicitly superseding C2) -- a leading-zero revision that
 *   used to reach the service now answers `invalid_request` and deletes
 *   nothing.
 *
 *   **ceiling semantics now reachable** -- a stale delete at the ceiling is a
 *   409 conflict that deletes nothing (C2 refused it at the parser with 400).
 *
 *   **preservation** -- pass on both: malformed, zero and unsafe revisions are
 *   refused with 400 and delete nothing, on both doors; an ordinary delete, a
 *   stale delete and a missing row keep their existing answers.
 *
 * No note body appears in an assertion message.
 */

register('./helpers/admin-route-hooks.mjs', import.meta.url)

const ROOT = pathToFileURL(join(process.cwd(), '/')).href
const MAX = Number.MAX_SAFE_INTEGER
const BOOK = 'the-backward-becoming'
const ADMIN = 'author@example.test'
const SITE = 'https://reader.example.test'

type Handler = (request: unknown) => Promise<Response>
type Owner = { kind: 'reviewer' | 'author'; id: string }

declare global {
  // eslint-disable-next-line no-var
  var __adminCookies: Record<string, string> | undefined
}

const ENV_KEYS = [
  'REVIEWER_AUTH_SECRET',
  'ADMIN_AUTH_SECRET',
  'ADMIN_ALLOWED_EMAILS',
  'REVIEWER_ROSTER_DRIVER',
  'REVIEWER_ROSTER_DIR',
  'REVIEWER_ROSTER',
  'REVIEWER_FEEDBACK_DRIVER',
  'REVIEWER_FEEDBACK_DIR',
  'REVIEWER_READING_DIR',
] as const

const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))

let dir = ''
let reviewerDELETE: Handler
let adminDELETE: Handler
let NextRequestCtor: new (url: string, init?: { method?: string }) => unknown
let csrf = ''
let authorOwner: Owner
const ANNA: Owner = { kind: 'reviewer', id: 'anna' }

type NoteService = typeof import('../lib/note-service.ts')
type NotesStore = typeof import('../lib/notes-store.ts')
type ReadingStore = typeof import('../lib/reviewer-reading.ts')
let service: NoteService
let notes: NotesStore
let reading: ReadingStore

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mrj-note-delete-revision-'))
  const rosterDir = join(dir, 'roster')
  mkdirSync(rosterDir, { recursive: true })

  process.env.REVIEWER_AUTH_SECRET = 'reviewer-secret-for-tests-only-not-a-real-one'
  process.env.ADMIN_AUTH_SECRET = 'admin-secret-for-tests-only-not-a-real-one'
  process.env.ADMIN_ALLOWED_EMAILS = ADMIN
  process.env.REVIEWER_ROSTER_DRIVER = 'fs'
  process.env.REVIEWER_ROSTER_DIR = rosterDir
  delete process.env.REVIEWER_ROSTER
  process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
  process.env.REVIEWER_FEEDBACK_DIR = join(dir, 'feedback')
  process.env.REVIEWER_READING_DIR = join(dir, 'reading')

  const access = (await import(`${ROOT}lib/reviewer-access.ts`)) as typeof import('../lib/reviewer-access.ts')
  const auth = (await import(`${ROOT}lib/admin-auth.ts`)) as typeof import('../lib/admin-auth.ts')
  const owner = (await import(`${ROOT}lib/reading-owner.ts`)) as typeof import('../lib/reading-owner.ts')

  const codeHash = await access.fingerprintAccessCode('AAAABBBBCCCCDDDD')
  assert.ok(codeHash, 'the test roster needs a signing secret')
  const anna = {
    id: 'anna',
    name: 'Anna',
    email: 'anna@example.test',
    books: [BOOK],
    status: 'active' as const,
    codeHash,
    createdAt: new Date(0).toISOString(),
    codeUpdatedAt: new Date(0).toISOString(),
    lastAccessAt: null,
  }
  writeFileSync(
    join(rosterDir, 'roster.json'),
    JSON.stringify({ schema: 1, updatedAt: new Date().toISOString(), reviewers: [anna] }, null, 2),
    'utf8',
  )

  const reviewerToken = await access.mintReviewerToken({
    id: anna.id,
    name: anna.name,
    books: anna.books,
    codeHash,
  })
  assert.ok(reviewerToken, 'the reviewer session could not be minted')
  const adminToken = await auth.mintAdminToken(ADMIN)
  assert.ok(adminToken, 'the administrator session could not be minted')
  const derived = await auth.adminCsrfToken(adminToken)
  assert.ok(derived, 'the CSRF token could not be derived')
  csrf = derived
  const authorId = await owner.authorOwnerId(ADMIN)
  assert.ok(authorId, 'the author owner id could not be derived')
  authorOwner = { kind: 'author', id: authorId }

  globalThis.__adminCookies = {
    [access.REVIEWER_COOKIE_NAME]: reviewerToken,
    [auth.ADMIN_COOKIE_NAME]: adminToken,
  }

  service = (await import(`${ROOT}lib/note-service.ts`)) as NoteService
  notes = (await import(`${ROOT}lib/notes-store.ts`)) as NotesStore
  reading = (await import(`${ROOT}lib/reviewer-reading.ts`)) as ReadingStore
  reviewerDELETE = (await import(`${ROOT}app/review/api/reading/route.ts`)).DELETE as Handler
  adminDELETE = (await import(`${ROOT}app/admin/api/reading/route.ts`)).DELETE as Handler
  NextRequestCtor = (await import('next/server')).NextRequest as unknown as typeof NextRequestCtor
})

test.after(() => {
  globalThis.__adminCookies = undefined
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ helpers */

function viewerOf(owner: Owner) {
  return owner.kind === 'reviewer'
    ? { kind: 'reviewer' as const, id: owner.id, books: [BOOK] }
    : { kind: 'author' as const, id: owner.id }
}

/** A real note, created by the note service, then staged at `revision`. */
async function stagedNote(owner: Owner, revision: number): Promise<{ id: string; path: string }> {
  notes.__resetNoteStore()
  const created = await service.createNote(viewerOf(owner), {
    bookSlug: BOOK,
    scope: 'chapter',
    chapterSlug: 'chapter-one',
    body: 'staged route words',
    visibility: 'private',
  })
  assert.equal(created.ok, true, 'the note could not be created')
  if (!created.ok) throw new Error('unreachable')
  const path = notes.notePath(owner, BOOK, created.value.id)
  const objects = reading.createReadingObjects()
  const stored = JSON.parse((await objects.get(path)) as string) as Record<string, unknown>
  assert.equal(stored.revision, 1, 'a new note did not start at revision 1')
  if (revision !== 1) {
    stored.revision = revision
    await objects.put(path, `${JSON.stringify(stored, null, 2)}\n`)
  }
  notes.__resetNoteStore()
  const read = await notes.createNoteStore().getNote(owner, BOOK, created.value.id)
  assert.ok(read, 'the staged note did not read back')
  assert.equal(read.revision, revision, 'the staged revision did not read back as sound')
  return { id: created.value.id, path }
}

async function storedBytes(path: string): Promise<string | null> {
  return reading.createReadingObjects().get(path)
}

function deleteRequest(door: 'reviewer' | 'admin', noteId: string, revision: string | null): unknown {
  const url = new URL(door === 'reviewer' ? '/review/api/reading' : '/admin/api/reading', SITE)
  url.searchParams.set('book', BOOK)
  url.searchParams.set('note', noteId)
  if (revision !== null) url.searchParams.set('revision', revision)
  if (door === 'admin') url.searchParams.set('csrf', csrf)
  return new NextRequestCtor(url.href, { method: 'DELETE' })
}

async function callDelete(
  door: 'reviewer' | 'admin',
  noteId: string,
  revision: string | null,
): Promise<{ status: number; body: unknown }> {
  notes.__resetNoteStore()
  const handler = door === 'reviewer' ? reviewerDELETE : adminDELETE
  const response = await handler(deleteRequest(door, noteId, revision))
  return { status: response.status, body: await response.json() }
}

async function assertDeleted(door: 'reviewer' | 'admin', owner: Owner, revision: number): Promise<void> {
  const note = await stagedNote(owner, revision)
  const answer = await callDelete(door, note.id, String(revision))
  assert.equal(answer.status, 200, `${door} delete at ${revision} was not accepted`)
  assert.deepEqual(answer.body, { ok: true })
  assert.equal(await storedBytes(note.path), null, `${door} delete at ${revision} left the object`)
  notes.__resetNoteStore()
  assert.equal(await notes.createNoteStore().getNote(owner, BOOK, note.id), null)
}

async function assertRefusedAndKept(
  door: 'reviewer' | 'admin',
  owner: Owner,
  storedRevision: number,
  cases: Array<[label: string, revision: string | null]>,
): Promise<void> {
  const note = await stagedNote(owner, storedRevision)
  const before = await storedBytes(note.path)
  assert.ok(before)
  for (const [label, revision] of cases) {
    const answer = await callDelete(door, note.id, revision)
    assert.equal(answer.status, 400, `${door}: ${label} was not refused with 400`)
    assert.deepEqual(answer.body, { error: 'invalid_request' }, `${door}: ${label} gave another refusal`)
    assert.equal(await storedBytes(note.path), before, `${door}: ${label} changed or deleted the note`)
  }
}

/* ============================================================ discriminating */

test('C3-2 discriminating: reviewer DELETE route deletes a note at MAX_SAFE_INTEGER - 1', async () => {
  await assertDeleted('reviewer', ANNA, MAX - 1)
})

test('C3-2 discriminating: reviewer DELETE route deletes a note at MAX_SAFE_INTEGER', async () => {
  await assertDeleted('reviewer', ANNA, MAX)
})

test('C3-2 discriminating: admin DELETE route deletes a note at MAX_SAFE_INTEGER', async () => {
  await assertDeleted('admin', authorOwner, MAX)
})

/* ================================================================ narrowing */

test('C3-2 narrowing: a leading-zero revision is refused and deletes nothing', async () => {
  // Stored at 7, so `007` names the stored value and used to reach the service.
  await assertRefusedAndKept('reviewer', ANNA, 7, [
    ['leading zero', '007'],
    ['single leading zero', '07'],
  ])
  await assertRefusedAndKept('reviewer', ANNA, MAX, [['leading zero at the ceiling', `0${MAX}`]])
  await assertRefusedAndKept('admin', authorOwner, 7, [['leading zero', '007']])
})

/* ============================================= ceiling semantics now reachable */

test('C3-2 ceiling: a stale delete at the ceiling is a conflict and deletes nothing', async () => {
  const note = await stagedNote(ANNA, MAX)
  const before = await storedBytes(note.path)
  const answer = await callDelete('reviewer', note.id, String(MAX - 1))
  assert.equal(answer.status, 409)
  assert.equal((answer.body as { error?: unknown }).error, 'conflict')
  assert.equal(await storedBytes(note.path), before, 'a stale delete changed the note')
})

/* ============================================================== preservation */

const REFUSED: Array<[label: string, revision: string | null]> = [
  ['missing', null],
  ['empty', ''],
  ['letters', 'abc'],
  ['decimal point', '1.0'],
  ['decimal ceiling', `${MAX}.0`],
  ['exponent', '1e3'],
  ['leading space', ' 1'],
  ['trailing space', '1 '],
  ['plus sign', '+1'],
  ['minus sign', '-1'],
  ['hexadecimal', '0x10'],
  ['fullwidth digit', '１'],
  ['underscore separator', '1_000'],
  ['trailing newline', '1\n'],
  ['zero', '0'],
  ['double zero', '00'],
  ['first unsafe', String(MAX + 1)],
  ['second unsafe', '9007199254740993'],
  ['twenty digits', '99999999999999999999'],
  ['four hundred digits', '9'.repeat(400)],
]

test('C3-2 preservation: reviewer DELETE refuses malformed, zero and unsafe revisions and deletes nothing', async () => {
  await assertRefusedAndKept('reviewer', ANNA, 1, REFUSED)
  await assertRefusedAndKept('reviewer', ANNA, MAX, REFUSED)
})

test('C3-2 preservation: admin DELETE refuses malformed, zero and unsafe revisions and deletes nothing', async () => {
  await assertRefusedAndKept('admin', authorOwner, 1, REFUSED)
})

test('C3-2 preservation: an ordinary delete succeeds on both doors', async () => {
  await assertDeleted('reviewer', ANNA, 1)
  await assertDeleted('admin', authorOwner, 1)
  await assertDeleted('reviewer', ANNA, 999999999999999)
})

test('C3-2 preservation: a stale delete is a conflict and a missing row is not found', async () => {
  const note = await stagedNote(ANNA, 3)
  const before = await storedBytes(note.path)
  const stale = await callDelete('reviewer', note.id, '2')
  assert.equal(stale.status, 409)
  assert.equal((stale.body as { error?: unknown }).error, 'conflict')
  assert.equal(await storedBytes(note.path), before, 'a stale delete changed the note')

  const missing = await callDelete('reviewer', '00000000-0000-4000-8000-00000000abcd', '1')
  assert.equal(missing.status, 404)
  assert.deepEqual(missing.body, { error: 'not_found' })
  assert.equal(await storedBytes(note.path), before, 'a missing-row delete changed another note')
})
