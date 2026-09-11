import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FeedbackStorageUnavailableError,
  MAX_COMMENT_LENGTH,
  __resetFeedbackStore,
  commentDigest,
  createFeedbackStore,
  normalizeComment,
  type FeedbackDraft,
} from '../lib/reviewer-feedback.ts'

function draft(overrides: Partial<FeedbackDraft> = {}): FeedbackDraft {
  return {
    reviewerId: 'anna',
    bookSlug: 'the-backward-becoming',
    chapterSlug: 'chapter-one',
    chapterNumber: 1,
    scope: 'paragraph',
    paragraphId: 'chapter-one-p012',
    paragraphOrdinal: 12,
    quote: 'The exact passage, copied from the manuscript.',
    comment: 'This line is the one that landed.',
    ...overrides,
  }
}

function withStore<T>(
  env: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  __resetFeedbackStore()

  return run().finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    __resetFeedbackStore()
  })
}

/* ---------------------------------------------------------- validation */

test('a comment is normalised, and an empty one is refused', () => {
  assert.equal(normalizeComment('  hello  '), 'hello')
  assert.equal(normalizeComment('a\r\nb'), 'a\nb')
  assert.equal(normalizeComment('a\n\n\n\n\nb'), 'a\n\nb')
  assert.equal(normalizeComment(''), null)
  assert.equal(normalizeComment('   \n  '), null)
  assert.equal(normalizeComment(null), null)
  assert.equal(normalizeComment(42), null)
})

test('an over-length comment is refused rather than silently truncated', () => {
  assert.equal(normalizeComment('x'.repeat(MAX_COMMENT_LENGTH)), 'x'.repeat(MAX_COMMENT_LENGTH))
  assert.equal(normalizeComment('x'.repeat(MAX_COMMENT_LENGTH + 1)), null)
})

test('a comment digest is short, stable, and not the comment', () => {
  const text = 'something candid'
  const digest = commentDigest(text)
  assert.equal(digest.length, 12)
  assert.equal(digest, commentDigest(text))
  assert.notEqual(digest, commentDigest(`${text}.`))
  assert.ok(!digest.includes('candid'))
})

/* ------------------------------------------------- unconfigured driver */

test('with no driver configured, a write is refused loudly', async () => {
  await withStore({ REVIEWER_FEEDBACK_DRIVER: undefined }, async () => {
    const store = createFeedbackStore()
    assert.equal(store.driver, 'unconfigured')
    assert.equal(store.durable, false)

    await assert.rejects(
      () => store.add(draft()),
      (error: unknown) => error instanceof FeedbackStorageUnavailableError,
    )
  })
})

test('an unrecognised driver name fails closed rather than guessing', async () => {
  await withStore({ REVIEWER_FEEDBACK_DRIVER: 'postgres' }, async () => {
    assert.equal(createFeedbackStore().driver, 'unconfigured')
  })
})

test('the fs driver refuses to start without a directory', async () => {
  await withStore(
    { REVIEWER_FEEDBACK_DRIVER: 'fs', REVIEWER_FEEDBACK_DIR: undefined },
    async () => {
      assert.throws(() => createFeedbackStore(), /requires REVIEWER_FEEDBACK_DIR/)
    },
  )
})

/* ---------------------------------------------------------- fs driver */

test('the fs driver stores a row and reads it back with full attribution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-feedback-'))
  try {
    await withStore(
      { REVIEWER_FEEDBACK_DRIVER: 'fs', REVIEWER_FEEDBACK_DIR: dir },
      async () => {
        const store = createFeedbackStore()
        assert.equal(store.driver, 'fs')
        assert.equal(store.durable, true)

        const entry = await store.add(draft())

        assert.equal(entry.schema, 1)
        assert.ok(entry.id)
        assert.ok(!Number.isNaN(Date.parse(entry.createdAt)))
        assert.equal(entry.reviewerId, 'anna')
        assert.equal(entry.bookSlug, 'the-backward-becoming')
        assert.equal(entry.chapterSlug, 'chapter-one')
        assert.equal(entry.chapterNumber, 1)
        assert.equal(entry.scope, 'paragraph')
        assert.equal(entry.paragraphId, 'chapter-one-p012')
        assert.equal(entry.paragraphOrdinal, 12)
        assert.equal(entry.quote, 'The exact passage, copied from the manuscript.')
        assert.equal(entry.comment, 'This line is the one that landed.')

        const back = await store.listForReviewer('anna', 'the-backward-becoming')
        assert.equal(back.length, 1)
        assert.deepEqual(back[0], entry)
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rows survive a new store instance -- the write is actually durable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-feedback-'))
  try {
    await withStore(
      { REVIEWER_FEEDBACK_DRIVER: 'fs', REVIEWER_FEEDBACK_DIR: dir },
      async () => {
        await createFeedbackStore().add(draft({ comment: 'first' }))
      },
    )

    // A fresh process would build a fresh store; this is the same thing.
    await withStore(
      { REVIEWER_FEEDBACK_DRIVER: 'fs', REVIEWER_FEEDBACK_DIR: dir },
      async () => {
        const rows = await createFeedbackStore().listForReviewer(
          'anna',
          'the-backward-becoming',
        )
        assert.equal(rows.length, 1)
        assert.equal(rows[0].comment, 'first')
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('chapter-scoped feedback is stored without a paragraph or a quote', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-feedback-'))
  try {
    await withStore(
      { REVIEWER_FEEDBACK_DRIVER: 'fs', REVIEWER_FEEDBACK_DIR: dir },
      async () => {
        const entry = await createFeedbackStore().add(
          draft({ scope: 'chapter', paragraphId: null, paragraphOrdinal: null, quote: null }),
        )
        assert.equal(entry.scope, 'chapter')
        assert.equal(entry.paragraphId, null)
        assert.equal(entry.quote, null)
        assert.equal(entry.chapterSlug, 'chapter-one')
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('exact attribution is preserved across many rows and several chapters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-feedback-'))
  try {
    await withStore(
      { REVIEWER_FEEDBACK_DRIVER: 'fs', REVIEWER_FEEDBACK_DIR: dir },
      async () => {
        const store = createFeedbackStore()
        const expected = [
          { chapterSlug: 'chapter-one', paragraphId: 'chapter-one-p001', comment: 'one' },
          { chapterSlug: 'chapter-two', paragraphId: 'chapter-two-p045', comment: 'two' },
          { chapterSlug: 'chapter-four', paragraphId: 'chapter-four-p100', comment: 'four' },
        ]

        for (const item of expected) {
          await store.add(
            draft({
              chapterSlug: item.chapterSlug,
              paragraphId: item.paragraphId,
              comment: item.comment,
              quote: `quote for ${item.paragraphId}`,
            }),
          )
        }

        const rows = await store.listForReviewer('anna', 'the-backward-becoming')
        assert.equal(rows.length, 3)

        for (const item of expected) {
          const row = rows.find((candidate) => candidate.comment === item.comment)
          assert.ok(row, item.comment)
          assert.equal(row.chapterSlug, item.chapterSlug)
          assert.equal(row.paragraphId, item.paragraphId)
          assert.equal(row.quote, `quote for ${item.paragraphId}`)
        }
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* -------------------------------------------- cross-reviewer containment */

test("one reviewer never receives another reviewer's feedback", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-feedback-'))
  try {
    await withStore(
      { REVIEWER_FEEDBACK_DRIVER: 'fs', REVIEWER_FEEDBACK_DIR: dir },
      async () => {
        const store = createFeedbackStore()

        await store.add(draft({ reviewerId: 'anna', comment: "anna's private note" }))
        await store.add(draft({ reviewerId: 'ben', comment: "ben's private note" }))

        const annaRows = await store.listForReviewer('anna', 'the-backward-becoming')
        assert.equal(annaRows.length, 1)
        assert.equal(annaRows[0].comment, "anna's private note")

        const benRows = await store.listForReviewer('ben', 'the-backward-becoming')
        assert.equal(benRows.length, 1)
        assert.equal(benRows[0].comment, "ben's private note")

        // A reviewer who has written nothing sees nothing, not everything.
        assert.deepEqual(
          await store.listForReviewer('carol', 'the-backward-becoming'),
          [],
        )
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('feedback is scoped by book as well as by reviewer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-feedback-'))
  try {
    await withStore(
      { REVIEWER_FEEDBACK_DRIVER: 'fs', REVIEWER_FEEDBACK_DIR: dir },
      async () => {
        const store = createFeedbackStore()
        await store.add(draft({ bookSlug: 'the-backward-becoming', comment: 'about tbb' }))
        await store.add(draft({ bookSlug: 'another-book', comment: 'about another' }))

        const tbb = await store.listForReviewer('anna', 'the-backward-becoming')
        assert.equal(tbb.length, 1)
        assert.equal(tbb[0].comment, 'about tbb')

        // Separate books are separate files, so one cannot bleed into the other.
        const other = await store.listForReviewer('anna', 'another-book')
        assert.equal(other.length, 1)
        assert.equal(other[0].comment, 'about another')
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------- hardening */

test('a book slug cannot escape the storage directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-feedback-'))
  try {
    await withStore(
      { REVIEWER_FEEDBACK_DRIVER: 'fs', REVIEWER_FEEDBACK_DIR: dir },
      async () => {
        const store = createFeedbackStore()
        for (const bad of ['../escape', '..', 'a/b', 'C:\\windows', 'Upper']) {
          await assert.rejects(
            () => store.add(draft({ bookSlug: bad })),
            /invalid book slug/,
            bad,
          )
        }
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt line does not hide the rows around it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-feedback-'))
  try {
    await withStore(
      { REVIEWER_FEEDBACK_DRIVER: 'fs', REVIEWER_FEEDBACK_DIR: dir },
      async () => {
        const store = createFeedbackStore()
        await store.add(draft({ comment: 'before' }))

        const path = join(dir, 'the-backward-becoming.ndjson')
        const existing = readFileSync(path, 'utf8')
        const { writeFileSync } = await import('node:fs')
        writeFileSync(path, `${existing}{ not json\n`, 'utf8')

        await store.add(draft({ comment: 'after' }))

        const rows = await store.listForReviewer('anna', 'the-backward-becoming')
        assert.deepEqual(
          rows.map((row) => row.comment).sort(),
          ['after', 'before'],
        )
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('each stored row is one line of valid JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-feedback-'))
  try {
    await withStore(
      { REVIEWER_FEEDBACK_DRIVER: 'fs', REVIEWER_FEEDBACK_DIR: dir },
      async () => {
        const store = createFeedbackStore()
        // A comment containing newlines must not break the line-per-row format.
        await store.add(draft({ comment: 'line one\nline two\nline three' }))
        await store.add(draft({ comment: 'second row' }))

        const lines = readFileSync(join(dir, 'the-backward-becoming.ndjson'), 'utf8')
          .split('\n')
          .filter((line) => line.trim() !== '')

        assert.equal(lines.length, 2)
        for (const line of lines) {
          assert.doesNotThrow(() => JSON.parse(line))
        }
        assert.equal(JSON.parse(lines[0]).comment, 'line one\nline two\nline three')
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
