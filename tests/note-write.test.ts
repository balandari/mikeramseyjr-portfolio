import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/*
 * What one note write does, and in what order.
 *
 * `docs/author-reader.md` promises three things about a save that loses a
 * race: exactly one attempt is made, against the version the browser
 * rendered; a refusal is reported and the typed words are left where they
 * are; and only a save that succeeded ends the edit. Those promises used to
 * live inside `ChapterReader.tsx`, where nothing could import them, and the
 * only way to examine them was to read the component's source as text.
 *
 * `components/reader/note-write.ts` is that sequence as a pure module, so it
 * can be run rather than read. Everything below drives the real
 * `writeNoteOnce` with a fake `send` and counts what actually happened: how
 * many requests went out, with which arguments, in which order the effects
 * fired, and which of them did not fire at all.
 *
 * What this reaches and what it does not is set out in the "Reach and limits
 * of the proof" section of
 * `D:\mrb\cd\reports\2026-09-16-author-site-note-contract-p1-c4.md`. In
 * short: this file proves the helper's behaviour, and the whole-file guards in
 * `tests/note-composer.test.ts` constrain how the component reaches it. Neither
 * renders the component, so what the component does inside its own callbacks is
 * outside both -- and that is now covered by `tests/reader-note-save.test.tsx`,
 * which mounts the real reader and drives the composer through a DOM.
 */

import {
  TRANSPORT_FAILURE,
  writeNoteOnce,
  type NoteWriteEffects,
} from '../components/reader/note-write.ts'

type Outcome<T> = { ok: true; value: T } | { ok: false; message: string; conflict?: true }

/** A saved row, standing in for `ClientNote`. Only its identity matters here. */
const SAVED = { id: 'note-1', revision: 4 } as const

/**
 * A recorder for everything the helper does, in the order it does it.
 *
 * The log is the point: a test that only counted calls would pass on a helper
 * that reported a failure before it had finished sending, or that ended the
 * edit before the list was updated.
 */
function recorder<T>() {
  const log: string[] = []
  const busy: boolean[] = []
  const reported: (string | null)[] = []
  const accepted: T[] = []
  let finished = 0

  const effects: NoteWriteEffects<T> = {
    busy: (value) => {
      busy.push(value)
      log.push(`busy:${value}`)
    },
    report: (message) => {
      reported.push(message)
      log.push(`report:${message === null ? 'null' : message}`)
    },
    accepted: (value) => {
      accepted.push(value)
      log.push('accepted')
    },
    finished: () => {
      finished += 1
      log.push('finished')
    },
  }

  return {
    effects,
    log,
    busy,
    reported,
    accepted,
    get finished() {
      return finished
    },
  }
}

/** A fake transport with the shape of `updateNoteRecord`, and a call ledger. */
function transport<T>(answer: () => Promise<Outcome<T>>) {
  const calls: unknown[][] = []
  const send = (...args: unknown[]): Promise<Outcome<T>> => {
    calls.push(args)
    return answer()
  }
  return { send, calls }
}

/* ------------------------------------------------ one request, and only one */

test('an accepted write sends exactly one request and reports success', async () => {
  const seen = recorder<typeof SAVED>()
  const { send, calls } = transport<typeof SAVED>(async () => ({ ok: true, value: SAVED }) as const)

  const result = await writeNoteOnce(send, ['endpoint', 'book', 'note-1', 4, { visibility: 'private' }], seen.effects)

  assert.equal(result, true, 'an accepted write does not tell its caller it succeeded')
  assert.equal(calls.length, 1, 'an accepted write makes more than one attempt')
})

test('a refused write sends exactly one request -- it is not retried', async () => {
  const seen = recorder<typeof SAVED>()
  const { send, calls } = transport<typeof SAVED>(
    async () => ({ ok: false, message: 'That has changed since you opened it.', conflict: true }) as const,
  )

  const result = await writeNoteOnce(send, ['endpoint', 'book', 'note-1', 4, { visibility: 'shared' }], seen.effects)

  assert.equal(result, false, 'a refused write does not tell its caller it failed')
  assert.equal(
    calls.length,
    1,
    'a refused write is sent again -- a retry at a revision nobody rendered re-widens a note narrowed elsewhere',
  )
})

/* ----------------------------------------- the arguments, exactly as handed */

test('the transport receives the arguments it was given, spread and untouched', async () => {
  const seen = recorder<typeof SAVED>()
  const { send, calls } = transport<typeof SAVED>(async () => ({ ok: true, value: SAVED }) as const)

  const endpoint = { url: '/review/api/reading' }
  const changes = { visibility: 'private' as const }
  const args = [endpoint, 'the-backward-becoming', 'note-1', 4, changes] as const

  await writeNoteOnce(send, [...args], seen.effects)

  // Positional arguments, not the array itself.
  assert.equal(calls[0].length, 5, 'the transport was handed the argument list rather than the arguments')
  assert.deepEqual(calls[0], [...args], 'the arguments were altered on the way through')

  // The revision is the one it was handed. Nothing derived it.
  assert.equal(calls[0][3], 4, 'the revision sent is not the revision given')

  // The objects are passed through, not copied and rebuilt.
  assert.equal(calls[0][0], endpoint, 'the endpoint was replaced on the way through')
  assert.equal(calls[0][4], changes, 'the changes were replaced on the way through')
})

test('a transport of a different shape is handed its own arguments unchanged', async () => {
  // `saveNote` takes two arguments where `updateNoteRecord` takes five, and the
  // composer reaches both through this one helper.
  const seen = recorder<typeof SAVED>()
  const { send, calls } = transport<typeof SAVED>(async () => ({ ok: true, value: SAVED }) as const)

  const input = { bookSlug: 'the-backward-becoming', body: 'words', visibility: 'shared' as const }
  await writeNoteOnce(send, [{ url: '/review/api/reading' }, input], seen.effects)

  assert.equal(calls[0].length, 2)
  assert.equal(calls[0][1], input)
})

/* ---------------------------------------------------------- the fixed order */

test('a write that succeeded runs busy, send, busy, accepted, finished -- in that order', async () => {
  const seen = recorder<typeof SAVED>()
  const send = (...args: unknown[]): Promise<Outcome<typeof SAVED>> => {
    void args
    seen.log.push('send')
    return Promise.resolve({ ok: true, value: SAVED } as const)
  }

  await writeNoteOnce(send, ['endpoint', 'book', 'note-1', 4, {}], seen.effects)

  assert.deepEqual(seen.log, ['busy:true', 'send', 'busy:false', 'accepted', 'finished'])
})

test('a write that failed runs busy, send, busy, report -- and stops there', async () => {
  const seen = recorder<typeof SAVED>()
  const send = (...args: unknown[]): Promise<Outcome<typeof SAVED>> => {
    void args
    seen.log.push('send')
    return Promise.resolve({ ok: false, message: 'That is no longer there.' } as const)
  }

  await writeNoteOnce(send, ['endpoint', 'book', 'note-1', 4, {}], seen.effects)

  assert.deepEqual(seen.log, ['busy:true', 'send', 'busy:false', 'report:That is no longer there.'])
})

test('busy is set true before the request and false after it, exactly once each', async () => {
  const seen = recorder<typeof SAVED>()
  const { send } = transport<typeof SAVED>(async () => ({ ok: true, value: SAVED }) as const)

  await writeNoteOnce(send, ['endpoint'], seen.effects)

  assert.deepEqual(seen.busy, [true, false])
})

/* ------------------------------------- what only a success is allowed to do */

test('a failed write never ends the edit, and never touches the list', async () => {
  const seen = recorder<typeof SAVED>()
  const { send } = transport<typeof SAVED>(
    async () => ({ ok: false, message: 'That has changed since you opened it.', conflict: true }) as const,
  )

  const result = await writeNoteOnce(send, ['endpoint'], seen.effects)

  assert.equal(result, false)
  assert.equal(
    seen.finished,
    0,
    'a failed write ends the edit, so the draft it could not save is gone',
  )
  assert.equal(seen.accepted.length, 0, 'a failed write repaints the list from a write that did not happen')
})

test('a failed write reports the server’s message verbatim', async () => {
  const seen = recorder<typeof SAVED>()
  const { send } = transport<typeof SAVED>(
    async () => ({ ok: false, message: 'That has changed since you opened it.', conflict: true }) as const,
  )

  await writeNoteOnce(send, ['endpoint'], seen.effects)

  assert.deepEqual(seen.reported, ['That has changed since you opened it.'])
})

test('an accepted write hands the saved record over before it ends the edit', async () => {
  const seen = recorder<typeof SAVED>()
  const { send } = transport<typeof SAVED>(async () => ({ ok: true, value: SAVED }) as const)

  await writeNoteOnce(send, ['endpoint'], seen.effects)

  assert.deepEqual(seen.accepted, [SAVED], 'the saved record did not reach the caller')
  assert.equal(seen.finished, 1, 'a successful write does not end the edit')
  assert.equal(seen.reported.length, 0, 'a successful write reports a failure')
  assert.ok(
    seen.log.indexOf('accepted') < seen.log.indexOf('finished'),
    'the edit ends before the saved record reaches the list',
  )
})

test('finished is optional -- a caller that has nothing to end omits it', async () => {
  // The two one-tap changes pass no `finished`: there is no draft to keep and
  // no sheet to close.
  const log: string[] = []
  const { send } = transport<typeof SAVED>(async () => ({ ok: true, value: SAVED }) as const)

  const result = await writeNoteOnce(send, ['endpoint'], {
    busy: (value) => log.push(`busy:${value}`),
    report: (message) => log.push(`report:${message}`),
    accepted: () => log.push('accepted'),
  })

  assert.equal(result, true)
  assert.deepEqual(log, ['busy:true', 'busy:false', 'accepted'])
})

/* ------------------------------------------------ the composer's pre-clear */

/*
 * Only the composer clears the banner at the start of a write, because only
 * the composer ever did (`ChapterReader.tsx`, `setBusy(true)` then
 * `setOutcome(null)`). The two one-tap changes leave a previous failure
 * message on screen through the next tap. That is existing behaviour, and a
 * helper that cleared it for everybody would be a user-visible change made
 * inside a refactor that promises not to make any.
 */

test('the composer clears the previous report before sending, and only it does', async () => {
  const seen = recorder<typeof SAVED>()
  const send = (...args: unknown[]): Promise<Outcome<typeof SAVED>> => {
    void args
    seen.log.push('send')
    return Promise.resolve({ ok: true, value: SAVED } as const)
  }

  await writeNoteOnce(send, ['endpoint'], { ...seen.effects, clearReport: true })

  assert.deepEqual(seen.log, ['busy:true', 'report:null', 'send', 'busy:false', 'accepted', 'finished'])
  assert.deepEqual(seen.reported, [null], 'the pre-clear did not clear, or cleared more than once')
})

test('a caller that does not opt in reports nothing before sending', async () => {
  const seen = recorder<typeof SAVED>()
  const send = (...args: unknown[]): Promise<Outcome<typeof SAVED>> => {
    void args
    seen.log.push('send')
    return Promise.resolve({ ok: true, value: SAVED } as const)
  }

  await writeNoteOnce(send, ['endpoint'], seen.effects)

  assert.ok(!seen.log.includes('report:null'), 'a one-tap change cleared the banner it was not asked to clear')
  assert.deepEqual(seen.reported, [])
})

test('clearReport false is the same as not passing it', async () => {
  const seen = recorder<typeof SAVED>()
  const { send } = transport<typeof SAVED>(async () => ({ ok: true, value: SAVED }) as const)

  await writeNoteOnce(send, ['endpoint'], { ...seen.effects, clearReport: false })

  assert.deepEqual(seen.reported, [])
})

/* ------------------------------------------------------ a transport that rejects */

/*
 * A request that never arrives.
 *
 * `send` in `app/review/reading-client.ts` calls `fetch` without a guard, and
 * neither `saveNote` nor `updateNoteRecord` wraps it, so an offline tab or a
 * dropped connection does not come back as a refusal with a message -- it
 * throws.
 *
 * Until Package 2-0 that rejected out of this helper with `busy` left `true`,
 * and two tests stood here pinning exactly that: one asserting the rejection
 * propagated with `busy` still `true`, and one asserting the helper's source
 * contained no `try`, `catch` or `finally`. Both were deliberate: the C4
 * refactor promised to preserve behaviour rather than improve it, and an
 * unpinned behaviour is one a tidy-up can quietly alter later.
 *
 * The behaviour has now been changed on purpose, so both tests are retired
 * with it and replaced by the four below, which assert the new contract
 * instead of the old one. The composer that used to be stuck at "Saving…"
 * after a dropped connection now says what happened and can be pressed again.
 */

test('a rejected transport does not reject out of the helper', async () => {
  const seen = recorder<typeof SAVED>()
  const send = (...args: unknown[]): Promise<Outcome<typeof SAVED>> => {
    void args
    return Promise.reject(new Error('network'))
  }

  const accepted = await writeNoteOnce(send, ['endpoint'], seen.effects)

  assert.equal(accepted, false, 'a rejected transport is reported as an accepted write')
})

test('a rejected transport clears busy, reports, and ends nothing', async () => {
  const seen = recorder<typeof SAVED>()
  const send = (...args: unknown[]): Promise<Outcome<typeof SAVED>> => {
    void args
    return Promise.reject(new Error('network'))
  }

  await writeNoteOnce(send, ['endpoint'], seen.effects)

  assert.deepEqual(
    seen.busy,
    [true, false],
    'a rejected transport leaves busy stuck -- the composer cannot be used again',
  )
  assert.deepEqual(seen.reported, [TRANSPORT_FAILURE], 'a rejected transport reports nothing, or something else')
  assert.equal(seen.accepted.length, 0, 'a rejected transport updates the list')
  assert.equal(seen.finished, 0, 'a rejected transport ends the edit -- the draft would be lost')
  assert.deepEqual(seen.log, ['busy:true', 'busy:false', `report:${TRANSPORT_FAILURE}`])
})

test('a rejected transport is sent once, and never again', async () => {
  const seen = recorder<typeof SAVED>()
  let calls = 0
  const send = (...args: unknown[]): Promise<Outcome<typeof SAVED>> => {
    void args
    calls += 1
    return Promise.reject(new Error('network'))
  }

  await writeNoteOnce(send, ['endpoint'], seen.effects)

  assert.equal(calls, 1, 'a rejected transport is retried')
})

test('the reported failure says nothing about the transport or the server', async () => {
  const seen = recorder<typeof SAVED>()
  const send = (...args: unknown[]): Promise<Outcome<typeof SAVED>> => {
    void args
    return Promise.reject(new Error('getaddrinfo ENOTFOUND internal.blob.example'))
  }

  await writeNoteOnce(send, ['endpoint'], seen.effects)

  const [message] = seen.reported
  assert.equal(message, TRANSPORT_FAILURE)
  assert.doesNotMatch(String(message), /ENOTFOUND|internal\.blob|getaddrinfo/, 'the error reached the reader')
})

test('the reported failure is the same wording an unrecognised refusal gets', () => {
  /*
   * `TRANSPORT_FAILURE` is written out in the helper rather than imported,
   * because a value import would pull the browser client into this module's
   * runtime graph (see the test below). This is the guard that keeps the two
   * copies identical, so a save that failed reads the same to a reader whether
   * the server refused it or the request never got there.
   */
  const client = readFileSync(
    new URL('../app/review/reading-client.ts', import.meta.url),
    'utf8',
  )

  assert.ok(
    client.includes(`message: '${TRANSPORT_FAILURE}'`),
    'the client no longer answers an unrecognised failure with this wording',
  )
})

test('the composer’s pre-clear still runs when the transport then rejects', async () => {
  /*
   * Kept from C4, with its assertion widened by exactly what changed: the
   * pre-clear ran, and then the request failed. It is still not rolled back --
   * `report:null` is still the second thing that happens -- but the sequence no
   * longer stops there, because the helper now finishes the write instead of
   * throwing out of the middle of it.
   */
  const seen = recorder<typeof SAVED>()
  const send = (...args: unknown[]): Promise<Outcome<typeof SAVED>> => {
    void args
    return Promise.reject(new Error('network'))
  }

  await writeNoteOnce(send, ['endpoint'], { ...seen.effects, clearReport: true })

  assert.deepEqual(seen.log, [
    'busy:true',
    'report:null',
    'busy:false',
    `report:${TRANSPORT_FAILURE}`,
  ])
})

test('the helper catches in exactly one place, around the one request', () => {
  /*
   * What replaces "the helper contains no try, catch or finally".
   *
   * The retired guard existed so a `try { … } finally { busy(false) }` could
   * not be added quietly. The risk it was guarding against is still real and
   * has only moved: a `finally` would run `busy(false)` on the success path
   * too, which is correct today only because the success path sets it
   * explicitly -- and a `catch` in a second place would be a second failure
   * path with its own wording. One `try`, one `catch`, no `finally`.
   */
  const source = readHelperSource()

  assert.equal(source.split(/\btry\s*\{/).length - 1, 1, 'the helper catches in more than one place')
  assert.equal(source.split(/\bcatch\s*[({]/).length - 1, 1, 'the helper catches in more than one place')
  assert.doesNotMatch(source, /\bfinally\s*\{/, 'writeNoteOnce runs an effect in a finally')
})

test('the helper imports no value, and no React', () => {
  const source = readHelperSource()

  // `npm test` runs these through Node's type-stripping loader. A value import
  // would pull the whole browser client into this module's runtime graph.
  const imports = source.match(/^import .*$/gm) ?? []
  assert.equal(imports.length, 1, 'the helper gained an import')
  assert.match(imports[0], /^import type /, 'the helper imports a value')
  assert.doesNotMatch(source, /['"]react['"]/, 'the helper imports React')
})

function readHelperSource(): string {
  return readFileSync(new URL('../components/reader/note-write.ts', import.meta.url), 'utf8')
}
