import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/*
 * The composer's words and defaults.
 *
 * These are the decisions a reader actually meets: what the two visibility
 * choices say, which one the composer opens on, whether either is presented as
 * the cautious one, and whether Mike is ever shown a control for sharing a note
 * with himself. They live in a pure module precisely so they can be asserted --
 * the composer itself renders inside a sheet that is closed until somebody
 * opens it, so none of this appears in a server render.
 */

import {
  AUTHOR_PRIVACY_LINE,
  NOTE_LINK_LABEL,
  REVIEWER_VISIBILITY_CHOICES,
  SCOPE_LABELS,
  composerTitle,
  defaultVisibilityFor,
  noteLinkHint,
  noteLinkPath,
  removeLabel,
  saveLabel,
  scopesFor,
  visibilityChoicesFor,
  visibilityLabel,
} from '../components/reader/note-composer.ts'

test('a reviewer is offered exactly two choices, and both say what happens', () => {
  const choices = visibilityChoicesFor('reviewer')
  assert.equal(choices.length, 2, 'two states, and there is no third')

  assert.deepEqual(
    choices.map((choice) => choice.value),
    ['shared', 'private'],
  )
  assert.equal(choices[0].label, 'Share with Mike')
  assert.equal(choices[1].label, 'Only me')

  for (const choice of choices) {
    // A consequence, not a restatement of the label.
    assert.ok(choice.hint.length > choice.label.length)
    assert.match(choice.hint, /Mike/)
  }

  // Neither is dressed as a warning. The old wording paired "Share" against
  // "Private", which reads as the safe option beside a risky one.
  for (const choice of choices) {
    assert.doesNotMatch(choice.hint, /careful|warning|cannot be undone|permanent/i)
  }
})

test('the composer opens on sharing with Mike, for a reviewer', () => {
  assert.equal(defaultVisibilityFor('reviewer'), 'shared')
})

test('the composer opens private for the author, and offers him no choice at all', () => {
  assert.equal(defaultVisibilityFor('author'), 'private')
  assert.deepEqual([...visibilityChoicesFor('author')], [])
})

test('the author is never shown a "Share with Mike" control anywhere', () => {
  // Not among his choices, because he has none...
  for (const choice of visibilityChoicesFor('author')) {
    assert.doesNotMatch(choice.label, /Share with Mike/)
  }
  // ...and not in the line he is shown instead, which states a fact rather than
  // offering something that does not exist.
  assert.doesNotMatch(AUTHOR_PRIVACY_LINE, /Share with Mike/)
  assert.doesNotMatch(AUTHOR_PRIVACY_LINE, /Only me/)
  assert.match(AUTHOR_PRIVACY_LINE, /Private to you/)
  assert.match(AUTHOR_PRIVACY_LINE, /never shown to them/)
})

test('a reviewer is offered three scopes; the author is offered the book as well', () => {
  assert.deepEqual([...scopesFor('reviewer')], ['passage', 'paragraph', 'chapter'])
  assert.deepEqual([...scopesFor('author')], ['passage', 'paragraph', 'chapter', 'book'])
  assert.ok(!scopesFor('reviewer').includes('book'))
})

test('every scope a composer can offer has a name a reader would use', () => {
  for (const voice of ['reviewer', 'author'] as const) {
    for (const scope of scopesFor(voice)) {
      assert.ok(SCOPE_LABELS[scope], scope)
      assert.doesNotMatch(SCOPE_LABELS[scope], /scope|anchor/i)
    }
  }
})

test('there is one save, and it says which of the two things it is doing', () => {
  assert.equal(saveLabel(false), 'Save note')
  assert.equal(saveLabel(true), 'Save changes')
  assert.equal(composerTitle(false), 'Write a note')
  assert.equal(composerTitle(true), 'Edit your note')

  // The retired model's control is gone from the vocabulary entirely.
  for (const word of [saveLabel(false), saveLabel(true), composerTitle(false)]) {
    assert.doesNotMatch(word, /^Send$/)
    assert.doesNotMatch(word, /Submit/)
    assert.doesNotMatch(word, /Comment/)
  }
})

test('a written note says who can read it, in each voice', () => {
  assert.equal(visibilityLabel('reviewer', 'shared'), 'shared with Mike')
  assert.equal(visibilityLabel('reviewer', 'private'), 'only you')
  // Mike's own notes never say "shared", whatever is passed.
  assert.equal(visibilityLabel('author', 'private'), 'private to you')
  assert.equal(visibilityLabel('author', 'shared'), 'private to you')
})

test('taking back a shared note is called retracting; everything else is deleting', () => {
  assert.equal(removeLabel('reviewer', 'shared'), 'Retract')
  assert.equal(removeLabel('reviewer', 'private'), 'Delete')
  assert.equal(removeLabel('author', 'private'), 'Delete')
  assert.equal(removeLabel('author', 'shared'), 'Delete')
})

test('REVIEWER_VISIBILITY_CHOICES is what the reviewer voice serves', () => {
  assert.deepEqual(visibilityChoicesFor('reviewer'), REVIEWER_VISIBILITY_CHOICES)
})

/* ------------------------------------------------------- the private link */

test('the private link is not one of the composer’s choices', () => {
  /*
   * The correction this asserts: "Private link" is an action on a note that has
   * already been saved, and never a third thing to pick while writing one. If
   * it ever becomes a visibility choice, it becomes a third state of who can
   * read a note -- and there are two.
   */
  for (const voice of ['reviewer', 'author'] as const) {
    for (const choice of visibilityChoicesFor(voice)) {
      assert.notEqual(choice.value as string, 'link')
      assert.notEqual(choice.label, NOTE_LINK_LABEL)
      assert.ok(!choice.label.toLowerCase().includes('link'), choice.label)
      assert.ok(!choice.hint.toLowerCase().includes('link'), choice.hint)
    }
  }

  // And the composer's own words never offer one either.
  assert.ok(!AUTHOR_PRIVACY_LINE.toLowerCase().includes('link'))
  for (const label of Object.values(SCOPE_LABELS)) {
    assert.ok(!label.toLowerCase().includes('link'))
  }
  assert.ok(!saveLabel(false).toLowerCase().includes('link'))
  assert.ok(!saveLabel(true).toLowerCase().includes('link'))
  assert.ok(!composerTitle(false).toLowerCase().includes('link'))
  assert.ok(!composerTitle(true).toLowerCase().includes('link'))
})

test('the link is a locator: the book, the note, and nothing else', () => {
  assert.equal(
    noteLinkPath('reviewer', 'the-backward-becoming', 'abc-123'),
    '/review/note/the-backward-becoming/abc-123',
  )
  assert.equal(
    noteLinkPath('author', 'the-backward-becoming', 'abc-123'),
    '/admin/note/the-backward-becoming/abc-123',
  )

  /*
   * Nothing about the note travels in its address. Deliberately asserted
   * against a note whose body *is* the sort of thing that must not leak, so a
   * future change that helpfully appends a title, a quotation or a token has to
   * fail here rather than in production.
   */
  const path = noteLinkPath('reviewer', 'the-backward-becoming', 'd290f1ee-6c54-4b01-90e6-d701748f0851')
  assert.equal(path.split('/').length, 5, 'two segments after /review/note, and no more')
  assert.ok(!path.includes('?'), 'no query string to hide anything in')
  assert.ok(!path.includes('#'), 'no fragment either')
  assert.match(path, /^\/review\/note\/[^/]+\/[^/]+$/)
})

test('a note id is escaped rather than allowed to widen the path', () => {
  const path = noteLinkPath('reviewer', 'a-book', '../../admin/read')
  assert.ok(!path.includes('../'), path)
  assert.equal(path, '/review/note/a-book/..%2F..%2Fadmin%2Fread')
})

test('the link says, in every voice, that it is not a way in', () => {
  const hints = [
    noteLinkHint('reviewer', 'shared'),
    noteLinkHint('reviewer', 'private'),
    noteLinkHint('author', 'private'),
  ]
  for (const hint of hints) {
    assert.ok(hint.length > 0)
    // It never claims to grant anything, and never calls itself sharing.
    assert.ok(!/shares?/i.test(hint), hint)
  }
  assert.match(noteLinkHint('reviewer', 'private'), /only you can open it/)
  assert.match(noteLinkHint('author', 'private'), /not a way to let anyone else read it/)
})

/* --------------------------------------------- where the control is rendered */

/*
 * "Private link" must be an action on a **saved** note and never appear in the
 * composer. That is a placement rule, and placement is the one thing about this
 * reader a rendered page cannot settle: both the composer and a note's actions
 * live inside sheets and disclosures that return `null` until somebody opens
 * them, so neither is in any server render to assert against, and no request
 * can put either there.
 *
 * So it is asserted where it is actually decided -- in the source -- rather
 * than being left unchecked because the convenient place to check it does not
 * exist. The reader is read as text and three things are required of it: the
 * control is rendered in exactly one place, that place is guarded by a saved
 * note's identifier, and the composer's own markup does not mention it at all.
 */

const READER = readFileSync(
  new URL('../app/review/[book]/[chapter]/ChapterReader.tsx', import.meta.url),
  'utf8',
)

/** The composer's markup: its sheet, from its opening tag to that tag's close. */
function composerMarkup(source: string): string {
  const start = source.indexOf("open={sheet === 'note'}")
  assert.ok(start > 0, 'the composer sheet was not found -- this test needs rewriting')
  const end = source.indexOf('</Sheet>', start)
  assert.ok(end > start)
  return source.slice(start, end)
}

test('the private link is rendered once, on a saved note, and never in the composer', () => {
  // Exactly one place renders it.
  assert.equal(
    READER.split('<NoteLink').length - 1,
    1,
    'the private link is rendered in more than one place',
  )

  // And that place is guarded by the identifier of a note that already exists.
  assert.ok(
    READER.includes('{noteLinkFor === note.id ? <NoteLink voice={voice} note={note} /> : null}'),
    'the private link is not guarded by a saved note’s identifier',
  )

  // The composer says nothing about it: not the control, not the label.
  const composer = composerMarkup(READER)
  assert.ok(!composer.includes('NoteLink'), 'the composer renders the private link')
  assert.ok(!composer.includes('NOTE_LINK_LABEL'), 'the composer offers the private link')
  assert.ok(
    !composer.toLowerCase().includes('private link'),
    'the composer mentions the private link',
  )
})

test('the control that opens the link sits among a saved note’s actions', () => {
  const label = READER.indexOf('{NOTE_LINK_LABEL}')
  assert.ok(label > 0, 'the private link control was not found')

  const actions = READER.indexOf('className="rv-mark-actions"')
  const composer = READER.indexOf("open={sheet === 'note'}")
  assert.ok(actions > 0 && composer > 0)

  assert.ok(label > actions, 'the control is not inside a saved note’s action row')
  assert.ok(label < composer, 'the control is inside the composer')

  // One control, one place.
  assert.equal(READER.split('{NOTE_LINK_LABEL}').length - 1, 1)
})

/* ------------------------------------------ what a save that loses does next */

/*
 * `docs/author-reader.md` promises two things about a save that loses a race,
 * and both are decided inside the reader: a conflicted save keeps the composer
 * open with the typed words still in it, and a conflicted one-tap change is
 * reported once and never retried against a revision nobody rendered.
 *
 * Those promises are no longer asserted here, because they are no longer
 * decided here. The order they describe -- one request, then report or accept,
 * and only then end the edit -- now lives in `components/reader/note-write.ts`,
 * and `tests/note-write.test.ts` runs it against a fake transport and counts
 * what happened. That is a proof about behaviour. What stood here before was a
 * proof about text: three tests that extracted a region of this file by
 * counting braces and asserted on the shape of what they found.
 *
 * Three tests were retired with that mechanism, along with `blockAfter` and the
 * `DISCARDS_THE_DRAFT` vocabulary they iterated:
 *
 *   - "a save that failed says so, and leaves the typed words where they are"
 *   - "the sheet closes and the draft clears only when the save succeeded"
 *   - "a conflicted visibility change is one attempt, reported, and never sent
 *     again"
 *
 * Each is now covered behaviourally, and better: the first two by the helper's
 * `finished` never running on a failure, the third by its single `send` call
 * and its untouched arguments.
 *
 * ## What is left here, and why it is here rather than there
 *
 * A helper test proves what the helper does when it is called. It cannot prove
 * that the component calls it -- or that the component does not also reach the
 * transport directly, or adjust the revision on the way past. That is a
 * question about this file's source, so it is still asked of this file's
 * source, but as whole-file counts rather than extracted regions. A count over
 * the whole file has no region to fall outside of, which was the failure mode
 * of the three tests above.
 *
 * ## What these guards do not reach
 *
 * They are literal string and regular-expression searches, and they are honest
 * about being that:
 *
 *   - Guard 1 is a substring test. `const send = updateNoteRecord` followed by
 *     `send(...)`, or `(updateNoteRecord)(...)`, contains neither forbidden
 *     literal and would pass.
 *   - Guard 2 counts occurrences of the text `writeNoteOnce(`, not calls
 *     executed. A loop around one call site sends twice and leaves the count
 *     unchanged.
 *   - None of them reaches what the component does inside its own `report`,
 *     `accepted` or `finished` callbacks. A `finished` body that discarded the
 *     draft on a failure cannot be written -- the helper never calls it -- but a
 *     `report` body that discarded the draft could be, and nothing here or in
 *     `tests/note-write.test.ts` would see it.
 *
 * Those limits are unchanged, and they are still real: these five guards check
 * text, and text is not behaviour. What has changed is that they are no longer
 * the last line. `tests/reader-note-save.test.tsx` mounts this component in a
 * DOM and drives its composer, and it is where the classes above are actually
 * closed: a second request is counted rather than inferred from an occurrence
 * count, and what the component does inside its own callbacks is read off the
 * screen. **These remain regression tripwires and are not proof of anything.**
 * They are kept because a tripwire that fires the moment somebody reaches the
 * transport directly, or adjusts a revision, is cheap and immediate -- but the
 * proof is next door.
 */

test('the reader reaches the note transports only through writeNoteOnce', () => {
  // Guard 1. The transport names still appear -- they are imported, and passed
  // by name into the helper -- but nothing calls them here. Baseline before the
  // helper existed: `updateNoteRecord(` 3, `saveNote(` 1.
  assert.equal(
    READER.split('updateNoteRecord(').length - 1,
    0,
    'the reader calls updateNoteRecord directly, outside the one-write helper',
  )
  assert.equal(
    READER.split('saveNote(').length - 1,
    0,
    'the reader calls saveNote directly, outside the one-write helper',
  )
})

test('there are exactly four note writes in the reader', () => {
  // Guard 2. The composer's update branch and its create branch (which cannot
  // collapse into one call: the two transports take incompatible arguments),
  // the visibility change, and the status change. A fifth would be a write
  // nobody has accounted for.
  assert.equal(
    READER.split('writeNoteOnce(').length - 1,
    4,
    'the number of note writes in the reader has changed',
  )
})

test('no revision is adjusted before it is sent', () => {
  // Guard 3. A guessed revision is how a note narrowed on another device gets
  // re-widened, and it is the one class this whole correction exists to close.
  // Case-insensitive and without a word boundary on purpose: it has to catch
  // `note.revision + 1` at a call site, `expectedRevision + 1` inside a
  // handler, and `editedRevision+1` in the composer. Baseline: 0 matches.
  assert.doesNotMatch(
    READER,
    /revision\s*[-+*\/]/i,
    'a revision is arithmetically adjusted somewhere in the reader',
  )
})

test('every write is still serialised by the busy guard', () => {
  // Guard 4. `if (busy) return` is what stops a second write starting inside
  // one tab while the first is in flight. Removing one is invisible to a helper
  // test, because the helper never sees the guard that precedes it.
  assert.equal(
    READER.split('if (busy').length - 1,
    9,
    'the number of busy guards in the reader has changed',
  )
})

test('no note handler can call itself again', () => {
  // Guard 5. One occurrence each: the single place the reader invokes it. A
  // second would be a retry however it is spelled -- including the handler
  // calling itself from its own failure path.
  for (const handler of ['submitComposer(', 'changeNoteVisibility(', 'changeNoteStatus(']) {
    assert.equal(
      READER.split(handler).length - 1,
      1,
      `${handler.slice(0, -1)} is invoked more than once -- a second call is a retry`,
    )
  }
})
