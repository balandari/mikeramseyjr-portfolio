import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  FileSystemPrivateStore,
  type CreateOutcome,
  type PrivateStore,
  type VersionedObject,
} from '../lib/private-store.ts'
import {
  MAX_MESSAGE_LENGTH,
  MAX_NAME_LENGTH,
  RequestConflictError,
  cleanRequestEmail,
  cleanRequestMessage,
  cleanRequestName,
  findRequestByEmail,
  listRequests,
  loadRequest,
  parseRequest,
  loadRequestVersioned,
  mutateRequest,
  removeRequestIfMatch,
  requestIdForEmail,
  submitRequest,
} from '../lib/reviewer-requests.ts'

/*
 * Access requests: the one record here written by somebody with no authority at
 * all.
 *
 * Two things are being defended. The first is the obvious one -- nothing a
 * stranger types is believed without being cleaned. The second is subtler: two
 * submissions from one address, arriving at the same instant, must produce one
 * request. The index is claimed with create-if-absent for exactly that reason,
 * and the parallel test below is what proves it.
 */

const SECRET = 'test-secret-for-requests-only'

function freshStore(): { store: FileSystemPrivateStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'mrj-req-'))
  return { store: new FileSystemPrivateStore(root), root }
}

function withSecret<T>(run: () => Promise<T>): Promise<T> {
  const saved = process.env.REVIEWER_AUTH_SECRET
  process.env.REVIEWER_AUTH_SECRET = SECRET
  return run().finally(() => {
    if (saved === undefined) delete process.env.REVIEWER_AUTH_SECRET
    else process.env.REVIEWER_AUTH_SECRET = saved
  })
}

/* ------------------------------------------------------------ validation */

test('a name is trimmed, collapsed, capped, and never carries control characters', () => {
  assert.equal(cleanRequestName('  Anna   Vasquez '), 'Anna Vasquez')
  assert.equal(cleanRequestName(''), null)
  assert.equal(cleanRequestName('   '), null)
  assert.equal(cleanRequestName('x'.repeat(MAX_NAME_LENGTH + 1)), null)
  assert.equal(cleanRequestName(42), null)
  assert.equal(
    cleanRequestName(`Anna${String.fromCharCode(10)}Injected: header`),
    'Anna Injected: header',
    'a newline collapses to a space rather than surviving into a header',
  )
  assert.equal(cleanRequestName(`Anna${String.fromCharCode(0)}`), null)
})

test('a message keeps its paragraphs, loses its control characters, and is capped', () => {
  assert.equal(cleanRequestMessage('We met at the reading.'), 'We met at the reading.')
  assert.equal(
    cleanRequestMessage('one\r\ntwo'),
    'one\ntwo',
    'CRLF from a Windows browser becomes an ordinary newline',
  )
  assert.equal(cleanRequestMessage(`a${String.fromCharCode(7)}b`), 'ab')
  assert.equal(cleanRequestMessage(''), null)
  assert.equal(cleanRequestMessage('x'.repeat(MAX_MESSAGE_LENGTH + 1)), null)
  assert.equal(cleanRequestMessage(null), null)
})

test('an address is normalised the way the roster normalises it, and no further', () => {
  assert.equal(cleanRequestEmail('  Anna@Example.COM '), 'anna@example.com')
  // No provider folding: two spellings stay two people, visibly.
  assert.equal(cleanRequestEmail('a.n.n.a+early@gmail.com'), 'a.n.n.a+early@gmail.com')
  assert.equal(cleanRequestEmail('not-an-address'), null)
  assert.equal(cleanRequestEmail('two@@example.com'), null)
  assert.equal(cleanRequestEmail(''), null)
})

test('a malformed stored record is refused rather than half-read', () => {
  assert.equal(parseRequest(null), null)
  assert.equal(parseRequest('not json'), null)
  assert.equal(parseRequest('[]'), null)
  assert.equal(parseRequest(JSON.stringify({ schema: 2, id: 'a'.repeat(24) })), null)
  assert.equal(parseRequest(JSON.stringify({ schema: 1, id: 'nope' })), null)
})

/* ------------------------------------------------------------ operations */

test('a request is stored, found by address, and listed newest first', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const first = await submitRequest(
        { name: 'Anna', email: 'anna@example.com', message: 'We met at the reading.' },
        store,
        1_000,
      )
      assert.equal(first.outcome, 'created')

      const second = await submitRequest(
        { name: 'Ben', email: 'ben@example.com', message: 'I review for a magazine.' },
        store,
        2_000,
      )
      assert.equal(second.outcome, 'created')

      const found = await findRequestByEmail('ANNA@example.com', store)
      assert.equal(found?.id, first.request.id, 'the address index is case-insensitive')

      const all = await listRequests(store)
      assert.deepEqual(
        all.map((request) => request.name),
        ['Ben', 'Anna'],
      )
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a second request from one address does not create a second record', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const first = await submitRequest(
        { name: 'Anna', email: 'anna@example.com', message: 'Asking again.' },
        store,
      )
      const again = await submitRequest(
        { name: 'Anna', email: 'anna@example.com', message: 'And again.' },
        store,
      )

      assert.equal(again.outcome, 'existing')
      assert.equal(again.request.id, first.request.id)
      assert.equal(
        again.request.message,
        'Asking again.',
        'the first message stands; a repeat cannot overwrite what Mike is reading',
      )
      assert.equal((await listRequests(store)).length, 1)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('eight simultaneous submissions from one address produce one request', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          submitRequest(
            { name: `Anna ${i}`, email: 'race@example.com', message: `Attempt ${i}` },
            store,
          ),
        ),
      )

      const created = outcomes.filter((outcome) => outcome.outcome === 'created')
      assert.equal(created.length, 1, 'the address index is claimed atomically')
      assert.equal((await listRequests(store)).length, 1)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a change is derived from the stored record, not from a stale copy', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const { request } = await submitRequest(
        { name: 'Anna', email: 'anna@example.com', message: 'Hello.' },
        store,
      )

      const saved = await mutateRequest(
        request.id,
        (current) => ({ next: { ...current, name: 'Anna V' }, result: null }),
        store,
      )
      assert.equal(saved.request.name, 'Anna V')

      /*
       * The second change is written from a copy read before the first one
       * landed. Under the old read-check-overwrite it would have been refused
       * only by a timestamp comparison; now the mutation re-derives from the
       * record that actually won, so the first change is preserved and the
       * second is applied on top of it. That is the whole point of the change:
       * nothing is silently dropped.
       */
      const second = await mutateRequest(
        request.id,
        (current) => ({ next: { ...current, message: 'Second thoughts.' }, result: null }),
        store,
      )
      assert.equal(second.request.name, 'Anna V', 'the earlier change survived')
      assert.equal(second.request.message, 'Second thoughts.')

      const current = await loadRequest(request.id, store)
      assert.equal(current?.name, 'Anna V')
      assert.equal(current?.message, 'Second thoughts.')
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('removing a request frees its address to write again', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const { request } = await submitRequest(
        { name: 'Anna', email: 'anna@example.com', message: 'Hello.' },
        store,
      )

      const versioned = await loadRequestVersioned(request.id, store)
      assert.ok(versioned)
      assert.equal(await removeRequestIfMatch(request.id, versioned.version, store), true)
      assert.equal(await loadRequest(request.id, store), null)
      assert.equal(await findRequestByEmail('anna@example.com', store), null)

      const again = await submitRequest(
        { name: 'Anna', email: 'anna@example.com', message: 'Trying again.' },
        store,
      )
      assert.equal(again.outcome, 'created')

      /*
       * The id is the SAME, and deliberately so. A request's identity is
       * derived from its address, which is what makes submitting one atomic
       * write with nothing to recover after a crash. The consequence is that an
       * address has one request slot, and a later request occupies the slot the
       * removed one vacated. The audit log is timestamped and ordered, so the
       * timeline still reads correctly; two entries far apart can share an id.
       * Mail keys are unaffected, because every credential carries its own
       * random operation identity.
       */
      assert.equal(again.request.id, request.id, 'one address, one request slot')
      assert.equal(again.request.message, 'Trying again.', 'and it is genuinely the new request')
      assert.equal(again.request.status, 'pending')
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an index pointing at a removed record does not strand the address', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const { request } = await submitRequest(
        { name: 'Anna', email: 'anna@example.com', message: 'Hello.' },
        store,
      )

      // The record goes. There is no index left behind, because there is no
      // index: the address is the location.
      const versioned = await loadRequestVersioned(request.id, store)
      assert.ok(versioned)
      await removeRequestIfMatch(request.id, versioned.version, store)

      const again = await submitRequest(
        { name: 'Anna', email: 'anna@example.com', message: 'Trying again.' },
        store,
      )
      assert.equal(again.outcome, 'created')
      assert.equal((await findRequestByEmail('anna@example.com', store))?.id, again.request.id)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------- crash recovery, at every write boundary there is */

/*
 * The defect this replaces, in one sentence: submitting used to be two writes
 * with a claim between them, and a crash by the *repairer* left an immutable
 * claim nobody could ever acquire -- so one address was locked out for good,
 * with no request in existence and no way to make one.
 *
 * Reproduced against the module before the repair:
 *
 *   { "repairClaimSurvivedCrash": true,
 *     "retryOutcome": "RequestIndexBusyError",
 *     "requestRecords": 0 }
 *
 * The repair is not a better claim. A request's identity is derived from its
 * address, so submitting is **one** create-if-absent and there is no boundary
 * to crash between. These tests inject a crash at every write the operation
 * makes -- which is now exactly one -- and prove the next caller converges.
 */

/** A store that refuses one named write, to model a process that stops dead. */
class CrashingStore implements PrivateStore {
  readonly driver = 'fs'
  readonly writable = true
  readonly provenAtomic = true

  inner: PrivateStore
  crashOnWriteMatching: string | null = null

  constructor(inner: PrivateStore) {
    this.inner = inner
  }

  private check(path: string): void {
    const match = this.crashOnWriteMatching
    if (match !== null && path.includes(match)) {
      this.crashOnWriteMatching = null
      throw new Error(`process died before writing ${path}`)
    }
  }

  read(path: string): Promise<string | null> {
    return this.inner.read(path)
  }

  readVersioned(path: string): Promise<VersionedObject> {
    return this.inner.readVersioned(path)
  }

  async create(path: string, body: string): Promise<CreateOutcome> {
    this.check(path)
    return this.inner.create(path, body)
  }

  async writeIfMatch(path: string, body: string, version: string | null): Promise<boolean> {
    this.check(path)
    return this.inner.writeIfMatch(path, body, version)
  }

  async removeIfMatch(path: string, version: string): Promise<boolean> {
    this.check(path)
    return this.inner.removeIfMatch(path, version)
  }

  list(prefix: string): Promise<string[]> {
    return this.inner.list(prefix)
  }
}

test('a crash during a submission leaves nothing behind, and the next caller succeeds', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const crashing = new CrashingStore(store)
      const email = 'stranded@example.com'

      // The only write the operation makes. Crashing on it is crashing on all
      // of them, which is the property the design is for.
      crashing.crashOnWriteMatching = 'requests/v2/records/'
      await assert.rejects(
        () => submitRequest({ name: 'A', email, message: 'one' }, crashing),
        /process died/,
      )

      assert.equal((await listRequests(store)).length, 0, 'nothing was left half-written')
      assert.equal(await findRequestByEmail(email, store), null, 'and the address is free')

      const later = await submitRequest({ name: 'B', email, message: 'two' }, store)
      assert.equal(later.outcome, 'created', 'a later submission simply works')
      assert.equal((await listRequests(store)).length, 1)
      assert.equal((await findRequestByEmail(email, store))?.id, later.request.id)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('there is no state in which an address can be permanently locked out', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const crashing = new CrashingStore(store)
      const email = 'locked@example.com'

      /*
       * The old failure, driven directly: crash, then try again, repeatedly.
       * Under the claim design the second call raised `RequestIndexBusyError`
       * for ever after. Here every attempt after a crash simply creates.
       */
      for (let round = 0; round < 3; round += 1) {
        crashing.crashOnWriteMatching = 'requests/v2/records/'
        await assert.rejects(
          () => submitRequest({ name: 'A', email, message: 'one' }, crashing),
          /process died/,
        )

        const recovered = await submitRequest({ name: 'B', email, message: 'two' }, store)
        assert.equal(recovered.outcome, 'created', `round ${round}: recovery converged`)
        assert.equal((await listRequests(store)).length, 1)

        // Clear it and go round again, so the crash is retried from scratch.
        const versioned = await loadRequestVersioned(recovered.request.id, store)
        assert.ok(versioned)
        await removeRequestIfMatch(recovered.request.id, versioned.version, store)
      }
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('simultaneous callers after a crash converge on exactly one request', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const crashing = new CrashingStore(store)
      const email = 'crowded@example.com'

      crashing.crashOnWriteMatching = 'requests/v2/records/'
      await assert.rejects(
        () => submitRequest({ name: 'A', email, message: 'one' }, crashing),
        /process died/,
      )

      const outcomes = await Promise.all(
        Array.from({ length: 6 }, (_unused, index) =>
          submitRequest({ name: `Caller ${index}`, email, message: 'Please.' }, store),
        ),
      )

      const records = await listRequests(store)
      assert.equal(records.length, 1, 'exactly one request record')

      const found = await findRequestByEmail(email, store)
      assert.ok(found, 'and it is the one the address resolves to')
      assert.equal(found.id, records[0].id, 'no unindexed request record remains')
      for (const outcome of outcomes) assert.equal(outcome.request.id, found.id)
      assert.equal(
        outcomes.filter((outcome) => outcome.outcome === 'created').length,
        1,
        'exactly one of them created anything',
      )
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a request record and its address are the same object, so neither can outlive the other', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const email = 'Anna@Example.COM'
      const { request } = await submitRequest({ name: 'Anna', email, message: 'Hello.' }, store)

      // The identity is derived from the *normalised* address, so the spelling
      // used to submit cannot create a second slot.
      assert.equal(request.id, requestIdForEmail('anna@example.com'))
      assert.equal(request.id, requestIdForEmail('  ANNA@example.com '))
      assert.match(request.id, /^[a-f0-9]{24}$/)

      // The identity does not reveal the address, and is not the address.
      assert.ok(!request.id.includes('anna'))

      const paths = await store.list('requests/v2/records/')
      assert.equal(paths.length, 1, 'one object, and it is the record')
      assert.equal(paths[0], `requests/v2/records/${request.id}.json`)

      const versioned = await loadRequestVersioned(request.id, store)
      assert.ok(versioned)
      await removeRequestIfMatch(request.id, versioned.version, store)
      assert.equal(await findRequestByEmail(email, store), null, 'removing it frees the address')
      assert.equal((await store.list('requests/v2/records/')).length, 0, 'and leaves nothing')
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unreadable record for an address is raised, never overwritten', async () => {
  const { store, root } = freshStore()
  try {
    await withSecret(async () => {
      const email = 'corrupt@example.com'
      await store.create(`requests/v2/records/${requestIdForEmail(email)}.json`, '{ broken')

      /*
       * Overwriting here would delete a request Mike may already have acted on,
       * on the strength of a parse failure. Refusing is the smaller harm, and
       * the route turns it into the same generic "not available right now".
       */
      await assert.rejects(
        () => submitRequest({ name: 'A', email, message: 'one' }, store),
        (error: Error) => error.name === 'RequestUnreadableError',
      )
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
