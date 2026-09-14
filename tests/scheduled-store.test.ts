import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FileSystemPrivateStore, type PrivateStore } from '../lib/private-store.ts'
import {
  InjectedCrash,
  MemoryPrivateStore,
  explore,
  exploreCrashes,
  runSchedule,
  scripted,
} from './helpers/scheduled-store.ts'

/*
 * The harness has to be trustworthy before anything is proved with it.
 *
 * Four properties are load-bearing, and each one is checked here against a
 * scenario whose answer is known by hand:
 *
 *   1. A named schedule releases operations in exactly the order it names, and
 *      an operation genuinely does not touch the store until it is released.
 *   2. `explore()` visits every interleaving, and exactly once each.
 *   3. The memory store and the filesystem store agree on all five primitives,
 *      which is what makes an exploration over the fast one mean anything about
 *      the real one.
 *   4. A crash injected after the k-th write leaves the k writes that preceded
 *      it and nothing after.
 */

function twoOpFlow(id: string, path: string) {
  return {
    id,
    async run(store: PrivateStore) {
      const seen = await store.read(path)
      const made = await store.create(path, `${id}\n`)
      return { seen, created: made.created }
    },
  }
}

test('a named schedule releases operations in exactly the order it names', async () => {
  const store = new MemoryPrivateStore()
  const outcome = await runSchedule({
    store,
    flows: [twoOpFlow('a', 'x.json'), twoOpFlow('b', 'x.json')],
    // Both read before either writes: the classic lost-update opening.
    choose: scripted(['a', 'b', 'a', 'b']),
  })

  assert.deepEqual(
    outcome.trace.map((call) => `${call.flow}:${call.op}`),
    ['a:read', 'b:read', 'a:create', 'b:create'],
  )
  // Both saw nothing; create-if-absent still let exactly one of them win.
  assert.deepEqual(outcome.results.get('a'), { ok: true, value: { seen: null, created: true } })
  assert.deepEqual(outcome.results.get('b'), { ok: true, value: { seen: null, created: false } })
  assert.equal(store.peek('x.json'), 'a\n')
})

test('a named schedule can let the second flow finish entirely between the first flow steps', async () => {
  const store = new MemoryPrivateStore()
  const outcome = await runSchedule({
    store,
    flows: [twoOpFlow('a', 'x.json'), twoOpFlow('b', 'x.json')],
    choose: scripted(['a', 'b', 'b', 'a']),
  })

  assert.deepEqual(
    outcome.trace.map((call) => `${call.flow}:${call.op}`),
    ['a:read', 'b:read', 'b:create', 'a:create'],
  )
  assert.equal((outcome.results.get('b') as { value: { created: boolean } }).value.created, true)
  assert.equal((outcome.results.get('a') as { value: { created: boolean } }).value.created, false)
})

test('explore visits every interleaving of two two-operation flows, exactly once', async () => {
  const traces = new Set<string>()

  const visited = await explore({
    setup: () => ({
      store: new MemoryPrivateStore(),
      flows: [twoOpFlow('a', 'x.json'), twoOpFlow('b', 'x.json')],
      world: null,
    }),
    check: (outcome) => {
      const key = outcome.trace.map((call) => `${call.flow}:${call.op}`).join('|')
      assert.equal(traces.has(key), false, `visited ${key} twice`)
      traces.add(key)

      // The invariant under every ordering: exactly one create wins.
      const created = Array.from(outcome.results.values()).filter(
        (result) => result.ok && (result.value as { created: boolean }).created,
      )
      assert.equal(created.length, 1)
    },
  })

  // C(4,2) = 6 interleavings of two flows of two operations each.
  assert.equal(visited, 6)
  assert.equal(traces.size, 6)
})

test('explore scales to the pair sizes the credential flows actually have', async () => {
  function nFlow(id: string, n: number) {
    return {
      id,
      async run(store: PrivateStore) {
        for (let i = 0; i < n; i += 1) await store.read(`${id}-${i}.json`)
        return n
      },
    }
  }

  const visited = await explore({
    setup: () => ({
      store: new MemoryPrivateStore(),
      flows: [nFlow('a', 5), nFlow('b', 5)],
      world: null,
    }),
    check: () => {},
  })

  // C(10,5) = 252.
  assert.equal(visited, 252)
})

test('the memory store and the filesystem store agree on all five primitives', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrj-harness-'))
  try {
    const stores: PrivateStore[] = [new MemoryPrivateStore(), new FileSystemPrivateStore(root)]

    for (const store of stores) {
      const where = `probe/${store.driver}.json`

      assert.equal(await store.read(where), null)
      assert.deepEqual(await store.readVersioned(where), { body: null, version: null })
      // Conditional removal of something absent removes nothing and says so.
      assert.equal(await store.removeIfMatch(where, 'whatever'), false)
      // A conditional write against a version cannot create.
      assert.equal(await store.writeIfMatch(where, 'nope\n', 'whatever'), false)

      const first = await store.create(where, 'one\n')
      assert.equal(first.created, true)
      assert.ok(first.version)

      const second = await store.create(where, 'two\n')
      assert.deepEqual(second, { created: false, version: null })
      assert.equal(await store.read(where), 'one\n')

      const read = await store.readVersioned(where)
      assert.equal(read.body, 'one\n')
      assert.equal(read.version, first.version)

      // Stale version: refused, and nothing written.
      assert.equal(await store.writeIfMatch(where, 'three\n', 'stale'), false)
      assert.equal(await store.read(where), 'one\n')

      // Current version: accepted, and the version moves.
      assert.equal(await store.writeIfMatch(where, 'three\n', read.version), true)
      const moved = await store.readVersioned(where)
      assert.equal(moved.body, 'three\n')
      assert.notEqual(moved.version, read.version)

      // The old version no longer removes it; the current one does.
      assert.equal(await store.removeIfMatch(where, read.version as string), false)
      assert.equal(await store.removeIfMatch(where, moved.version as string), true)
      assert.equal(await store.read(where), null)

      // Delete and recreate at the same pathname.
      assert.equal((await store.create(where, 'again\n')).created, true)
      assert.deepEqual(await store.list('probe/'), [where])
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a crash injected after the k-th write leaves exactly k writes behind', async () => {
  const seen: { k: number; paths: string[]; crashed: boolean }[] = []

  const points = await exploreCrashes({
    setup: () => ({
      store: new MemoryPrivateStore(),
      flows: [
        {
          id: 'writer',
          async run(store: PrivateStore) {
            await store.create('a.json', '1\n')
            await store.create('b.json', '2\n')
            await store.create('c.json', '3\n')
            return 'finished'
          },
        },
      ],
      world: null as null,
    }),
    check: (outcome, _world, k) => {
      const result = outcome.results.get('writer')
      assert.ok(result)
      seen.push({
        k,
        paths: outcome.calls.filter((c) => c.op === 'create').map((c) => c.path),
        crashed: !result.ok && result.error instanceof InjectedCrash,
      })
    },
  })

  assert.equal(points, 3)
  assert.deepEqual(seen, [
    { k: 0, paths: ['a.json', 'b.json', 'c.json'], crashed: false },
    { k: 1, paths: ['a.json'], crashed: true },
    { k: 2, paths: ['a.json', 'b.json'], crashed: true },
    { k: 3, paths: ['a.json', 'b.json', 'c.json'], crashed: true },
  ])
})
