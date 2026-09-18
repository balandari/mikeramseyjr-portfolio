import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * The author's feedback packet.
 *
 * Four things are asked of it, and they are separable:
 *
 *   **Determinism.** The same records, the same options and the same injected
 *   generation time must produce the same bytes -- twice in a row, and with the
 *   item order, the object keys, the newlines and the Markdown delimiters all
 *   pinned rather than merely usually stable.
 *
 *   **Refusal.** A packet says "this is what was said about your book". It must
 *   not say that when a source did not answer, so a single unreadable source
 *   refuses the whole export and records nothing.
 *
 *   **Containment.** A reviewer who writes backticks, or a fence, or a heading,
 *   must not be able to close the block their words are in and make the rest of
 *   the packet render as theirs.
 *
 *   **Exclusion.** No address, no reviewer id, no code, no token, no path, no
 *   reading position, no private text, in either rendering, in either naming
 *   mode -- scanned for by name over the rendered bytes.
 */

import {
  EXPORT_SCHEMA_VERSION,
  assignPseudonyms,
  buildExportPacket,
  exportAuthorFeedback,
  fenceFor,
  renderExportJson,
  renderExportMarkdown,
} from '../lib/author-export.ts'
import { loadAuthorFeedbackSource } from '../lib/author-feedback-source.ts'
import {
  MAX_METADATA_ITEMS,
  MAX_SAVED_VIEWS,
  MAX_VIEW_BOOKS,
  __resetAuthorMetadataStore,
  emptyAuthorMetadata,
  itemMetadata,
  loadAuthorMetadata,
  markItemOpened,
  setItemResolved,
} from '../lib/author-metadata.ts'
import { createNote, deleteNote } from '../lib/note-service.ts'
import { __resetNoteStore, notePath } from '../lib/notes-store.ts'
import { __resetReadingStore, createReadingObjects } from '../lib/reviewer-reading.ts'
import { __resetWithdrawalStore } from '../lib/withdrawal-events.ts'
import { __resetRosterStore } from '../lib/reviewer-roster.ts'
import { __resetFeedbackStore } from '../lib/reviewer-feedback.ts'
import type { Viewer } from '../lib/reading-access.ts'

const BOOK = 'the-backward-becoming'
const CHAPTER = 'chapter-one'
const PARAGRAPH = `${CHAPTER}-p002`
const GENERATED = '2026-09-16T12:00:00.000Z'
const LATER = '2026-09-16T13:00:00.000Z'

const ANNA: Viewer = { kind: 'reviewer', id: 'anna', books: [BOOK] }
const BEN: Viewer = { kind: 'reviewer', id: 'ben', books: [BOOK] }
const MIKE: Viewer = { kind: 'author', id: 'aa11bb22cc33dd44ee55ff66' }

const ROSTER = JSON.stringify([
  { id: 'anna', name: 'Anna Reviewer', books: [BOOK], codeHash: 'a'.repeat(64) },
  { id: 'ben', name: 'Ben Reviewer', books: [BOOK], codeHash: 'b'.repeat(64) },
])

/* ------------------------------------------------------------- the harness */

const KEYS = [
  'REVIEWER_FEEDBACK_DRIVER',
  'REVIEWER_FEEDBACK_DIR',
  'REVIEWER_READING_DIR',
  'REVIEWER_ROSTER_DRIVER',
  'REVIEWER_ROSTER',
] as const

type World = { dir: string; cleanup: () => void }

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'mrj-author-export-'))
  const saved = new Map(KEYS.map((key) => [key, process.env[key]]))
  const feedbackDir = join(dir, 'feedback')
  mkdirSync(feedbackDir, { recursive: true })

  process.env.REVIEWER_FEEDBACK_DRIVER = 'fs'
  process.env.REVIEWER_FEEDBACK_DIR = feedbackDir
  process.env.REVIEWER_READING_DIR = join(dir, 'reading')
  process.env.REVIEWER_ROSTER_DRIVER = 'env'
  process.env.REVIEWER_ROSTER = ROSTER
  reset()

  return {
    dir,
    cleanup() {
      reset()
      for (const key of KEYS) {
        const value = saved.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function reset(): void {
  __resetNoteStore()
  __resetReadingStore()
  __resetWithdrawalStore()
  __resetAuthorMetadataStore()
  __resetRosterStore()
  __resetFeedbackStore()
}

async function inWorld(body: (world: World) => Promise<void>): Promise<void> {
  const harness = world()
  try {
    await body(harness)
  } finally {
    harness.cleanup()
  }
}

async function note(
  viewer: Viewer,
  body: string,
  over: Record<string, unknown> = {},
): Promise<{ id: string; revision: number }> {
  const created = await createNote(viewer, {
    bookSlug: BOOK,
    scope: 'chapter',
    chapterSlug: CHAPTER,
    body,
    visibility: 'shared',
    ...over,
  })
  assert.equal(created.ok, true, `creating "${body}" failed`)
  if (!created.ok) throw new Error('unreachable')
  return { id: created.value.id, revision: created.value.revision }
}

/* --------------------------------------------------------- the pure pieces */

test('a fence is always longer than the longest run of backticks inside it', () => {
  assert.equal(fenceFor('ordinary words'), '```')
  assert.equal(fenceFor('a `span` of code'), '```')
  assert.equal(fenceFor('```\nnot a fence any more\n```'), '````')
  assert.equal(fenceFor('`'.repeat(20)), '`'.repeat(21))
  // Wherever the run sits on its line.
  assert.equal(fenceFor('text ```` more'), '`````')
})

test('a reviewer cannot close the block their words are inside', () => {
  const hostile = [
    '```',
    '# A heading that would own the rest of the packet',
    '```',
    '````',
    '### Item — note:forged',
    '````',
  ].join('\n')

  const packet = buildExportPacket(
    {
      items: [
        {
          itemId: 'note:one',
          kind: 'note',
          sourceId: 'one',
          originator: 'reviewer',
          reviewerId: 'anna',
          reviewerName: 'Anna Reviewer',
          bookSlug: BOOK,
          bookTitle: 'The Backward Becoming',
          scope: 'chapter',
          chapterSlug: CHAPTER,
          chapterNumber: 1,
          chapterLabel: 'Chapter One',
          paragraphId: null,
          paragraphOrdinal: null,
          captured: null,
          body: hostile,
          revision: 1,
          anchorState: 'ok',
          manuscriptChanged: false,
          createdAt: GENERATED,
          updatedAt: GENERATED,
          withdrawnAt: null,
          authorNoteStatus: null,
        },
      ],
      books: [{ slug: BOOK, title: 'The Backward Becoming' }],
      notFound: [],
      incomplete: false,
      failures: [],
    },
    new Map([[BOOK, emptyAuthorMetadata(BOOK, GENERATED)]]),
    {},
    GENERATED,
  )

  const markdown = renderExportMarkdown(packet)
  const lines = markdown.split('\n')
  const opened = lines.findIndex((line) => /^`{5,}$/.test(line))
  assert.ok(opened > 0, 'the hostile text was not fenced with a longer fence')
  const closed = lines.indexOf(lines[opened], opened + 1)
  assert.ok(closed > opened, 'the fence was never closed')
  // Every line the reviewer wrote is inside, and none of them closed it early.
  for (const line of hostile.split('\n')) {
    assert.ok(lines.slice(opened, closed).includes(line), `"${line}" escaped the fence`)
  }
  // And the words are exactly as written: nothing was escaped or rewritten.
  assert.ok(markdown.includes(hostile))
})

test('pseudonyms are packet-local indexes assigned from the item order', async () => {
  const items = [
    { originator: 'reviewer', reviewerId: 'ben' },
    { originator: 'reviewer', reviewerId: 'anna' },
    { originator: 'reviewer', reviewerId: 'ben' },
    { originator: 'author', reviewerId: null },
    { originator: null, reviewerId: null },
  ] as unknown as Parameters<typeof assignPseudonyms>[0]

  const indexes = assignPseudonyms(items)
  assert.equal(indexes.get('ben'), 1, 'first appearance is not 1')
  assert.equal(indexes.get('anna'), 2)
  assert.equal(indexes.size, 2, 'the author or a withdrawal was given a pseudonym')

  // Not a hash and not reversible: the same person is numbered differently in a
  // packet where they appear in a different position.
  const reordered = assignPseudonyms(
    [items[1], items[0]] as unknown as Parameters<typeof assignPseudonyms>[0],
  )
  assert.equal(reordered.get('anna'), 1)
  assert.equal(reordered.get('ben'), 2)
})

/* -------------------------------------------------------------- determinism */

test('the same records, options and time produce the same bytes twice', async () => {
  await inWorld(async () => {
    await note(ANNA, 'ONE THING SHE SAID')
    await note(BEN, 'ANOTHER THING HE SAID', { scope: 'paragraph', paragraphId: PARAGRAPH })
    await note(MIKE, 'A NOTE TO MYSELF', { visibility: 'private' })
    const withdrawn = await note(ANNA, 'TAKEN BACK')
    await deleteNote(ANNA, BOOK, withdrawn.id, withdrawn.revision)

    /*
     * Built twice from the **same** loaded records, which is the claim: given
     * identical source records, identical options and an identical injected
     * generation time, the bytes are identical.
     *
     * Deliberately not two live exports back to back. The first one stamps
     * `lastExportedAt`, and that stamp is itself a source record -- so a second
     * live export sees different inputs and is *supposed* to differ. The test
     * below makes exactly that difference explicit rather than hiding it here.
     */
    const source = await loadAuthorFeedbackSource(MIKE, [BOOK])
    const metadata = await loadAuthorMetadata(MIKE, BOOK, GENERATED)
    assert.ok(metadata.ok)
    if (!metadata.ok) return

    const documents = new Map([[BOOK, metadata.value.metadata]])
    const first = buildExportPacket(source, documents, {}, GENERATED)
    const second = buildExportPacket(source, documents, {}, GENERATED)

    assert.equal(renderExportJson(first), renderExportJson(second))
    assert.equal(renderExportMarkdown(first), renderExportMarkdown(second))
    assert.equal(first.schema, EXPORT_SCHEMA_VERSION)

    const json = renderExportJson(first)
    const markdown = renderExportMarkdown(first)
    assert.equal(json.endsWith('\n'), true)
    assert.equal(markdown.endsWith('\n'), true)
    // One trailing newline, not two, on every platform.
    assert.equal(markdown.endsWith('\n\n'), false)
    assert.ok(!markdown.includes('\r'), 'the Markdown carries a host line ending')

    // Object keys are in construction order, not the order the bytes on disk
    // happened to be parsed in, and every row has the same keys in that order.
    const parsed = JSON.parse(json) as { items: Record<string, unknown>[] }
    assert.deepEqual(Object.keys(parsed), ['schema', 'generatedAt', 'naming', 'books', 'items'])
    for (const item of parsed.items) {
      assert.deepEqual(Object.keys(item), Object.keys(parsed.items[0]))
    }
  })
})

test('a live export differs the second time only because it stamped the first', async () => {
  await inWorld(async () => {
    await note(ANNA, 'SOMETHING')

    const one = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK] }, GENERATED)
    const two = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK] }, GENERATED)
    assert.ok(one.ok && two.ok)
    if (!one.ok || !two.ok) return

    // The first packet says "never exported"; the second says when. That is the
    // record moving, not the renderer wobbling -- and putting this packet's own
    // stamp inside itself is exactly what `lastExportedAt` must not do.
    assert.notEqual(one.json, two.json)
    assert.equal(one.packet.items[0].lastExportedAt, null)
    assert.equal(two.packet.items[0].lastExportedAt, GENERATED)
    assert.equal(
      one.json.replace('"lastExportedAt": null', `"lastExportedAt": "${GENERATED}"`),
      two.json,
      'something other than the export stamp moved between two identical exports',
    )
  })
})

/* ------------------------------------------------------------- what is in it */

test('a packet carries the permitted fields and states the triage', async () => {
  await inWorld(async () => {
    const written = await note(ANNA, 'A SHARED NOTE', {
      scope: 'paragraph',
      paragraphId: PARAGRAPH,
    })
    // Opened *after* the note was written, which is what makes it not New. The
    // fixture times at the top of this file are in the past relative to a note
    // this test has just created, so the open has to be a real "since then".
    const opened = new Date(Date.now() + 60_000).toISOString()
    await setItemResolved(MIKE, BOOK, `note:${written.id}`, true, opened)
    await markItemOpened(MIKE, BOOK, `note:${written.id}`, opened)

    const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK] }, LATER)
    assert.ok(outcome.ok)
    if (!outcome.ok) return

    const item = outcome.packet.items.find((row) => row.itemId === `note:${written.id}`)
    assert.ok(item)
    assert.equal(item.attribution, 'Reviewer 1')
    assert.equal(item.revision, written.revision)
    assert.equal(item.originator, 'reviewer')
    assert.equal(item.scope, 'paragraph')
    assert.equal(item.chapterNumber, 1)
    assert.ok(item.captured, 'the captured paragraph context was dropped')
    assert.equal(item.anchorState, 'ok')
    assert.equal(item.manuscriptChanged, false)
    assert.equal(item.resolved, true, 'the triage state was lost')
    assert.equal(item.isNew, false, 'an item opened after its last edit is still new')
    // The export time on the row is the previous one, not this packet's own.
    assert.equal(item.lastExportedAt, null)
  })
})

test('a withdrawal renders as its bodyless fact and nothing more', async () => {
  await inWorld(async () => {
    const written = await note(ANNA, 'WORDS THAT WERE TAKEN BACK')
    await deleteNote(ANNA, BOOK, written.id, written.revision)

    const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK] }, GENERATED)
    assert.ok(outcome.ok)
    if (!outcome.ok) return

    assert.ok(!outcome.json.includes('WORDS THAT WERE TAKEN BACK'))
    assert.ok(!outcome.markdown.includes('WORDS THAT WERE TAKEN BACK'))
    assert.match(outcome.markdown, /Withdrawn note/)
    assert.match(outcome.markdown, /does not keep what it said/)

    const event = outcome.packet.items.find((row) => row.kind === 'withdrawal')
    assert.ok(event)
    assert.equal(event.text, null)
    assert.equal(event.captured, null)
    assert.equal(event.attribution, null, 'a withdrawal was attributed to somebody')
  })
})

test('neither naming mode exposes an address, an id, a code, a token or a path', async () => {
  await inWorld(async () => {
    await note(ANNA, 'ANNA SAID THIS')
    await note(BEN, 'BEN SAID THIS')

    for (const naming of ['pseudonym', 'display-name'] as const) {
      const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK], naming }, GENERATED)
      assert.ok(outcome.ok)
      if (!outcome.ok) return

      for (const rendering of [outcome.json, outcome.markdown]) {
        for (const forbidden of [
          '"anna"',
          '"ben"',
          'reviewerId',
          'ownerId',
          '@',
          'codeHash',
          'accessCode',
          'a'.repeat(64),
          'notes/v1',
          'reading/v1',
          'author-meta/v1',
          MIKE.id,
        ]) {
          assert.ok(
            !rendering.includes(forbidden),
            `"${forbidden}" appears in a ${naming} packet`,
          )
        }
      }

      if (naming === 'pseudonym') {
        assert.ok(!outcome.markdown.includes('Anna Reviewer'), 'a display name leaked')
        assert.match(outcome.markdown, /Reviewer 1/)
      } else {
        assert.match(outcome.markdown, /Anna Reviewer/)
      }
    }
  })
})

test('a private note is in neither rendering', async () => {
  await inWorld(async () => {
    await note(ANNA, 'ANNA PRIVATE WORDS', { visibility: 'private' })
    await note(ANNA, 'ANNA SHARED WORDS')

    const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK] }, GENERATED)
    assert.ok(outcome.ok)
    if (!outcome.ok) return
    assert.ok(!outcome.json.includes('ANNA PRIVATE WORDS'))
    assert.ok(!outcome.markdown.includes('ANNA PRIVATE WORDS'))
    assert.ok(outcome.json.includes('ANNA SHARED WORDS'))
  })
})

/* ----------------------------------------------------------------- refusal */

test('a reviewer cannot export at all', async () => {
  await inWorld(async () => {
    const outcome = await exportAuthorFeedback(ANNA, { bookSlugs: [BOOK] }, GENERATED)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false ? outcome.reason : null, 'forbidden')
  })
})

test('one unreadable source refuses the whole export and stamps nothing', async () => {
  await inWorld(async (harness) => {
    const written = await note(ANNA, 'STILL SHARED')

    const prefix = join(harness.dir, 'reading', 'reading', 'v1', 'reviewer', 'anna', BOOK)
    mkdirSync(prefix, { recursive: true })
    writeFileSync(join(prefix, 'annotations'), 'not a directory', 'utf8')

    const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK] }, GENERATED)
    assert.equal(outcome.ok, false, 'a partial packet was returned as a complete one')
    assert.equal(outcome.ok === false ? outcome.reason : null, 'incomplete-source')

    // A refusal records nothing at all -- not a partial stamp, not a marker.
    const metadata = await loadAuthorMetadata(MIKE, BOOK, LATER)
    assert.ok(metadata.ok)
    if (!metadata.ok) return
    assert.equal(itemMetadata(metadata.value.metadata, `note:${written.id}`).lastExportedAt, null)
    assert.equal(metadata.value.version, null, 'a refused export created a metadata document')
  })
})

test('unreadable metadata refuses the export as well', async () => {
  await inWorld(async (harness) => {
    await note(ANNA, 'SHARED')

    // Bytes at the metadata pathname that are not a metadata document.
    const prefix = join(harness.dir, 'reading', 'author-meta', 'v1', MIKE.id)
    mkdirSync(prefix, { recursive: true })
    writeFileSync(join(prefix, `${BOOK}.json`), '{ "schema": 9 }', 'utf8')

    const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK] }, GENERATED)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false ? outcome.reason : null, 'metadata-unreadable')
  })
})

/* ---------------------------------------------------------------- stamping */

test('a successful export stamps every item it contained, and nothing else', async () => {
  await inWorld(async () => {
    const included = await note(ANNA, 'IN THE PACKET')
    const privateOne = await note(ANNA, 'NOT IN THE PACKET', { visibility: 'private' })

    const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK] }, GENERATED)
    assert.ok(outcome.ok)
    if (!outcome.ok) return
    assert.equal(outcome.stamped, 'recorded')
    assert.deepEqual(outcome.itemIds, [`note:${included.id}`])

    const metadata = await loadAuthorMetadata(MIKE, BOOK, LATER)
    assert.ok(metadata.ok)
    if (!metadata.ok) return
    const entry = itemMetadata(metadata.value.metadata, `note:${included.id}`)
    assert.equal(entry.lastExportedAt, GENERATED)
    // And it changed neither of the other two states.
    assert.equal(entry.lastReadAt, null, 'exporting marked something read')
    assert.equal(entry.resolved, false, 'exporting resolved something')
    assert.equal(
      itemMetadata(metadata.value.metadata, `note:${privateOne.id}`).lastExportedAt,
      null,
      'a note that was not in the packet was stamped',
    )
  })
})

test('exporting alters no reviewer-owned bytes', async () => {
  await inWorld(async (harness) => {
    await note(ANNA, 'HERS, UNCHANGED')

    const { readdirSync, readFileSync, existsSync } = await import('node:fs')
    const walk = (dir: string): Map<string, string> => {
      const out = new Map<string, string>()
      if (!existsSync(dir)) return out
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full).forEach((value, key) => out.set(key, value))
        else out.set(full, readFileSync(full, 'utf8'))
      }
      return out
    }

    const notesRoot = join(harness.dir, 'reading', 'notes')
    const before = walk(notesRoot)
    assert.ok(before.size > 0, 'there was nothing to compare')

    const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK] }, GENERATED)
    assert.ok(outcome.ok)

    assert.deepEqual(walk(notesRoot), before, 'an export rewrote a reviewer-owned object')
  })
})

/* ------------------------------------------------------------ no model, ever */

test('the export path reaches no model, key, prompt or background job', async () => {
  const { readFileSync } = await import('node:fs')
  const sources = [
    'lib/author-export.ts',
    'lib/author-feedback-source.ts',
    'lib/author-metadata.ts',
    'lib/withdrawal-events.ts',
  ].map((path) => readFileSync(join(process.cwd(), path), 'utf8'))

  for (const source of sources) {
    for (const forbidden of [
      'GEMINI',
      'generativelanguage',
      'OPENAI',
      'ANTHROPIC',
      'fetch(',
      'https://',
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `"${forbidden}" appears on the export path -- the packet must stand alone`,
      )
    }
  }
})

test('the export is not the raw Blob migration utility', async () => {
  // `scripts/export-feedback.mjs` is the retired comment store's migration
  // script. Nothing here calls it, imports it, or shares a name with it.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(join(process.cwd(), 'lib', 'author-export.ts'), 'utf8')
  assert.ok(!source.includes("from './'"))
  assert.ok(!/import .*export-feedback/.test(source))
  assert.ok(!/require\(.*export-feedback/.test(source))
})

test('the source module never writes to the store either', async () => {
  await inWorld(async (harness) => {
    await note(ANNA, 'READ ONLY')

    const { readdirSync, readFileSync, existsSync } = await import('node:fs')
    const walk = (dir: string): Map<string, string> => {
      const out = new Map<string, string>()
      if (!existsSync(dir)) return out
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full).forEach((value, key) => out.set(key, value))
        else out.set(full, readFileSync(full, 'utf8'))
      }
      return out
    }

    const before = walk(harness.dir)
    for (let i = 0; i < 3; i += 1) await loadAuthorFeedbackSource(MIKE, [BOOK])
    assert.deepEqual(walk(harness.dir), before, 'building the source wrote to the store')
  })
})

/* ------------------------------------- books, metadata identity and stamps */

/*
 * Two books in one packet, and the questions that only appear once there are
 * two: whose metadata document decides an item's triage, which document a stamp
 * lands in, and whether `books` still describes the items.
 *
 * `persistent` is author-only, so Mike's own note is the honest way to put a
 * real, owned item on it. That is also the exact shape of the reproduction the
 * finding rests on: a genuine item on one book, a metadata entry written under
 * another, and an export of both.
 */
const OTHER_BOOK = 'persistent'

/** Mike's own metadata document for a book. */
async function documentFor(bookSlug: string) {
  const read = await loadAuthorMetadata(MIKE, bookSlug, LATER)
  assert.ok(read.ok, `metadata for ${bookSlug} was unreadable`)
  return read.ok ? read.value.metadata : null
}

test('a metadata entry stored under one book is inert for another book’s item', async () => {
  await inWorld(async () => {
    await note(ANNA, 'ON THE FIRST BOOK')
    const elsewhere = await note(MIKE, 'ON THE SECOND BOOK', {
      bookSlug: OTHER_BOOK,
      visibility: 'private',
    })
    const itemId = `note:${elsewhere.id}`

    // The cross-book write: a real item id from the second book, stored beneath
    // the first book's document. The operation is the author's own and is not
    // refused -- what must not happen is that it decides anything.
    const written = await setItemResolved(MIKE, BOOK, itemId, true, GENERATED)
    assert.equal(written.ok, true, 'the metadata write itself was expected to be accepted')

    const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK, OTHER_BOOK] }, GENERATED)
    assert.ok(outcome.ok)
    if (!outcome.ok) return

    const item = outcome.packet.items.find((row) => row.itemId === itemId)
    assert.ok(item, 'the second book’s own item is missing from the packet')
    assert.equal(item.bookSlug, OTHER_BOOK)
    assert.equal(
      item.resolved,
      false,
      'an entry stored under another book decided this item’s triage',
    )

    // And the entry is inert rather than the mechanism being broken: written
    // under the item's own book, the same call does decide it.
    assert.equal((await setItemResolved(MIKE, OTHER_BOOK, itemId, true, LATER)).ok, true)
    const again = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK, OTHER_BOOK] }, LATER)
    assert.ok(again.ok)
    if (!again.ok) return
    assert.equal(
      again.packet.items.find((row) => row.itemId === itemId)?.resolved,
      true,
      'an entry under the item’s own book did not decide it either',
    )
  })
})

test('every packet item’s book is named, and every stamp lands in its own book', async () => {
  await inWorld(async () => {
    await note(ANNA, 'ON THE FIRST BOOK')
    await note(MIKE, 'ON THE SECOND BOOK', { bookSlug: OTHER_BOOK, visibility: 'private' })

    const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK, OTHER_BOOK] }, GENERATED)
    assert.ok(outcome.ok)
    if (!outcome.ok) return

    const named = outcome.packet.books.map((book) => book.slug)
    assert.deepEqual(named, [BOOK, OTHER_BOOK])
    for (const item of outcome.packet.items) {
      assert.ok(named.includes(item.bookSlug), `${item.itemId} belongs to an unnamed book`)
    }
    assert.ok(outcome.packet.items.length >= 2, 'the two-book fixture produced one book of items')

    /*
     * `recorded` is a claim about the whole packet, so it is checked against the
     * stored documents rather than against the flag: every item stamped, in the
     * document for its own book, and in no other book's document.
     */
    assert.equal(outcome.stamped, 'recorded')
    const documents = new Map<string, Awaited<ReturnType<typeof documentFor>>>()
    for (const slug of named) documents.set(slug, await documentFor(slug))

    for (const item of outcome.packet.items) {
      assert.equal(
        documents.get(item.bookSlug)?.items[item.itemId]?.lastExportedAt,
        GENERATED,
        `${item.itemId} was reported stamped but its own book has no stamp for it`,
      )
      for (const [slug, document] of Array.from(documents.entries())) {
        if (slug === item.bookSlug) continue
        assert.equal(
          document?.items[item.itemId],
          undefined,
          `${item.itemId} was stamped into ${slug}, which is not its book`,
        )
      }
    }
  })
})

test('a stamp that could not land for one book is not reported as recorded', async () => {
  await inWorld(async (harness) => {
    await note(ANNA, 'ON THE FIRST BOOK')
    await note(MIKE, 'ON THE SECOND BOOK', { bookSlug: OTHER_BOOK, visibility: 'private' })

    /*
     * The second book's document is already at its item cap, so the stamp write
     * for that book is refused while the first book's lands. A partial stamp is
     * exactly the case in which "recorded" would be a lie about some of the
     * items in a packet that was otherwise produced correctly.
     */
    const full: Record<string, unknown> = {}
    for (let i = 0; i < MAX_METADATA_ITEMS; i += 1) {
      full[`comment:filler-${i}`] = { resolved: false, lastReadAt: null, lastExportedAt: null }
    }
    const prefix = join(harness.dir, 'reading', 'author-meta', 'v1', MIKE.id)
    mkdirSync(prefix, { recursive: true })
    writeFileSync(
      join(prefix, `${OTHER_BOOK}.json`),
      JSON.stringify({
        schema: 1,
        bookSlug: OTHER_BOOK,
        items: full,
        views: [],
        updatedAt: GENERATED,
      }),
      'utf8',
    )

    const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK, OTHER_BOOK] }, GENERATED)
    assert.ok(outcome.ok, 'a bookkeeping failure must not discard the packet')
    if (!outcome.ok) return

    assert.equal(outcome.stamped, 'not-recorded')
    // The packet is still whole: the failure is about the record of the export,
    // never about what the export contained.
    assert.ok(outcome.packet.items.some((item) => item.bookSlug === OTHER_BOOK))
    assert.ok(outcome.packet.items.some((item) => item.bookSlug === BOOK))
  })
})

test('a requested book the manifest does not hold is reported, not silently dropped', async () => {
  await inWorld(async () => {
    await note(ANNA, 'ON THE FIRST BOOK')

    const outcome = await exportAuthorFeedback(
      MIKE,
      { bookSlugs: [BOOK, 'no-such-book'] },
      GENERATED,
    )
    assert.ok(outcome.ok)
    if (!outcome.ok) return

    assert.deepEqual(outcome.notFound, ['no-such-book'])
    assert.deepEqual(
      outcome.packet.books.map((book) => book.slug),
      [BOOK],
    )
    // Not in the packet's bytes: what was not found put nothing in the packet,
    // and the determinism surface stays the packet alone.
    assert.ok(!outcome.json.includes('no-such-book'))
    assert.ok(!outcome.markdown.includes('no-such-book'))

    const found = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK] }, GENERATED)
    assert.ok(found.ok)
    if (!found.ok) return
    assert.deepEqual(found.notFound, [], 'a found book was reported as missing')
  })
})

/*
 * The same item id under two books, one stamp refused.
 *
 * This is the case the coverage set has to be keyed for, and it is the one a
 * packet with different generated ids can never show: the public API mints a
 * UUID per note, so two books cannot be made to hold the same id through it.
 * The second note is therefore written as a whole, schema-valid note document at
 * the other book's own `notePath` through the same object layer the note store
 * uses -- its own book's note, with its own book's anchor, carrying the first
 * book's id. Nothing about the store, the source or the exporter is stubbed.
 *
 * Then the other book's metadata is filled to its item cap, so that book's stamp
 * write is refused while the first book's lands. One coordinate is stamped, one
 * is not, and the packet holds both.
 */
test('a stamp that landed for one book does not cover the same id under another', async () => {
  await inWorld(async (harness) => {
    const first = await note(MIKE, 'ON THE FIRST BOOK', { visibility: 'private' })
    const second = await note(MIKE, 'ON THE SECOND BOOK', {
      bookSlug: OTHER_BOOK,
      visibility: 'private',
    })

    const owner = { kind: 'author' as const, id: MIKE.id }
    const objects = createReadingObjects()
    const written = notePath(owner, OTHER_BOOK, second.id)
    const raw = await objects.get(written)
    assert.ok(raw, 'the second book’s note was not where the note store puts it')

    const document = JSON.parse(raw as string) as Record<string, unknown>
    document.id = first.id
    await objects.put(notePath(owner, OTHER_BOOK, first.id), `${JSON.stringify(document, null, 2)}\n`)
    await objects.del(written)

    const itemId = `note:${first.id}`

    // Fill the other book's document to its item cap, exactly as the ordinary
    // partial-stamp case above does, so that book's stamp write is refused.
    const full: Record<string, unknown> = {}
    for (let i = 0; i < MAX_METADATA_ITEMS; i += 1) {
      full[`comment:filler-${i}`] = { resolved: false, lastReadAt: null, lastExportedAt: null }
    }
    const prefix = join(harness.dir, 'reading', 'author-meta', 'v1', MIKE.id)
    mkdirSync(prefix, { recursive: true })
    writeFileSync(
      join(prefix, `${OTHER_BOOK}.json`),
      JSON.stringify({
        schema: 1,
        bookSlug: OTHER_BOOK,
        items: full,
        views: [],
        updatedAt: GENERATED,
      }),
      'utf8',
    )

    const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK, OTHER_BOOK] }, GENERATED)
    assert.ok(outcome.ok, 'a bookkeeping failure must not discard the packet')
    if (!outcome.ok) return

    // The fixture is only worth anything if the collision is really in the
    // packet: one id, two rows, two books.
    const rows = outcome.packet.items.filter((item) => item.itemId === itemId)
    assert.equal(rows.length, 2, 'the two books did not both hold the same item id')
    assert.deepEqual(
      rows.map((row) => row.bookSlug).sort(),
      [BOOK, OTHER_BOOK].sort(),
      'the same id was not held once under each book',
    )

    // Aggregate: one of the two coordinates carries no stamp, so the packet is
    // not recorded. Keyed by the bare id, the landed write answered for both.
    assert.equal(
      outcome.stamped,
      'not-recorded',
      'a stamp that landed for one book was credited to the same id under another',
    )

    // And the stores agree with that, coordinate by coordinate.
    assert.equal(
      (await documentFor(BOOK))?.items[itemId]?.lastExportedAt,
      GENERATED,
      'the book whose write landed carries no stamp',
    )
    assert.equal(
      (await documentFor(OTHER_BOOK))?.items[itemId],
      undefined,
      'the book whose write was refused carries a stamp anyway',
    )
  })
})

/*
 * The same four stored-document counterexamples, at the export boundary.
 *
 * `lib/author-metadata.ts` proves each one is `unreadable`; what matters here is
 * the consequence: a packet states Mike's triage, so a book whose triage cannot
 * be read refuses the whole export and records nothing at all. "Nothing at all"
 * is checked by bytes -- the other book's document is compared before and after,
 * because a refusal that stamped the readable book would be the partial record
 * this ordering exists to prevent.
 */
test('a stored metadata document past any declared bound refuses the export and stamps nothing', async () => {
  const view = {
    id: 'new-notes',
    name: 'New notes',
    books: [BOOK],
    kinds: ['note'],
    scopes: ['passage'],
    state: 'new',
  }
  const slugs = (count: number) => Array.from({ length: count }, (_, i) => `book-${i}`)
  const filler = (count: number) => {
    const items: Record<string, unknown> = {}
    for (let i = 0; i < count; i += 1) {
      items[`comment:filler-${i}`] = { resolved: false, lastReadAt: null, lastExportedAt: null }
    }
    return items
  }

  const stored: [string, Record<string, unknown>][] = [
    ['a malformed saved view', { views: [view, { ...view, id: 'broken', state: 'whatever' }] }],
    ['an over-cap view filter', { views: [{ ...view, books: slugs(MAX_VIEW_BOOKS + 1) }] }],
    ['one saved view past the cap', {
      views: Array.from({ length: MAX_SAVED_VIEWS + 1 }, (_, i) => ({ ...view, id: `view-${i}` })),
    }],
    ['one item past the cap', { items: filler(MAX_METADATA_ITEMS + 1) }],
  ]

  for (const [what, over] of stored) {
    await inWorld(async (harness) => {
      await note(ANNA, 'ON THE FIRST BOOK')
      await note(MIKE, 'ON THE SECOND BOOK', { bookSlug: OTHER_BOOK, visibility: 'private' })

      const prefix = join(harness.dir, 'reading', 'author-meta', 'v1', MIKE.id)
      mkdirSync(prefix, { recursive: true })
      const document = JSON.stringify({
        schema: 1,
        bookSlug: BOOK,
        items: {},
        views: [],
        updatedAt: GENERATED,
        ...over,
      })
      writeFileSync(join(prefix, `${BOOK}.json`), document, 'utf8')

      const outcome = await exportAuthorFeedback(MIKE, { bookSlugs: [BOOK, OTHER_BOOK] }, GENERATED)
      assert.equal(outcome.ok, false, `${what} produced a packet`)
      assert.equal(
        outcome.ok === false ? outcome.reason : null,
        'metadata-unreadable',
        `${what} was not reported as an unreadable metadata document`,
      )
      assert.deepEqual(
        outcome.ok === false ? outcome.failures : null,
        [{ source: 'author-metadata', bookSlug: BOOK }],
        `${what} named the wrong book`,
      )

      // Nothing was recorded: the refused book's bytes are untouched, and the
      // other book -- which reads perfectly well -- has no document at all.
      assert.equal(readFileSync(join(prefix, `${BOOK}.json`), 'utf8'), document, `${what} rewrote`)
      assert.equal(
        existsSync(join(prefix, `${OTHER_BOOK}.json`)),
        false,
        `${what} stamped the readable book anyway`,
      )
    })
  }
})
