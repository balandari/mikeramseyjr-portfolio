/**
 * The note composer, rendered and driven.
 *
 * Everything else that examines this behaviour examines it indirectly.
 * `tests/note-write.test.ts` runs the real `writeNoteOnce` against a fake
 * transport, which proves what the helper does when it is called. The
 * whole-file guards in `tests/note-composer.test.ts` read `ChapterReader.tsx`
 * as text, which constrains how the component reaches it. Neither renders
 * anything, and the C4 record named four classes of defect that live in exactly
 * that gap:
 *
 *   **E1** — the component's own `report` callback closing the sheet over an
 *   unsaved draft.
 *   **E2** — a `.finally` on the composer button's `onClick`, clearing the
 *   draft whether or not the save succeeded.
 *   **S2** — a loop around one `writeNoteOnce(` call site, which sends twice
 *   and leaves the guard's occurrence count at four.
 *   **S4** — the component's own `report` callback discarding the draft.
 *
 * All four are invisible to a helper test and to a source count. All four are
 * ordinary failures of a rendered composer, so this file renders the real
 * `ChapterReader` -- the component the reviewer's reader and Mike's reader both
 * are, with no double, no test-only branch and no extraction -- and drives it
 * through a browser's events.
 *
 * ## Where the seam is
 *
 * At `fetch`, and nowhere above it. The component, `writeNoteOnce`,
 * `reading-client.ts`'s `saveNote` and `updateNoteRecord`, and its
 * status-to-message mapping are all the shipped code, running. What is replaced
 * is the network, which is the one thing a test cannot have -- so "exactly one
 * request" below is a count of real requests that real production code composed
 * and really tried to send.
 *
 * ## What the DOM is
 *
 * `tests/helpers/dom.ts`, which builds one jsdom window for this file and puts
 * every global it touched back afterwards. Its shims are listed there with a reason
 * each; none of them stands in for anything this file asserts about.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { installDom, type DomHandle } from './helpers/dom.ts'
import { TRANSPORT_FAILURE } from '../components/reader/note-write.ts'
import type { ClientNote } from '../lib/reading-view.ts'

/* ------------------------------------------------------------------ fixtures */

const BOOK = { slug: 'the-backward-becoming', title: 'The Backward Becoming' }

const CHAPTER = {
  slug: 'one',
  number: 1,
  title: 'The first chapter',
  label: 'Chapter one',
  subtitle: 'In which something happens',
  paragraphCount: 2,
  minutes: 4,
}

const BLOCKS = [
  {
    kind: 'paragraph' as const,
    id: 'p-one',
    ordinal: 1,
    variant: 'prose' as const,
    tight: false,
    segments: [{ kind: 'text' as const, text: 'The first paragraph of the chapter.' }],
  },
  {
    kind: 'paragraph' as const,
    id: 'p-two',
    ordinal: 2,
    variant: 'prose' as const,
    tight: false,
    segments: [{ kind: 'text' as const, text: 'The second paragraph of the chapter.' }],
  },
]

/** A note this reviewer already wrote, as the server last gave it to them. */
const EXISTING: ClientNote = {
  id: 'note-existing',
  ownerKind: 'reviewer',
  ownerId: 'reviewer-1',
  bookSlug: BOOK.slug,
  scope: 'chapter',
  body: 'What I said the first time.',
  visibility: 'shared',
  status: 'open',
  anchor: {
    scope: 'chapter',
    chapterSlug: CHAPTER.slug,
    chapterNumber: 1,
    chapterLabel: CHAPTER.label,
    manuscriptSha256: 'a'.repeat(64),
  },
  revision: 3,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  anchorState: 'ok',
  manuscriptChanged: false,
  paragraphId: null,
  own: true,
}

/** What the server would answer with for an accepted `note-create`. */
function saved(body: string): ClientNote {
  return { ...EXISTING, id: 'note-new', body, revision: 1 }
}

/* ------------------------------------------------------------ the transport */

type Recorded = { op: string; body: Record<string, unknown> }

/**
 * A network, recorded.
 *
 * `answer` decides what each note write gets: a `ClientNote` for an accepted
 * one, a status for a refusal, or a thrown error for a request that never
 * arrives. The two reads the reader makes on mount are answered emptily and are
 * not recorded, because nothing here is about them.
 */
function network(answer: (call: Recorded, index: number) => Promise<Response>) {
  const writes: Recorded[] = []

  const fetchDouble = async (input: unknown, init?: { body?: string }): Promise<Response> => {
    const url = String(input)

    if (!init?.body) {
      const empty = url.includes('/feedback')
        ? { feedback: [] }
        : { position: null, bookmarks: [], annotations: [], notes: [] }
      return new Response(JSON.stringify(empty), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    const body = JSON.parse(init.body) as Record<string, unknown>
    const call = { op: String(body.op ?? ''), body }
    writes.push(call)
    return answer(call, writes.length - 1)
  }

  return { fetchDouble, writes }
}

function accepted(note: ClientNote): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ note }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

function refused(status: number): Promise<Response> {
  return Promise.resolve(new Response('{}', { status, headers: { 'content-type': 'application/json' } }))
}

/* ------------------------------------------------------------------ mounting */

/*
 * One window for this file, built before Testing Library is imported.
 *
 * `@testing-library/dom` captures `window` once, when it is first loaded, and
 * every query it answers afterwards is against that window's document. A second
 * jsdom built for a second test would therefore be invisible to it, and every
 * query would search the first, now-empty, document. So the DOM is installed
 * once here and taken down once at the end, and what is restored *between*
 * tests is everything a test itself mutated: the mounted tree, and `fetch`.
 *
 * `node --test` runs each file in its own process, so one window per file
 * leaks nothing into any other file either way.
 */
let dom: DomHandle
let rtl: typeof import('@testing-library/react')
let ChapterReader: typeof import('../app/review/[book]/[chapter]/ChapterReader.tsx').default

/** The `fetch` this file replaced, and how it is put back. */
let realFetch: PropertyDescriptor | undefined

/*
 * Loaded in a hook rather than at the top of the file, because the repository's
 * TypeScript target does not allow a top-level `await` and these two imports
 * must not happen until the window exists.
 */
test.before(async () => {
  dom = installDom()
  realFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  rtl = await import('@testing-library/react')
  ChapterReader = (await import('@/app/review/[book]/[chapter]/ChapterReader')).default
})

function useNetwork(fetchDouble: (input: unknown, init?: { body?: string }) => Promise<Response>) {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: fetchDouble,
  })
}

test.afterEach(() => {
  rtl.cleanup()
  if (realFetch) Object.defineProperty(globalThis, 'fetch', realFetch)
  else delete (globalThis as Record<string, unknown>).fetch
})

test.after(() => {
  dom.restore()
})

function mount(notes?: ClientNote[]) {
  return rtl.render(
    <ChapterReader
      namespace="reviewer:reviewer-1"
      endpoint={{ url: '/review/api/reading' }}
      bookBase={`/review/${BOOK.slug}`}
      workspaceHref="/review/my-reading"
      voice="reviewer"
      book={BOOK}
      chapter={CHAPTER}
      blocks={BLOCKS}
      contents={[
        {
          slug: CHAPTER.slug,
          number: 1,
          label: CHAPTER.label,
          subtitle: CHAPTER.subtitle,
          minutes: 4,
        },
      ]}
      previousSlug={null}
      nextSlug={null}
      initial={{ position: null, bookmarks: [], annotations: [], notes: notes ?? [] }}
    />,
  )
}

/** The composer's controls, found the way a reader finds them. */
const composer = {
  sheet: () => rtl.screen.queryByRole('dialog', { name: /Write a note|Edit your note/ }),
  draft: () => rtl.screen.getByLabelText('Your note') as HTMLTextAreaElement,
  save: () =>
    rtl.screen.getByRole('button', { name: /^(Save note|Save changes|Saving…)$/ }) as HTMLButtonElement,
  /*
   * Scoped to the composer on purpose. A failure is announced twice -- once
   * inside the sheet, above the words it is about, and once in the reader's own
   * banner behind it -- and the one that matters here is the one the person
   * looking at their unsaved draft can see.
   */
  alert: () => {
    const sheet = composer.sheet()
    return sheet ? rtl.within(sheet).queryByRole('alert') : null
  },
}

/** Let React flush the effects a resolved promise queued. */
async function settle() {
  await rtl.act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}


/* ================================================================== proof 5 */

test('the real reader renders, and opens its real composer', async () => {
  const { fetchDouble } = network(() => refused(500))
  useNetwork(fetchDouble)
  mount()
  await settle()

  assert.ok(rtl.screen.getByText('The first paragraph of the chapter.'), 'the manuscript did not render')
  assert.equal(composer.sheet(), null, 'the composer is open before anybody opened it')

  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Note' }))

  assert.ok(composer.sheet(), 'the composer did not open')
  assert.ok(composer.draft(), 'the composer has nowhere to write')
  assert.equal(composer.save().textContent, 'Save note')
})

/* ================================================================== proof 1 */

test('a pending save disables the save control', async () => {
  let release: (() => void) | null = null
  const { fetchDouble, writes } = network(
    () =>
      new Promise<Response>((resolve) => {
        release = () =>
          resolve(new Response(JSON.stringify({ note: saved('Held.') }), { status: 200 }))
      }),
  )
  useNetwork(fetchDouble)
  mount()
  await settle()

  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Note' }))
  rtl.fireEvent.change(composer.draft(), { target: { value: 'Held.' } })

  assert.equal(composer.save().disabled, false, 'the save control is disabled before a save begins')

  rtl.fireEvent.click(composer.save())
  await settle()

  assert.equal(writes.length, 1, 'the first save did not send exactly one request')
  assert.equal(composer.save().disabled, true, 'a pending save leaves the save control usable')
  assert.equal(composer.save().textContent, 'Saving…')

  await rtl.act(async () => {
    release?.()
    await Promise.resolve()
  })
  await settle()
})

test('a second submission while the first is in flight sends no second request', async () => {
  let release: (() => void) | null = null
  const { fetchDouble, writes } = network(
    () =>
      new Promise<Response>((resolve) => {
        release = () =>
          resolve(new Response(JSON.stringify({ note: saved('Twice?') }), { status: 200 }))
      }),
  )
  useNetwork(fetchDouble)
  mount()
  await settle()

  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Note' }))
  rtl.fireEvent.change(composer.draft(), { target: { value: 'Twice?' } })

  rtl.fireEvent.click(composer.save())
  await settle()
  rtl.fireEvent.click(composer.save())
  rtl.fireEvent.click(composer.save())
  await settle()

  assert.equal(writes.length, 1, 'a note was submitted more than once while a save was in flight')

  await rtl.act(async () => {
    release?.()
    await Promise.resolve()
  })
  await settle()

  assert.equal(writes.length, 1, 'a second request went out after the first resolved')
})

/* ================================================================== proof 2 */

test('a save that succeeded ends the edit once, and only what the edit owned', async () => {
  const { fetchDouble, writes } = network(() => accepted(saved('Something worth keeping.')))
  useNetwork(fetchDouble)
  mount()
  await settle()

  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Note' }))
  rtl.fireEvent.change(composer.draft(), { target: { value: 'Something worth keeping.' } })
  rtl.fireEvent.click(composer.save())
  await settle()

  assert.equal(writes.length, 1, 'an accepted save sent more than one request')
  assert.equal(writes[0].op, 'note-create')
  assert.equal(writes[0].body.body, 'Something worth keeping.')

  assert.equal(composer.sheet(), null, 'an accepted save left the composer open')

  // The saved row is in the list, once, and it is the server's copy.
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /^Bookmarks and notes \(/ }))
  assert.equal(rtl.screen.getAllByText('Something worth keeping.').length, 1)

  // Reopening the composer finds it empty: the draft was dropped, and there is
  // no second copy of the note waiting to be sent again.
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Close' }))
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Note' }))
  assert.equal(composer.draft().value, '', 'an accepted save left the draft in the composer')
  assert.equal(composer.save().disabled, true, 'an empty composer offers a save')
  assert.equal(writes.length, 1, 'reopening the composer sent a request')
})

/* ================================================================== proof 3 */

test('a rejected transport gives the composer back, with the words still in it', async () => {
  const { fetchDouble, writes } = network(() =>
    Promise.reject(new Error('getaddrinfo ENOTFOUND api.internal.example')),
  )
  useNetwork(fetchDouble)
  mount()
  await settle()

  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Note' }))
  rtl.fireEvent.change(composer.draft(), { target: { value: 'Words the server never got.' } })
  rtl.fireEvent.click(composer.save())
  await settle()

  // S2: one attempt. A rejection is not a reason to try again.
  assert.equal(writes.length, 1, 'a rejected save was retried')

  // The stuck composer this slice exists to fix.
  assert.equal(composer.save().disabled, false, 'a rejected save leaves the save control stuck')
  assert.equal(
    composer.save().textContent,
    'Save note',
    'a rejected save leaves the button saying Saving…',
  )

  // E1: the sheet is still open.
  assert.ok(composer.sheet(), 'a rejected save closed the composer over the unsaved words')

  // E2 and S4: the draft is still there, character for character.
  assert.equal(
    composer.draft().value,
    'Words the server never got.',
    'a rejected save discarded the draft',
  )

  // It says so, and it says nothing about the network.
  const alert = composer.alert()
  assert.ok(alert, 'a rejected save reported nothing at all')
  assert.equal(alert?.textContent, TRANSPORT_FAILURE)
  assert.doesNotMatch(
    String(alert?.textContent),
    /ENOTFOUND|internal/,
    'the transport error reached the reader',
  )
})

test('a rejected transport leaves the notes that were already there alone', async () => {
  const { fetchDouble } = network(() => Promise.reject(new Error('offline')))
  useNetwork(fetchDouble)
  mount([EXISTING])
  await settle()

  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Note' }))
  rtl.fireEvent.change(composer.draft(), { target: { value: 'A second note.' } })
  rtl.fireEvent.click(composer.save())
  await settle()

  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Close' }))
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /^Bookmarks and notes \(/ }))

  assert.ok(rtl.screen.getByText(EXISTING.body), 'a rejected save removed a note that was already stored')
  assert.equal(
    rtl.screen.queryByText('A second note.'),
    null,
    'a rejected save added the unsaved note to the list',
  )
})

/* ================================================================== proof 4 */

test('a conflicted edit is one request, reported, and never sent again', async () => {
  const { fetchDouble, writes } = network(() => refused(409))
  useNetwork(fetchDouble)
  mount([EXISTING])
  await settle()

  // Reach the note the way a reviewer does: the dock, the note, then Edit.
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /^Bookmarks and notes \(/ }))
  rtl.fireEvent.click(rtl.screen.getByText(EXISTING.body))
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Edit' }))

  assert.ok(composer.sheet(), 'the composer did not open on the existing note')
  assert.equal(
    composer.draft().value,
    EXISTING.body,
    'the composer did not open on what the note says',
  )

  rtl.fireEvent.change(composer.draft(), { target: { value: 'What I mean instead.' } })
  rtl.fireEvent.click(composer.save())
  await settle()

  // Exactly one update, against the revision the browser rendered.
  assert.equal(writes.length, 1, 'a conflicted edit was sent more than once')
  assert.equal(writes[0].op, 'note-update')
  assert.equal(writes[0].body.id, EXISTING.id)
  assert.equal(
    writes[0].body.expectedRevision,
    EXISTING.revision,
    'the revision sent was not the one rendered',
  )

  // Interactivity back, draft kept, conflict said in the words the client
  // composes for a 409 -- including the instruction to copy the text first.
  assert.equal(composer.save().disabled, false, 'a conflicted edit leaves the save control stuck')
  assert.ok(composer.sheet(), 'a conflicted edit closed the composer')
  assert.equal(
    composer.draft().value,
    'What I mean instead.',
    'a conflicted edit discarded the draft',
  )

  const alert = composer.alert()
  assert.ok(alert, 'a conflicted edit reported nothing')
  assert.match(String(alert?.textContent), /changed somewhere else/)
  assert.match(String(alert?.textContent), /still on screen; copy it before reloading/)
  assert.notEqual(
    alert?.textContent,
    TRANSPORT_FAILURE,
    'a conflict is reported as a transport failure',
  )
})
