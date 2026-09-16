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
