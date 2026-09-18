/**
 * The composer's words and defaults, in one place.
 *
 * The reader's composer lives inside a sheet that is closed until somebody
 * opens it, so its wording never appears in a server render and cannot be
 * asserted against a page. That is a bad reason for the wording to be
 * unexaminable: what the two visibility choices say, which one a composer opens
 * on, and whether the author is ever offered a sharing control at all are
 * exactly the decisions that most need to be checkable.
 *
 * So they live here -- pure, with no React and no imports -- and the component
 * renders them. `components/reader/reading-help.ts` is the same arrangement for
 * the same reason.
 *
 * ## The two voices
 *
 * A **reviewer** is writing to somebody. They get both choices, equally
 * weighted, each saying what actually happens rather than naming a setting, and
 * the composer opens on "Share with Mike" because that is what a reviewer is
 * here to do.
 *
 * The **author** is writing to himself. He gets no sharing control, because
 * there is no state in which one of his notes reaches a reviewer -- offering
 * him a "Share with Mike" segment would be offering something that does not
 * exist, and inviting him to wonder whether his marginalia are being read.
 */

export type ComposerVoice = 'reviewer' | 'author'

export type NoteVisibility = 'private' | 'shared'

export type NoteScope = 'passage' | 'paragraph' | 'chapter' | 'book'

export type VisibilityChoice = {
  value: NoteVisibility
  label: string
  /** The consequence, in plain language. Not a restatement of the label. */
  hint: string
}

/**
 * The reviewer's two choices, in the order they are offered.
 *
 * Neither is styled or worded as the cautious one. "Only me" used to be the
 * safe-looking option beside something called "Share", which reads as a warning
 * rather than as the ordinary thing an advance reader is here to do.
 */
export const REVIEWER_VISIBILITY_CHOICES: readonly VisibilityChoice[] = [
  {
    value: 'shared',
    label: 'Share with Mike',
    hint: 'Mike can read this note. You can change that or delete it at any time.',
  },
  {
    value: 'private',
    label: 'Only me',
    hint: 'Only you. Mike cannot read this, and it is not counted anywhere he can see.',
  },
]

/**
 * What the composer opens on, per voice.
 *
 * This is the **control's** default and nothing more. The server fails private
 * on anything it does not recognise, so a request that loses or garbles this
 * value is stored private -- the default lives here and the safety lives there.
 */
export function defaultVisibilityFor(voice: ComposerVoice): NoteVisibility {
  return voice === 'reviewer' ? 'shared' : 'private'
}

/** The sharing choices this voice is offered. The author is offered none. */
export function visibilityChoicesFor(voice: ComposerVoice): readonly VisibilityChoice[] {
  return voice === 'reviewer' ? REVIEWER_VISIBILITY_CHOICES : []
}

/**
 * What a reviewer is told before they write anything, in four sentences.
 *
 * ## Why it is here
 *
 * The composer is the last surface a reviewer sees before their words exist, so
 * it is the only place where "before you write this" is literally true. The
 * same four facts are also in the reading help, for somebody who comes looking
 * afterwards; this is the copy that is unavoidable.
 *
 * ## Why these four and not others
 *
 * Each is a consequence a reviewer cannot work out from the interface:
 *
 *   1. **A shared note can leave the portal.** Mike can export what was shared
 *      with him, and may later hand that export to a third-party AI service. A
 *      reviewer choosing "Share with Mike" is choosing that too, and nothing on
 *      the control said so.
 *   2. **A private note cannot.** It is not visible to Mike and is never in an
 *      export -- the fail-private default, stated rather than implied.
 *   3. **Retraction has a horizon.** It removes a note from this portal and from
 *      future exports. It cannot reach a copy already downloaded. Promising
 *      otherwise would be promising something no software can do.
 *   4. **Retraction is itself visible, and only just.** Taking back a *shared*
 *      note tells Mike that a note was withdrawn and when -- and nothing about
 *      what it said. Taking back a private one tells him nothing at all. Both
 *      halves are here, because "you can delete it" alone promises slightly
 *      more than the product does.
 *
 * ## What it deliberately is not
 *
 * Not a consent gate: there is no checkbox, nothing is stored about having read
 * it, no email is sent, and the composer is not blocked on it. It is
 * information, offered where it is useful, and a reviewer who ignores it is not
 * penalised. It also names no AI product -- "a third-party AI service" is the
 * whole of what is promised, and a brand name would be a commitment to a vendor
 * this copy has no business making.
 */
export const REVIEWER_SHARING_DISCLOSURE: readonly string[] = [
  'A note you share with Mike may be included in exports he controls, and those exports may later be processed by a third-party AI service at his direction.',
  'A note kept to “Only me” is not visible to Mike and is never included in one.',
  'Retracting a note removes it from this portal and from future exports. It cannot recall a copy Mike has already downloaded or moved elsewhere.',
  'Retracting a shared note tells Mike that a note was withdrawn and when — never what it said. Retracting a private note tells him nothing at all.',
]

/** The heading the disclosure sits under, wherever it is shown. */
export const REVIEWER_SHARING_DISCLOSURE_TITLE = 'Before you write'

/**
 * What the author is told instead of a control.
 *
 * A statement of fact, not a disabled option. There is nothing here to change,
 * so there is nothing here that looks changeable.
 */
export const AUTHOR_PRIVACY_LINE =
  'Private to you. Your notes are kept separately from your reviewers’ and are never shown to them.'

/** The scopes each voice's composer offers. */
export function scopesFor(voice: ComposerVoice): readonly NoteScope[] {
  return voice === 'reviewer'
    ? ['passage', 'paragraph', 'chapter']
    : ['passage', 'paragraph', 'chapter', 'book']
}

export const SCOPE_LABELS: Readonly<Record<NoteScope, string>> = {
  passage: 'Selected passage',
  paragraph: 'This paragraph',
  chapter: 'This chapter',
  book: 'The whole book',
}

/** The one save row's one button. There is no second save anywhere. */
export function saveLabel(editing: boolean): string {
  return editing ? 'Save changes' : 'Save note'
}

export function composerTitle(editing: boolean): string {
  return editing ? 'Edit your note' : 'Write a note'
}

/** How a note describes who can read it, once written, in each voice. */
export function visibilityLabel(voice: ComposerVoice, visibility: NoteVisibility): string {
  if (voice === 'author') return 'private to you'
  return visibility === 'shared' ? 'shared with Mike' : 'only you'
}

/**
 * What the delete control is called.
 *
 * A shared note is **retracted** rather than deleted, because that is what the
 * act is from the reviewer's side: taking back something somebody else has
 * already read. It is the same operation and leaves no hidden copy either way.
 */
export function removeLabel(voice: ComposerVoice, visibility: NoteVisibility): string {
  return voice === 'reviewer' && visibility === 'shared' ? 'Retract' : 'Delete'
}

/* --------------------------------------------------------- the private link */

/**
 * The private link on a **saved** note.
 *
 * It is offered as an action on a note that already exists, never as a choice
 * in the composer: there is nothing to link to until something has been
 * written, and a third option beside "Share with Mike" and "Only me" would read
 * as a third state of who can see it. There are two states, and this is not one
 * of them.
 *
 * **The link is a locator, not a key.** It carries the book and the note's
 * identifier and nothing else -- no token, no signature, no body, no quotation,
 * nothing about who wrote it. Following it grants nothing: the page behind it
 * asks the same question every other note surface asks -- may *this* viewer read
 * *this* note -- and answers the same way. Copying the link to somebody does
 * not share the note with them; sharing is `Share with Mike`, and it is the
 * only thing that is.
 *
 * The two doors exist because the administrator cookie is scoped to `/admin`
 * and is not sent to `/review`. A reviewer's link is a `/review` one because
 * that is where reviewers are, and the page it lands on offers Mike his own
 * door rather than asking him for a reviewer's access code. This is exactly the
 * arrangement `/review/shared/<token>` already uses for annotations, for the
 * same reason.
 */
export function noteLinkPath(voice: ComposerVoice, bookSlug: string, noteId: string): string {
  const base = voice === 'author' ? '/admin/note' : '/review/note'
  return `${base}/${encodeURIComponent(bookSlug)}/${encodeURIComponent(noteId)}`
}

/** What the action is called. The same words the annotation link uses. */
export const NOTE_LINK_LABEL = 'Private link'

/**
 * What the link is, said where it is offered.
 *
 * Per voice, because the consequence differs: a reviewer may hand theirs to
 * somebody and needs to know that doing so gives them nothing, and Mike's own
 * notes are private to him and cannot be opened by anybody else at all.
 */
export function noteLinkHint(voice: ComposerVoice, visibility: NoteVisibility): string {
  if (voice === 'author') {
    return 'A link straight to this note. Only your own sign-in opens it — it is not a way to let anyone else read it.'
  }
  return visibility === 'shared'
    ? 'A link straight to this note. It opens for you, and for Mike because you shared it. It is not a way in for anyone else.'
    : 'A link straight to this note. While it is only you, only you can open it — handing it to someone gives them nothing.'
}
