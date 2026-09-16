import test from 'node:test'
import assert from 'node:assert/strict'

/*
 * The browser's half of the revision contract.
 *
 * Two things have to be true of `updateNoteRecord`, and neither is provable by
 * reading the server:
 *
 *   **it says which version it is changing.** The revision the reader rendered
 *   travels on every update. Without it the server has nothing to check and the
 *   write is blind again -- which is the whole defect.
 *
 *   **it treats 409 as "reload required", not as success.** A conflict means
 *   nothing was written and the copy on screen is stale. Reported as success it
 *   would tell somebody their words were saved when they were not; retried it
 *   would be refused identically forever; and the one thing the server does not
 *   have is the text still sitting in the composer.
 *
 * `fetch` is stubbed rather than a server being started, exactly as
 * `tests/reading-client-position.test.ts` does and for the same reason: the
 * question here is what this function sends and how it reads what comes back.
 * That a real 409 is produced under a real race is proved end to end in
 * `tests/note-routes.test.ts`, and at the store's own seam in
 * `tests/note-concurrency.test.ts`.
 */

import { updateNoteRecord, type ClientNote } from '../app/review/reading-client.ts'

const ENDPOINT = { url: '/review/api/reading' }
const AUTHOR_ENDPOINT = { url: '/admin/api/reading', csrf: 'csrf-token-value' }
const BOOK = 'the-backward-becoming'
const ID = '11111111-2222-3333-4444-555555555555'

const realFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = realFetch
})

function capture(response: () => Response): { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    return response()
  }) as unknown as typeof globalThis.fetch
  return { sent }
}

function noteBody(revision: number): string {
  return JSON.stringify({ ok: true, note: { id: ID, revision } })
}

test('every update carries the revision the reader rendered', async () => {
  const seen = capture(() => new Response(noteBody(8), { status: 200 }))

  await updateNoteRecord(ENDPOINT, BOOK, ID, 7, { body: 'CORRECTED' })
  await updateNoteRecord(ENDPOINT, BOOK, ID, 7, { visibility: 'private' })
  await updateNoteRecord(AUTHOR_ENDPOINT, BOOK, ID, 7, { status: 'resolved' })

  assert.equal(seen.sent.length, 3)
  for (const request of seen.sent) {
    assert.equal(request.op, 'note-update')
    assert.equal(request.id, ID)
    assert.equal(request.bookSlug, BOOK)
    assert.equal(
      request.expectedRevision,
      7,
      'a save with no expected revision is a blind write',
    )
  }
  // The author's endpoint still carries its CSRF token, and the revision does
  // not displace it.
  assert.equal(seen.sent[2].csrf, 'csrf-token-value')
})

test('the revision sent is the one given, never one inferred from the changes', async () => {
  const seen = capture(() => new Response(noteBody(2), { status: 200 }))
  for (const revision of [1, 2, 3, 99]) {
    await updateNoteRecord(ENDPOINT, BOOK, ID, revision, { body: 'x' })
  }
  assert.deepEqual(
    seen.sent.map((request) => request.expectedRevision),
    [1, 2, 3, 99],
  )
})

test('a 409 is a reload-required conflict, and never a save', async () => {
  capture(
    () =>
      new Response(JSON.stringify({ error: 'conflict', message: 'changed' }), { status: 409 }),
  )

  const result = await updateNoteRecord(ENDPOINT, BOOK, ID, 3, { body: 'MY WORDS' })

  assert.equal(result.ok, false, 'a conflict is not a save')
  assert.ok(!result.ok && result.conflict === true, 'and it is distinguishable from any other failure')
  assert.match(
    (result as { message: string }).message,
    /reload/i,
    'the reader is told what to do about it',
  )
  assert.match(
    (result as { message: string }).message,
    /NOT saved/,
    'and told plainly that nothing was written',
  )
})

test('no other refusal is reported as a conflict', async () => {
  for (const status of [400, 401, 404, 500, 503]) {
    capture(() => new Response(JSON.stringify({ error: 'no' }), { status }))
    const result = await updateNoteRecord(ENDPOINT, BOOK, ID, 3, { body: 'x' })
    assert.equal(result.ok, false, `HTTP ${status}`)
    assert.equal(
      !result.ok && result.conflict,
      undefined,
      `HTTP ${status} must not read as a stale copy`,
    )
  }
})

test('a success is still a success, and carries the note the server wrote', async () => {
  capture(() => new Response(noteBody(4), { status: 200 }))
  const result = await updateNoteRecord(ENDPOINT, BOOK, ID, 3, { body: 'x' })
  assert.equal(result.ok, true)
  assert.equal((result as { value: ClientNote }).value.revision, 4, 'the next save uses this one')
})
