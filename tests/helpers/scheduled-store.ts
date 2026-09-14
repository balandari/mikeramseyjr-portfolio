/**
 * The deterministic storage harness.
 *
 * Three review rounds each found "the next interleaving", and each time the
 * reproduction was a one-off barrier built by hand inside the verdict. This is
 * that barrier made permanent, and made exhaustive.
 *
 * It gives three things the suite did not have:
 *
 *   1. **A store that can be paused at any operation.** Every `read`,
 *      `readVersioned`, `create`, `writeIfMatch`, `removeIfMatch` and `list`
 *      waits for a permit before it touches anything. So a flow can be stopped
 *      between its decisive read and its decisive write, which is precisely the
 *      gap the last three defects lived in and precisely the gap that ordinary
 *      `Promise.all` scheduling never opens.
 *
 *   2. **Exhaustive exploration of two or more flows.** `explore()` enumerates
 *      every interleaving of the participating flows' storage operations by
 *      re-running the whole scenario once per ordering against a fresh store,
 *      and hands each outcome to an assertion function. Two flows of eight
 *      operations each is 12,870 orderings, which an in-memory store does in
 *      seconds. "Did we think of it" becomes "did the enumerator visit it".
 *
 *   3. **Crash injection after every durable write.** `explore()` and
 *      `runSchedule()` both accept `crashAfterWrite: k`, which lets the k-th
 *      write land and then throws, so the flow dies at exactly that boundary
 *      and the invariants can be checked over what it left behind.
 *
 * Nothing here is imported by the application. It is a test fixture, and the
 * memory store below implements exactly the semantics the live probe
 * (`scripts/blob-probe.mjs`) checks against the real service: atomic
 * create-if-absent, ETag compare-and-swap, conditional removal, and
 * read-your-writes.
 */

import { createHash } from 'node:crypto'

import type { CreateOutcome, PrivateStore, VersionedObject } from '../../lib/private-store.ts'

/* ------------------------------------------------------------ memory store */

function digest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

/**
 * The same contract as `FileSystemPrivateStore`, in a map.
 *
 * Every mutating method is one synchronous section with no `await` in it, which
 * is what makes create-if-absent and compare-and-swap atomic in this process --
 * the same property `O_CREAT | O_EXCL` gives the filesystem driver and
 * `allowOverwrite` / `ifMatch` are documented to give Vercel Blob.
 */
export class MemoryPrivateStore implements PrivateStore {
  readonly driver = 'memory'
  readonly writable = true
  readonly provenAtomic = true

  private readonly objects = new Map<string, string>()

  async read(path: string): Promise<string | null> {
    return this.objects.has(path) ? (this.objects.get(path) as string) : null
  }

  async readVersioned(path: string): Promise<VersionedObject> {
    if (!this.objects.has(path)) return { body: null, version: null }
    const body = this.objects.get(path) as string
    return { body, version: digest(body) }
  }

  async create(path: string, body: string): Promise<CreateOutcome> {
    if (this.objects.has(path)) return { created: false, version: null }
    this.objects.set(path, body)
    return { created: true, version: digest(body) }
  }

  async writeIfMatch(path: string, body: string, version: string | null): Promise<boolean> {
    const present = this.objects.has(path)
    if (version === null) {
      if (present) return false
      this.objects.set(path, body)
      return true
    }
    if (!present) return false
    if (digest(this.objects.get(path) as string) !== version) return false
    this.objects.set(path, body)
    return true
  }

  async removeIfMatch(path: string, version: string): Promise<boolean> {
    if (!this.objects.has(path)) return false
    if (digest(this.objects.get(path) as string) !== version) return false
    this.objects.delete(path)
    return true
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = []
    this.objects.forEach((_body, path) => {
      if (!path.startsWith(prefix)) return
      if (path.slice(prefix.length).includes('/')) return
      out.push(path)
    })
    return out.sort()
  }

  /** Test convenience: every pathname currently held, sorted. */
  paths(): string[] {
    return Array.from(this.objects.keys()).sort()
  }

  /** Test convenience: the bytes at one path, or null. */
  peek(path: string): string | null {
    return this.objects.has(path) ? (this.objects.get(path) as string) : null
  }
}

/* ------------------------------------------------------------- the harness */

export type StoreOpName =
  | 'read'
  | 'readVersioned'
  | 'create'
  | 'writeIfMatch'
  | 'removeIfMatch'
  | 'list'

/** The operations that change durable state, and therefore the crash points. */
export const WRITE_OPS: readonly StoreOpName[] = ['create', 'writeIfMatch', 'removeIfMatch']

export type SpiedCall = { flow: string; op: StoreOpName; path: string }

/** Thrown at an injected crash point. Distinguishable from a real failure. */
export class InjectedCrash extends Error {
  readonly after: SpiedCall

  constructor(after: SpiedCall) {
    super(`injected crash after ${after.flow} ${after.op} ${after.path}`)
    this.name = 'InjectedCrash'
    this.after = after
  }
}

/**
 * Wrap one asynchronous operation so that it waits for a permit, runs, and then
 * counts as a step in the schedule.
 *
 * The gated `PrivateStore` a flow receives is built out of exactly this, and it
 * is handed to the flow as well so that operations the store does not cover can
 * be scheduled too. The one that matters is the **roster**: every
 * administrative boundary this suite has to prove -- a revocation, an address
 * change, an invalidation landing between a credential's marker and the
 * decision that follows it -- is a roster read or a roster write, and an
 * interleaving that cannot be scheduled cannot be proved.
 */
export type Gate = <T>(op: StoreOpName, path: string, run: () => Promise<T>) => Promise<T>

export type Flow = {
  id: string
  run: (store: PrivateStore, gate: Gate) => Promise<unknown>
}

export type FlowResult =
  | { ok: true; value: unknown }
  | { ok: false; error: unknown }

export type RunOutcome = {
  /** Every released operation, in the order the schedule released it. */
  trace: SpiedCall[]
  /** Every store call that completed, in completion order. */
  calls: SpiedCall[]
  results: Map<string, FlowResult>
  /** The choice index taken at each scheduling point. */
  taken: number[]
  /** How many flows were runnable at each scheduling point. */
  counts: number[]
}

type Pending = { call: SpiedCall; resume: () => void }

/**
 * A decision function. Given the ids of every flow currently waiting at a
 * storage operation, in a stable order, return the index of the one to release.
 */
export type Choose = (waiting: string[], step: number) => number

/** Release flows strictly in the order named, then fall back to the first waiting. */
export function scripted(script: readonly string[]): Choose {
  return (waiting, step) => {
    const wanted = script[step]
    if (wanted === undefined) return 0
    const index = waiting.indexOf(wanted)
    if (index < 0) {
      throw new Error(
        `schedule step ${step} wanted "${wanted}" but only [${waiting.join(', ')}] were waiting`,
      )
    }
    return index
  }
}

export type ScheduleOptions = {
  store: PrivateStore
  flows: Flow[]
  choose: Choose
  /**
   * Let this many writes land and then throw `InjectedCrash` from the next
   * write's return, killing whichever flow performed it. 0 or undefined means
   * no crash.
   */
  crashAfterWrite?: number
}

/**
 * Run every flow concurrently over one store, releasing exactly one operation
 * at a time in the order `choose` picks.
 *
 * The scheduler only ever picks when every unfinished flow is waiting at an
 * operation, so the released order **is** the interleaving: there is no hidden
 * concurrency and no reliance on the event loop's own ordering.
 */
export async function runSchedule(options: ScheduleOptions): Promise<RunOutcome> {
  const { store, flows, choose } = options
  const crashAfter = options.crashAfterWrite ?? 0

  const pending = new Map<string, Pending>()
  const done = new Set<string>()
  const trace: SpiedCall[] = []
  const calls: SpiedCall[] = []
  const taken: number[] = []
  const counts: number[] = []
  let writes = 0
  let notify: (() => void) | null = null

  /**
   * Wake the scheduler, but only once **every** unfinished flow is parked at an
   * operation. Waking early would let it pick from an incomplete waiting set,
   * and the released order would stop being the interleaving.
   */
  function announce(): void {
    if (pending.size + done.size < flows.length) return
    const waiter = notify
    notify = null
    waiter?.()
  }

  function settled(): Promise<void> {
    if (pending.size + done.size >= flows.length) return Promise.resolve()
    return new Promise<void>((resolve) => {
      notify = resolve
    })
  }

  function gatesFor(flowId: string): { store: PrivateStore; gate: Gate } {
    async function permit(op: StoreOpName, path: string): Promise<SpiedCall> {
      const call: SpiedCall = { flow: flowId, op, path }
      await new Promise<void>((resume) => {
        pending.set(flowId, { call, resume })
        announce()
      })
      return call
    }

    function after(call: SpiedCall): void {
      calls.push(call)
      if (!WRITE_OPS.includes(call.op)) return
      writes += 1
      if (crashAfter > 0 && writes === crashAfter) throw new InjectedCrash(call)
    }

    const gate: Gate = async (op, path, run) => {
      const call = await permit(op, path)
      const value = await run()
      after(call)
      return value
    }

    const gated: PrivateStore = {
      driver: store.driver,
      writable: store.writable,
      provenAtomic: store.provenAtomic,
      async read(path) {
        const call = await permit('read', path)
        const value = await store.read(path)
        after(call)
        return value
      },
      async readVersioned(path) {
        const call = await permit('readVersioned', path)
        const value = await store.readVersioned(path)
        after(call)
        return value
      },
      async create(path, body) {
        const call = await permit('create', path)
        const value = await store.create(path, body)
        after(call)
        return value
      },
      async writeIfMatch(path, body, version) {
        const call = await permit('writeIfMatch', path)
        const value = await store.writeIfMatch(path, body, version)
        after(call)
        return value
      },
      async removeIfMatch(path, version) {
        const call = await permit('removeIfMatch', path)
        const value = await store.removeIfMatch(path, version)
        after(call)
        return value
      },
      async list(prefix) {
        const call = await permit('list', prefix)
        const value = await store.list(prefix)
        after(call)
        return value
      },
    }

    return { store: gated, gate }
  }

  const results = new Map<string, FlowResult>()

  const running = flows.map((flow) => {
    const { store: gated, gate } = gatesFor(flow.id)
    return flow
      .run(gated, gate)
      .then(
        (value) => results.set(flow.id, { ok: true, value }),
        (error) => results.set(flow.id, { ok: false, error }),
      )
      .finally(() => {
        done.add(flow.id)
        pending.delete(flow.id)
        announce()
      })
  })

  let step = 0
  for (;;) {
    await settled()
    if (done.size >= flows.length) break
    const waiting = Array.from(pending.keys()).sort()
    if (waiting.length === 0) continue
    const index = choose(waiting, step)
    if (index < 0 || index >= waiting.length) {
      throw new Error(`schedule step ${step} chose ${index} of ${waiting.length}`)
    }
    counts.push(waiting.length)
    taken.push(index)
    const picked = waiting[index]
    const entry = pending.get(picked) as Pending
    pending.delete(picked)
    trace.push(entry.call)
    step += 1
    entry.resume()
  }

  await Promise.all(running)
  return { trace, calls, results, taken, counts }
}

export type ExploreOptions<S> = {
  /** Build a fresh world for one run. Called once per interleaving. */
  setup: () => Promise<{ store: PrivateStore; flows: Flow[]; world: S }> | {
    store: PrivateStore
    flows: Flow[]
    world: S
  }
  /** Checked after every run. Throw to fail. */
  check: (outcome: RunOutcome, world: S) => Promise<void> | void
  /** Let this many writes land, then crash the flow that made the next one. */
  crashAfterWrite?: number
  /** Safety valve. Exceeding it throws rather than running for ever. */
  maxRuns?: number
}

/**
 * Enumerate every interleaving of the flows' storage operations, and check the
 * invariants after each one.
 *
 * Depth-first over the scheduling decisions, re-running the scenario from a
 * fresh world for every ordering. Returns the number of interleavings visited,
 * which is asserted in the tests so that a scenario silently collapsing to one
 * ordering -- because a flow stopped touching the store, say -- is caught.
 */
export async function explore<S>(options: ExploreOptions<S>): Promise<number> {
  const limit = options.maxRuns ?? 50_000
  let path: number[] = []
  let runs = 0

  for (;;) {
    const prefix = path
    const { store, flows, world } = await options.setup()
    const outcome = await runSchedule({
      store,
      flows,
      crashAfterWrite: options.crashAfterWrite,
      choose: (waiting, step) => {
        if (step >= prefix.length) return 0
        if (prefix[step] >= waiting.length) {
          // Replaying the same decisions must reproduce the same state, so this
          // cannot happen. Saying so loudly beats looping for ever if it does.
          throw new Error(`replay diverged at step ${step}`)
        }
        return prefix[step]
      },
    })
    await options.check(outcome, world)

    runs += 1
    if (runs > limit) throw new Error(`explore() exceeded ${limit} interleavings`)

    // Backtrack to the last decision that still has an unexplored alternative.
    let next: number[] | null = null
    for (let i = outcome.taken.length - 1; i >= 0; i -= 1) {
      if (outcome.taken[i] + 1 < outcome.counts[i]) {
        next = [...outcome.taken.slice(0, i), outcome.taken[i] + 1]
        break
      }
    }
    if (!next) return runs
    path = next
  }
}

/**
 * Every crash point in one scenario: run it once with no crash, then once for
 * each durable write, killing the flow immediately after that write lands.
 *
 * `check` receives the crash index (0 meaning "no crash") so a test can assert
 * both the crashed state and what one more attempt converges to.
 */
export async function exploreCrashes<S>(options: {
  setup: () => Promise<{ store: PrivateStore; flows: Flow[]; world: S }> | {
    store: PrivateStore
    flows: Flow[]
    world: S
  }
  check: (outcome: RunOutcome, world: S, crashAfterWrite: number) => Promise<void> | void
  maxWrites?: number
}): Promise<number> {
  const ceiling = options.maxWrites ?? 40

  // One clean run, to learn how many durable writes the scenario performs.
  const first = await options.setup()
  const clean = await runSchedule({
    store: first.store,
    flows: first.flows,
    choose: () => 0,
  })
  await options.check(clean, first.world, 0)

  const writes = clean.calls.filter((call) => WRITE_OPS.includes(call.op)).length
  const total = Math.min(writes, ceiling)

  for (let k = 1; k <= total; k += 1) {
    const world = await options.setup()
    const outcome = await runSchedule({
      store: world.store,
      flows: world.flows,
      choose: () => 0,
      crashAfterWrite: k,
    })
    await options.check(outcome, world.world, k)
  }

  return total
}
