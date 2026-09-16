'use client'

import Link from 'next/link'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import BookmarkRibbon from '@/components/motion/BookmarkRibbon'
import { highlightSegments } from '@/lib/reading-anchor'
import ReadingHelp from '@/components/reader/ReadingHelp'
import {
  AUTHOR_PRIVACY_LINE,
  NOTE_LINK_LABEL,
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
  type ComposerVoice,
} from '@/components/reader/note-composer'
import { writeNoteOnce } from '@/components/reader/note-write'

import {
  DEFAULT_SIZE,
  DEFAULT_THEME,
  SIZE_STEPS,
  applyAppearance,
  readPreferences,
  writePreferences,
  type Preferences,
  type Theme,
} from '../../reader-storage'
import { remainingReadingLabel } from '@/lib/reading-remaining'
import {
  beaconPosition,
  deleteAnnotation,
  deleteNote,
  fetchReading,
  deleteBookmark,
  saveAnnotation,
  saveBookmark,
  saveNote,
  savePosition,
  updateAnnotationRecord,
  updateNoteRecord,
  afterOutcome,
  alreadyOnRecord,
  mayHandOver,
  NOTHING_SENT,
  type ClientAnnotation,
  type ClientBookmark,
  type ClientNote,
  type ClientPosition,
  type NoteScope,
  type NoteVisibility,
  type PositionSaveResult,
  type ReadingEndpoint,
  type SaveGuard,
  type Visibility,
} from '../../reading-client'
import {
  browserStore,
  clearPending,
  deviceId,
  nextSequence,
  sweepForeignPending,
  writePending,
} from '../../reading-local'
import { serverHasConfirmed } from '@/lib/reading-order'

/*
 * The reading surface.
 *
 * It receives already-parsed blocks and never the manuscript's plain text as a
 * single string: a paragraph arrives as its inline segments plus its
 * identifier, and the exact passage a record is about is resolved on the server
 * from that identifier and a pair of character offsets.
 *
 * Four things are this component's job beyond rendering prose well, and they
 * are four *different* things, kept apart on purpose:
 *
 *   **Resume** is automatic. Nobody asks for it. It is one position per reader
 *   per book, overwritten as they read, and it is not a bookmark.
 *
 *   **Bookmarks** are deliberate and plural. "Come back here." No comment is
 *   required, any number may exist in a book, and each is removed on its own.
 *
 *   **Highlights** are a selected passage, marked and nothing more. They are
 *   **always private**, they carry no words, and the shortcut that makes one
 *   never inherits a sharing default from anywhere -- marking a sentence while
 *   reading is not a decision to tell anybody about it.
 *
 *   **Notes** are the one thing anybody writes. One composer, one save row, one
 *   record. What differs between them is scope -- a selected passage, a
 *   paragraph, a chapter, or (for Mike) the whole book -- and, for a reviewer,
 *   who may read it. A note can be edited, re-scoped in visibility, and
 *   deleted, by the person who wrote it and nobody else.
 *
 * There used to be a second composer beside that one: a **Send** control that
 * submitted a comment which could never afterwards be corrected, withdrawn, or
 * made private. It is gone from here and refused on the server. What was
 * submitted under it is still readable, under the label "Earlier submitted
 * comments", and is never mistaken for a note.
 *
 * The same component serves the author's reader. What changes is the endpoint
 * it writes to and its `voice` -- nothing about the prose, and nothing about
 * how a passage is identified. Mike is never shown a "Share with Mike" control
 * and has nothing to share his notes with; he gets `open` / `resolved` instead,
 * which is the question he actually has about his own marginalia.
 *
 * Nothing here watches what anyone reads: no timings, no dwell, no events. The
 * only things written are the automatic position and what the reader
 * deliberately created.
 */

type InlineSegment = {
  kind: 'text' | 'emphasis' | 'strong' | 'code'
  text: string
  /** The mark this run sits inside, when the manuscript nested one. */
  within?: 'emphasis' | 'strong'
}

/** Mirrors `ParagraphVariant` in `lib/manuscript.ts`. Presentation only. */
type ParagraphVariant = 'prose' | 'dateline' | 'section' | 'quote'

export type ReaderClientBlock =
  | {
      kind: 'paragraph'
      id: string
      ordinal: number
      variant: ParagraphVariant
      tight: boolean
      segments: InlineSegment[]
    }
  | { kind: 'scene-break'; id: string }

/**
 * One run of a paragraph, marked the way the manuscript marked it.
 *
 * Every variant renders as text a reader can select, so a highlight can start
 * inside a bold label or a code span exactly as it can inside running prose --
 * the offsets are measured against the paragraph's characters, and these
 * elements do not add any.
 */
function Marked({
  kind,
  text,
  within,
}: {
  kind: InlineSegment['kind']
  text: string
  within?: InlineSegment['within']
}) {
  const inner =
    kind === 'emphasis' ? (
      <em>{text}</em>
    ) : kind === 'strong' ? (
      <strong>{text}</strong>
    ) : kind === 'code' ? (
      <code className="rv-codespan">{text}</code>
    ) : (
      <>{text}</>
    )

  // A run the manuscript nested inside another mark keeps both.
  if (within === 'emphasis') return <em>{inner}</em>
  if (within === 'strong') return <strong>{inner}</strong>
  return inner
}

type ChapterSummary = {
  slug: string
  number: number
  label: string
  subtitle: string
  minutes: number
}

/** Which reader this is, in the only two places it can matter. */
type Voice = ComposerVoice

/**
 * What the composer is currently about.
 *
 * `scope` is the note's scope. `passage` and `paragraph` carry the place they
 * need; `chapter` and `book` carry nothing, because those scopes anchor to
 * nothing smaller and this component must not invent a place for them.
 */
type ComposerTarget = {
  scope: NoteScope
  passage: SelectionTarget | null
  paragraph: { id: string; ordinal: number } | null
}

type StoredFeedback = {
  id: string
  scope: 'paragraph' | 'chapter'
  chapterSlug: string
  paragraphId: string | null
  comment: string
  createdAt: string
}

/** A passage the reader has selected and may turn into an annotation. */
type SelectionTarget = {
  paragraphId: string
  ordinal: number
  start: number
  end: number
  quote: string
}

/** Fallback height of the sticky header, in px, matching `--rv-bar-h`. */
const HEADER_OFFSET = 64

/**
 * How much of a paragraph has to remain below the header before it still
 * counts as the one being read.
 *
 * Without this, a paragraph with three pixels of its last line tucked under
 * the bar — invisible, finished, scrolled past — was still "the topmost
 * paragraph in view", so that was the place recorded. Returning then put
 * *its* first line under the bar, dropping the reader a whole paragraph
 * above where they stopped. Mike photographed exactly that.
 *
 * About one line: enough to ignore a sliver hiding under the bar, not enough
 * to skip a line anybody could actually read.
 */
const PARAGRAPH_VISIBLE_SLACK = 0

/**
 * A place, as one comparable string.
 *
 * The offset is rounded to a hundredth of a paragraph — about seven pixels
 * of the longest paragraph in this manuscript, well under a line. Finer than
 * that and a reader who breathes on the screen writes a new record; coarser
 * and the thing this was added to fix starts coming back.
 */
function placeKey(paragraphId: string, offset: number): string {
  return `${paragraphId}@${Math.round(offset * 100)}`
}

/**
 * How far below the top of the viewport a scroll target has to land.
 *
 * Measured rather than assumed. The bar is `--rv-bar-h` tall plus whatever the
 * phone reserves at the top -- and since the site turned on `viewport-fit=cover`
 * so the dock could clear the home indicator, that top inset is real on a
 * notched handset. A fixed 64 would scroll a bookmarked paragraph to a position
 * partly underneath the bar, which is a strange thing to experience when you
 * asked to be taken back to a line.
 */
function headerOffset(): number {
  const bar = document.querySelector<HTMLElement>('.rv-bar')
  const measured = bar?.getBoundingClientRect().height ?? 0
  return measured > 0 ? measured : HEADER_OFFSET
}

/** Space the fixed bottom dock occupies, plus a little breathing room. */
const DOCK_CLEARANCE = 76

/**
 * How long a removed ribbon stays mounted so it can draw itself back up.
 *
 * The bookmark itself is gone the instant it is removed -- state is never held
 * back for an animation. This only keeps the ribbon element in the DOM long
 * enough to retract, and it is comfortably longer than the tween so a slow
 * frame cannot leave one stranded.
 */
const RIBBON_RETIRE_MS = 600

/**
 * Longest note the server will accept. Mirrored here only to show a count.
 *
 * One bound now, because there is one kind of writing. The retired comment
 * model had its own, identical, limit in a second constant beside this one.
 */
const MAX_NOTE_LENGTH = 4000

/**
 * How long after the reader stops moving the place is written.
 *
 * Short enough that nobody has to wait for it — by the time a hand has
 * reached for the back button this has already fired — and long enough that
 * a continuous scroll does not become a request per line.
 */
const POSITION_SETTLE_MS = 1200

/**
 * The longest the place may go unwritten while the reader keeps moving.
 *
 * Some people scroll the entire time they read, a line at a time, and never
 * pause long enough for the settle above to fire. This is the ceiling that
 * catches them: however continuously they scroll, the place is never older
 * than this.
 */
const POSITION_MAX_INTERVAL_MS = 8000

/**
 * How many times a position write may be retried after a failure that a retry
 * could plausibly fix.
 *
 * Small on purpose. This is a write nobody asked for; it must not become a
 * connection being hammered in the background while somebody reads. Three
 * attempts covers the single dropped request and the moment of no signal, and
 * stops well short of anything a reviewer would notice.
 */
const POSITION_RETRY_LIMIT = 3

/** How long to wait before the nth retry. Short, then patient. */
const POSITION_RETRY_BACKOFF_MS = [1500, 5000, 15000]

/**
 * How close to the foot of the page counts as the foot of the page.
 *
 * Sub-pixel layout, a phone's rubber-band settling and a collapsing browser
 * toolbar all leave the last scroll a fraction short of the arithmetic maximum.
 * Two pixels absorbs that and nothing else: it is far too small to be reached
 * from anywhere a reader would still call "the middle of the chapter".
 */
const PAGE_BOTTOM_TOLERANCE = 2

/**
 * How far into the local pending record's life the browser bothers rewriting
 * it while the reader scrolls.
 *
 * The record exists so the *next* page can see a place this device has not had
 * confirmed yet, and the two moments that matter — a save going out, and the
 * reader leaving — write it unconditionally. This is only the running update in
 * between, throttled because `localStorage` is synchronous and a phone's scroll
 * handler is the last place to put an unbounded number of writes.
 */
const PENDING_PERSIST_MS = 500

/**
 * `useLayoutEffect` on the client, `useEffect` on the server. Restoring a saved
 * position has to happen before the browser paints, or the reviewer sees the
 * top of the chapter for a frame; resolving the hook once at module scope keeps
 * the hook order stable and keeps React quiet during server rendering.
 */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/**
 * Put a paragraph just below the bar.
 *
 * The `behavior` argument is resolved into an explicit CSS value and applied to
 * the document for the duration of the call, rather than passed only as a
 * `scrollTo` option. Browsers do not agree about whether that option overrides
 * an inherited `scroll-behavior: smooth`, and this reader cannot afford the
 * ambiguity: resuming a reviewer's place must be instant and exact, and "go to
 * my bookmark" must be the one thing that glides. Setting the property removes
 * the question.
 *
 * Reduced motion collapses `smooth` to `auto` before any of that, so a reviewer
 * who has asked for stillness never gets an animated scroll from here.
 */
function scrollToParagraph(
  id: string,
  behavior: ScrollBehavior,
  /** How far into the paragraph to land, 0 to 1. */
  offset = 0,
): boolean {
  const element = document.getElementById(id)
  if (!element) return false

  const wanted: ScrollBehavior =
    behavior === 'smooth' && !prefersReducedMotion() ? 'smooth' : 'auto'

  const rect = element.getBoundingClientRect()
  const into =
    offset > 0 && rect.height > 0 ? Math.min(1, offset) * rect.height : 0
  const top = rect.top + window.scrollY - headerOffset() + into
  const root = document.documentElement
  const previous = root.style.scrollBehavior

  root.style.scrollBehavior = wanted
  window.scrollTo({ top: top < 0 ? 0 : top, behavior: wanted })

  if (wanted === 'smooth') {
    // Restoring immediately would cancel the glide that was just started; a
    // frame is long enough for it to be under way and short enough that
    // nothing else can scroll in between.
    window.requestAnimationFrame(() => {
      root.style.scrollBehavior = previous
    })
  } else {
    root.style.scrollBehavior = previous
  }

  return true
}

/**
 * What the reader has selected, as character offsets into one paragraph.
 *
 * Offsets are measured against the paragraph's rendered text by asking the
 * browser itself: a range from the start of the prose to the start of the
 * selection, stringified, is exactly the number of characters before it. That
 * is the same run of characters the server holds, so the two agree without
 * either having to describe the other's markup.
 *
 * A selection that starts in one paragraph and ends in another returns null.
 * Spanning paragraphs would need an anchor that names two of them, and an
 * anchor that can straddle a paragraph boundary is an anchor that breaks
 * differently when either one is edited. One paragraph, always.
 *
 * Line numbers are not consulted and could not be: `.rv-para-text` wraps
 * differently at 320px, at 390px, in landscape, and at each of the five text
 * sizes, and the same selection must mean the same passage in all of them.
 */
function selectionInParagraph(): SelectionTarget | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)
  const quote = range.toString()
  if (quote.trim() === '') return null

  const host = (range.startContainer.parentElement ?? null)?.closest<HTMLElement>(
    '.rv-para-text',
  )
  if (!host) return null
  // Both ends must be inside the same paragraph's prose. `contains` is true for
  // the element itself, which is what a selection of the whole paragraph gives.
  if (!host.contains(range.endContainer)) return null

  const paragraph = host.closest<HTMLElement>('[data-rv-pid]')
  const paragraphId = paragraph?.dataset.rvPid
  const ordinal = Number(paragraph?.dataset.rvOrdinal ?? '0')
  if (!paragraphId) return null

  const before = document.createRange()
  before.selectNodeContents(host)
  before.setEnd(range.startContainer, range.startOffset)
  const start = before.toString().length

  return { paragraphId, ordinal, start, end: start + quote.length, quote }
}

/* --------------------------------------------------------------------- icons */

function IconBack() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  )
}

function IconNext() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 5l7 7-7 7" />
    </svg>
  )
}

function IconContents() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  )
}

function IconType() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 19l5.5-14L14 19M5 14h7M15.5 19L19 9.5 22.5 19M16.6 16.4h4.8" />
    </svg>
  )
}

/** A question mark in a ring -- the one icon everybody already reads as help. */
function IconHelp() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.2a2.5 2.5 0 1 1 3.2 2.4c-.6.2-.9.7-.9 1.3v.6" />
      <path d="M12 16.8v.01" />
    </svg>
  )
}

function IconBookmark({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        className={filled ? 'is-filled' : undefined}
        d="M6.5 3.75h11a1 1 0 0 1 1 1v15.5l-6.5-4.2-6.5 4.2V4.75a1 1 0 0 1 1-1z"
      />
    </svg>
  )
}

function IconHighlight() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 20h16M6.5 16.5l-2 .5.5-2L14 5.8a1.7 1.7 0 0 1 2.4 0l1.4 1.4a1.7 1.7 0 0 1 0 2.4z" />
    </svg>
  )
}

function IconComment() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M20 15a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function IconClose() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

function IconTrash() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10.5 10.5v5M13.5 10.5v5" />
    </svg>
  )
}

/* --------------------------------------------------------------------- sheet */

function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return undefined

    returnFocusRef.current = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const panel = panelRef.current
    /*
     * Where the keyboard lands when a sheet opens.
     *
     * A sheet whose reason for existing is a box to write in should open with
     * the cursor already in that box. The first focusable element in document
     * order is the close button in the header, so asking for that put the
     * keyboard on "Close" and a reviewer had to click into the box before
     * typing. A sheet with nothing to write in -- Contents, Appearance, the
     * list of marks -- still starts at its first focusable element, as before.
     */
    const initial =
      panel?.querySelector<HTMLElement>('textarea') ??
      panel?.querySelector<HTMLElement>(
        'textarea, button, [href], input, select, [tabindex]:not([tabindex="-1"])',
      )
    initial?.focus()

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !panel) return

      // Keep the keyboard inside the sheet while it is open.
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'textarea, button, [href], input, select, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute('disabled'))
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      returnFocusRef.current?.focus?.()
    }
    // `onClose` must be referentially stable, or this trap re-arms on every
    // render of the sheet's owner -- re-running the focus above and pulling
    // the keyboard out of whatever the reviewer was typing into.
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <div className="rv-scrim" onClick={onClose} aria-hidden="true" />
      <div className="rv-sheet" role="dialog" aria-modal="true" aria-label={title} ref={panelRef}>
        <div className="rv-sheet-grip" aria-hidden="true" />
        <div className="rv-sheet-head">
          <h2 className="rv-sheet-title">{title}</h2>
          <button type="button" className="rv-icon-btn" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <div className="rv-sheet-body">{children}</div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------ sharing control */

const SHARING: { value: Visibility; label: string; hint: string }[] = [
  { value: 'private', label: 'Private', hint: 'Only you. Not Mike, not anyone.' },
  { value: 'author', label: 'Share with Mike', hint: 'Mike can read this note.' },
  { value: 'link', label: 'Private link', hint: 'A link you can hand to someone.' },
]

/*
 * The composer's wording and its default live in
 * `components/reader/note-composer.ts`, not here.
 *
 * They are the decisions most worth being able to check -- what the two choices
 * say, which one the composer opens on, and whether the author is offered a
 * sharing control at all -- and a sheet that is closed until somebody opens it
 * never appears in a server render, so a page cannot be asserted against. The
 * module is pure and is tested directly; this file renders it.
 */

/** How a note says where it is, once it is written. */
function noteWhere(note: ClientNote, chapterLabel: string): string {
  if (note.anchor.scope === 'book') return 'The whole book'
  if (note.anchor.scope === 'chapter') return note.anchor.chapterLabel || chapterLabel
  return `Paragraph ${note.anchor.paragraphOrdinal}`
}

/** The words a note was written about, as captured. Never the manuscript now. */
function noteCaptured(note: ClientNote): string | null {
  if (note.anchor.scope === 'passage') return note.anchor.quote
  if (note.anchor.scope === 'paragraph') return note.anchor.paragraphText
  return null
}

function SharingControl({
  annotation,
  onChange,
  busy,
}: {
  annotation: ClientAnnotation
  onChange: (visibility: Visibility) => void
  busy: boolean
}) {
  const [copied, setCopied] = useState(false)

  const shareUrl =
    annotation.sharePath && typeof window !== 'undefined'
      ? `${window.location.origin}${annotation.sharePath}`
      : null

  return (
    <div className="rv-share">
      <div className="rv-segments rv-segments--share" role="group" aria-label="Sharing">
        {SHARING.map((option) => (
          <button
            key={option.value}
            type="button"
            className="rv-segment"
            aria-pressed={annotation.visibility === option.value}
            disabled={busy}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <p className="rv-share-hint">
        {SHARING.find((option) => option.value === annotation.visibility)?.hint}
      </p>

      {shareUrl ? (
        <div className="rv-share-link">
          <code>{annotation.sharePath}</code>
          <button
            type="button"
            className="rv-btn rv-btn--ghost"
            onClick={() => {
              // Clipboard access can be refused, and on a phone often is. The
              // path is shown above in either case, so the link is never
              // unavailable just because copying was.
              void navigator.clipboard
                ?.writeText(shareUrl)
                .then(() => setCopied(true))
                .catch(() => setCopied(false))
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      ) : null}

      {annotation.visibility === 'link' ? (
        <p className="rv-share-note">
          Opening this link still needs Mike&rsquo;s own sign-in, or a reviewer who has
          been given this book. It is a way to point at the note, not a way in.
        </p>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------- reader */

/**
 * Who may read this note, as a control.
 *
 * Rendered for a reviewer only. Mike has no such control anywhere in this file:
 * his notes are private by definition, there is no state in which a reviewer
 * can see one, and showing him a "Share with Mike" segment would be offering
 * him something that does not exist.
 */
function NoteVisibilityControl({
  value,
  onChange,
  busy,
  labelledBy,
}: {
  value: NoteVisibility
  onChange: (visibility: NoteVisibility) => void
  busy: boolean
  labelledBy: string
}) {
  return (
    <>
      <div
        className="rv-segments rv-segments--share"
        role="group"
        aria-labelledby={labelledBy}
      >
        {visibilityChoicesFor('reviewer').map((option) => (
          <button
            key={option.value}
            type="button"
            className="rv-segment"
            aria-pressed={value === option.value}
            disabled={busy}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="rv-share-hint">
        {visibilityChoicesFor('reviewer').find((option) => option.value === value)?.hint}
      </p>
    </>
  )
}

/**
 * A saved note's private link.
 *
 * **Post-save only, and never a composer choice.** It appears among the actions
 * on a note that already exists, because there is nothing to link to until
 * something has been written -- and because a third option beside "Share with
 * Mike" and "Only me" would read as a third state of who can see it. There are
 * two states. This is not one of them.
 *
 * What is shown is a path: the book and the note's identifier, and nothing
 * else. No token, no signature, no body, no quotation, nothing about who wrote
 * it. Handing it to somebody gives them nothing -- the page behind it asks the
 * same question every other note surface asks, and answers the same way.
 */
function NoteLink({ voice, note }: { voice: ComposerVoice; note: ClientNote }) {
  const [copied, setCopied] = useState(false)
  const path = noteLinkPath(voice, note.bookSlug, note.id)

  return (
    <div className="rv-share">
      <div className="rv-share-link">
        <code>{path}</code>
        <button
          type="button"
          className="rv-btn rv-btn--ghost"
          onClick={() => {
            // Clipboard access can be refused, and on a phone often is. The
            // path is shown above in either case, so the link is never
            // unavailable just because copying was.
            void navigator.clipboard
              ?.writeText(`${window.location.origin}${path}`)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }}
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
      <p className="rv-share-note">{noteLinkHint(voice, note.visibility)}</p>
    </div>
  )
}

export default function ChapterReader({
  namespace,
  endpoint,
  bookBase,
  workspaceHref,
  voice,
  book,
  chapter,
  blocks,
  contents,
  previousSlug,
  nextSlug,
  initial,
}: {
  namespace: string
  /** Where reading records are written: the reviewer's endpoint or the author's. */
  endpoint: ReadingEndpoint
  /** `/review/<book>` or `/admin/read/<book>` -- the prefix for every chapter link. */
  bookBase: string
  /** The "My reading" / "Your reading" destination for this kind of reader. */
  workspaceHref: string
  /**
   * Which reader this is.
   *
   * It decides two things and nothing else. A **reviewer** gets the visibility
   * control and their own earlier submitted comments; the word "Mike" appears
   * because they are writing to him. The **author** gets `open` / `resolved`,
   * the whole-book scope, and no sharing control at all -- his notes are
   * private by definition, so there is nobody to offer them to. The legacy
   * feedback endpoint is never called in the author's voice: submitting
   * reviewer feedback as the author is exactly the contamination the separate
   * namespace exists to prevent.
   */
  voice: Voice
  book: { slug: string; title: string }
  chapter: {
    slug: string
    number: number
    title: string
    label: string
    subtitle: string
    paragraphCount: number
    minutes: number
  }
  blocks: ReaderClientBlock[]
  contents: ChapterSummary[]
  previousSlug: string | null
  nextSlug: string | null
  /** Server-rendered so highlights and ribbons are correct on the first paint. */
  initial: {
    position: ClientPosition | null
    bookmarks: ClientBookmark[]
    annotations: ClientAnnotation[]
    notes: ClientNote[]
  }
}) {
  const isReviewer = voice === 'reviewer'
  const [preferences, setPreferences] = useState<Preferences>({
    theme: DEFAULT_THEME,
    size: DEFAULT_SIZE,
  })
  const [bookmarks, setBookmarks] = useState<ClientBookmark[]>(initial.bookmarks)
  const [annotations, setAnnotations] = useState<ClientAnnotation[]>(initial.annotations)
  const [notes, setNotes] = useState<ClientNote[]>(initial.notes)
  const [sheet, setSheet] = useState<
    'contents' | 'type' | 'marks' | 'note' | 'help' | null
  >(
    null,
  )
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null)
  const [mine, setMine] = useState<StoredFeedback[]>([])
  const [progress, setProgress] = useState(0)
  const [busy, setBusy] = useState(false)

  /**
   * "About 9 min left", under the chapter label.
   *
   * Held in state rather than derived at render time so the DOM text changes
   * exactly when the whole-minute figure changes, and not once per scroll
   * frame. `progress` moves continuously; this does not.
   */
  const [remainingLabel, setRemainingLabel] = useState<string | null>(null)

  /**
   * Whether the last automatic position write is known to have failed.
   *
   * `false` is not a claim that the place is saved -- it is the absence of a
   * known failure, which is why nothing is shown for it. Only a failure has
   * anything to say.
   */
  const [positionFailed, setPositionFailed] = useState(false)

  /** The live text selection, and where its floating action row should sit. */
  const [selection, setSelection] = useState<SelectionTarget | null>(null)
  const [selectionAt, setSelectionAt] = useState<{ top: number; left: number } | null>(null)

  /*
   * The composer: what it is about, what has been typed into it, who it is
   * for, and -- when an existing note is being corrected rather than a new one
   * written -- which note it is editing.
   *
   * One set of state, because there is one composer. The reader used to carry
   * two: a note sheet with a sharing control and a feedback sheet with a Send
   * button, each with its own text, its own busy flag and its own idea of what
   * it was about.
   */
  const [composer, setComposer] = useState<ComposerTarget | null>(null)
  const [noteText, setNoteText] = useState('')
  const [noteVisibility, setNoteVisibility] = useState<NoteVisibility>(
    defaultVisibilityFor(voice),
  )
  const [editingNote, setEditingNote] = useState<string | null>(null)
  /**
   * The revision of the note the composer was opened on.
   *
   * Captured when the composer is filled from a note, not read off the list at
   * save time: it has to be the version whose words are actually on the screen
   * being corrected. Sent with the save, so a note that has changed in another
   * tab or on another device refuses this one (409) instead of overwriting it.
   */
  const [editingNoteRevision, setEditingNoteRevision] = useState<number | null>(null)

  /** The annotation or note whose detail is open in the marks sheet. */
  const [openAnnotation, setOpenAnnotation] = useState<string | null>(null)
  const [openNote, setOpenNote] = useState<string | null>(null)
  /**
   * Which saved note is currently showing its private link.
   *
   * Held per note id rather than as a flag on the open note, so closing
   * and reopening a note does not silently re-reveal a link somebody put
   * away -- and so that no such state exists at all until a note has been
   * saved, which is the only time this control is offered.
   */
  const [noteLinkFor, setNoteLinkFor] = useState<string | null>(null)

  /*
   * Which paragraph is showing its controls.
   *
   * A permanent control row under all 117 paragraphs of a chapter makes the
   * prose unreadable, and a hidden long-press makes the controls undiscoverable.
   * So: tapping a paragraph opens its row, and the hint under the chapter title
   * says so in as many words. On a pointer device, hover reveals it as well.
   *
   * It closes again the moment something is done with it. A bookmarked
   * paragraph used to keep its row open permanently, which left a panel of
   * buttons wedged inside the prose for the rest of the chapter; the ribbon in
   * the margin is what says a paragraph is bookmarked now.
   */
  const [openParagraph, setOpenParagraph] = useState<string | null>(null)

  /*
   * The paragraph whose ribbon is on its way out.
   *
   * A removed bookmark is removed immediately -- this is only about the ribbon
   * element surviving long enough to animate away, after which it is dropped.
   */
  const [retiringRibbon, setRetiringRibbon] = useState<string | null>(null)

  const articleRef = useRef<HTMLElement | null>(null)
  const paragraphsRef = useRef<HTMLElement[]>([])
  const lastSavedRef = useRef<string | null>(null)
  const lastSentAtRef = useRef(0)
  const pendingParagraphRef = useRef<string | null>(null)
  /**
   * The last paragraph actually handed to the network, by any path.
   *
   * Distinct from `lastSavedRef`, which records the last paragraph *measured*
   * whether or not the throttle let it through. The leave flush compares
   * against this one, so closing a chapter you have not moved in since the last
   * write sends nothing at all.
   */
  /**
   * What the network has been told, and what it has said back.
   *
   * This was one ref meaning "already written", set the instant a request was
   * *started*. So a save that was refused, or that never arrived at all, went
   * on marking its place as written, and every later chance to save it -- the
   * settle, the ceiling, and the flush on the way out, which is the last chance
   * anybody gets -- found nothing to do. A failed save suppressed its own
   * rescue.
   *
   * Two questions, told apart, and the rules for them live in
   * `../../reading-client.ts` where they can be exercised on their own:
   * confirmed means the server said 2xx, in flight means no answer yet, and a
   * place that is neither -- never sent, or sent and failed -- is worth
   * sending.
   */
  const saveGuardRef = useRef<SaveGuard>(NOTHING_SENT)
  /** How far into `pendingParagraphRef` the reader is, 0 to 1. */
  const pendingOffsetRef = useRef(0)
  /**
   * This browser's ordering identity, and the counter for its saves.
   *
   * Minted on first use and kept in storage, so every tab of this browser
   * shares one rising sequence. It names nobody and authorizes nothing --
   * `lib/reading-order.ts` says exactly what the server may and may not do with
   * it. Held in a ref because it must not change between a save and the
   * confirmation of that save.
   */
  const deviceRef = useRef<string | null>(null)
  /** The newest local place written to storage, so the next page can see it. */
  const pendingSequenceRef = useRef(0)
  /** When the running local record was last rewritten. See PENDING_PERSIST_MS. */
  const persistedAtRef = useRef(0)
  /**
   * The scroll offset this component itself last put the page at.
   *
   * The confirmation below compares against it to answer one question: has
   * anything moved the page since we placed it? Any answer but "no" means
   * the reader is in charge and must not be moved.
   */
  const placedScrollYRef = useRef(-1)
  /** Mirrors `remaining` so the effect can avoid a no-op state update. */
  const remainingRef = useRef<string | null>(null)
  /**
   * The scroll offset the *reader* last put the page at.
   *
   * Written on every scroll event, which costs nothing -- reading `scrollY` does
   * not force layout the way measuring a paragraph does. It exists so the leave
   * flush can tell the reader's scrolling apart from the browser's: see
   * `onLeave`.
   */
  const lastScrollYRef = useRef(0)
  /**
   * The latest "write where the reader is" closure, so the layout effect below
   * can call it on unmount without owning any of the state it needs.
   */
  const flushRef = useRef<() => void>(() => {})

  /**
   * Whether the reader has actually moved through the chapter yet.
   *
   * A resume position is a claim about where someone stopped reading, so only
   * their own scrolling may make one. Mounting, re-rendering and resizing all
   * measure the page too, and none of them is evidence of having read
   * anything -- left ungated they recorded "you were at paragraph one" the
   * instant a chapter opened, and the next visit then scrolled the title,
   * the reading time and the hint off the screen to honour it.
   */
  const hasScrolledRef = useRef(false)

  /**
   * Whether a *person* has touched the page yet.
   *
   * Distinct from `hasScrolledRef`, which the reader's own resume scroll
   * sets on its way past. This one is set only by a wheel, a touch or a key
   * — things a browser cannot do to itself — and it is what stops the
   * confirmation below from ever yanking the page out from under somebody who
   * has already started reading.
   */
  const userMovedRef = useRef(false)
  const ribbonTimer = useRef<number | null>(null)

  /** Bookmarks and annotations in *this* chapter, indexed by paragraph. */
  const bookmarkedParagraphs = useMemo(() => {
    const map = new Map<string, ClientBookmark>()
    for (const bookmark of bookmarks) {
      if (bookmark.chapterSlug === chapter.slug) map.set(bookmark.paragraphId, bookmark)
    }
    return map
  }, [bookmarks, chapter.slug])

  const rangesByParagraph = useMemo(() => {
    const map = new Map<string, { id: string; start: number; end: number }[]>()
    for (const annotation of annotations) {
      if (annotation.chapterSlug !== chapter.slug) continue
      // An anchor that no longer matches the text is never drawn over whatever
      // now occupies those offsets. It is listed in the marks sheet with its
      // saved quotation and a "needs relocating" label instead.
      if (annotation.anchorState !== 'ok') continue
      const list = map.get(annotation.paragraphId) ?? []
      list.push({
        id: annotation.id,
        start: annotation.startOffset,
        end: annotation.endOffset,
      })
      map.set(annotation.paragraphId, list)
    }
    return map
  }, [annotations, chapter.slug])

  const chapterBookmarks = useMemo(
    () => bookmarks.filter((bookmark) => bookmark.chapterSlug === chapter.slug),
    [bookmarks, chapter.slug],
  )

  /**
   * A paragraph's number in the chapter, for the device-local record.
   *
   * The server derives this from the manuscript and never takes it from a
   * request, so this copy is display material only -- it is what lets "Chapter
   * Two, paragraph 35" read correctly on a page that has not heard back from
   * the server yet, and it is replaced by the server's own the moment it does.
   */
  const ordinalOf = useCallback(
    (paragraphId: string): number | null => {
      for (const block of blocks) {
        if (block.kind === 'paragraph' && block.id === paragraphId) return block.ordinal
      }
      return null
    },
    [blocks],
  )

  /**
   * Closing a sheet, as one stable function.
   *
   * This is passed to `Sheet`, whose focus trap re-arms whenever its handler
   * changes identity. Written inline as an arrow function it was a new
   * function on every render -- and because the comment being typed is state
   * up here, every keystroke re-rendered, re-armed the trap, and moved the
   * keyboard out of the box mid-sentence.
   */
  const closeSheet = useCallback(() => {
    setSheet(null)
    setOpenAnnotation(null)
  }, [])

  /**
   * Take the reader's place before a link inside the reader begins navigating.
   *
   * An in-app navigation does eventually reach the unmount flush, but by then
   * React is tearing the chapter down and the destination page may already be
   * rendering from the router's cache -- which is precisely the page that needs
   * to know there is something newer. `pointerdown` is the earliest honest
   * moment: the chapter is fully laid out, the reader has not moved, and the
   * measurement is theirs.
   *
   * It cannot be *awaited*. Android's Back button offers no such moment at all,
   * so correctness must never depend on a save completing before a navigation,
   * and nothing here blocks one. This only makes the common case -- the
   * reader's own Contents arrow, the contents menu, Previous and Next -- take
   * its measurement a beat earlier and write the local record a beat sooner.
   * Flushing twice is free: the second finds the place already in flight.
   */
  const captureBeforeLeaving = useCallback(() => {
    flushRef.current()
  }, [])

  /* ---------------------------------------------------------- preferences */

  useIsomorphicLayoutEffect(() => {
    const stored = readPreferences(namespace)
    setPreferences(stored)
    applyAppearance(stored)
  }, [namespace])

  const updatePreferences = useCallback(
    (next: Preferences) => {
      setPreferences(next)
      applyAppearance(next)
      writePreferences(namespace, next)
    },
    [namespace],
  )

  /* -------------------------------------------------------------- resume */

  useIsomorphicLayoutEffect(() => {
    paragraphsRef.current = Array.from(
      articleRef.current?.querySelectorAll<HTMLElement>('[data-rv-pid]') ?? [],
    )

    /*
     * Where the page stands before anybody touches it. Set unconditionally,
     * because a chapter that resumes nowhere still needs a baseline: that is
     * precisely the case the confirmation exists for -- a cached payload saying
     * "your place is in some other chapter" when the server knows better.
     */
    placedScrollYRef.current = window.scrollY

    // An explicit link target always wins over a remembered position: the
    // reviewer asked for that paragraph by following a link to it.
    const hash = window.location.hash.slice(1)
    if (hash && scrollToParagraph(hash, 'auto')) return

    // The automatic position, and only when it is in this chapter. It comes
    // from the server, so it follows a reviewer between devices -- which is the
    // whole reason it stopped living in this browser's storage.
    const mark =
      initial.position && initial.position.chapterSlug === chapter.slug
        ? initial.position.paragraphId
        : null
    if (!mark) return

    /*
     * A mark on the first paragraph is not a place anyone stopped reading --
     * it is the top of the chapter, wearing a paragraph's name. Honouring it
     * scrolls the title, the reading time, the hint and the epigraph off the
     * screen to arrive at the very text those sit above.
     */
    if (mark === (paragraphsRef.current[0]?.dataset.rvPid ?? null)) return

    /*
     * Resume, then hold it.
     *
     * The first scroll happens before paint, but the page is not finished
     * settling: the web font arrives and re-measures every line, which moves
     * the target under us. So the position is re-asserted for a short budget
     * and abandoned the moment the reviewer scrolls themselves -- nothing is
     * more irritating than a page that drags you back while you are reading.
     */
    scrollToParagraph(mark, 'auto', initial.position?.paragraphOffset ?? 0)
    placedScrollYRef.current = window.scrollY

    let settled = false
    const give = () => {
      settled = true
    }
    window.addEventListener('wheel', give, { passive: true, once: true })
    window.addEventListener('touchstart', give, { passive: true, once: true })
    window.addEventListener('keydown', give, { once: true })

    const deadline = Date.now() + 1200
    let frame = window.requestAnimationFrame(function hold() {
      if (settled || Date.now() > deadline) return
      scrollToParagraph(mark, 'auto', initial.position?.paragraphOffset ?? 0)
      placedScrollYRef.current = window.scrollY
      frame = window.requestAnimationFrame(hold)
    })

    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('wheel', give)
      window.removeEventListener('touchstart', give)
      window.removeEventListener('keydown', give)
    }
  }, [chapter.slug, initial.position])

  /*
   * Confirm the saved place against the server, once, on arrival.
   *
   * The position that arrives with this page comes from a server render, and
   * the App Router keeps the RSC payload of a visited route in a client-side
   * cache and replays it on the next navigation. So a reviewer who opens a
   * chapter, reads, leaves, and comes back within the cache window is handed a
   * payload describing where they were *before* they read — and resumes
   * there. That was the first defect Mike reported.
   *
   * It was fixed once by switching the client cache off for every dynamic
   * route (`staleTimes: { dynamic: 0 }`). That worked, and it cost something
   * Mike then found: with the cache off, a back navigation refetches, so the
   * router has nothing to restore a scroll position against, and the library
   * he came back to was left scrolled to its own bottom. Measured at 390px:
   * the dashboard landed at 564px, its maximum, instead of the top.
   *
   * So the cache is left alone and the wrong assumption is fixed instead. A
   * reading position is per-request state and has no business being read out
   * of a cached document; it is asked for directly here. The server render is
   * still the instant path — nothing waits on this — and this only moves
   * the page if the server disagrees and the reader has not yet touched it.
   */
  useEffect(() => {
    let cancelled = false

    /*
     * A borrowed phone must not keep the last reader's place.
     *
     * The device-local record is keyed by this reader's storage namespace, so
     * another reviewer's could never be *read* here. This is the other half:
     * signing out and signing in as somebody else changes the namespace, and
     * what the previous reader left behind is removed rather than merely
     * ignored.
     */
    sweepForeignPending(namespace)

    void fetchReading(endpoint, book.slug).then((result) => {
      if (cancelled || !result.ok) return

      const truth = result.value.position

      /*
       * If the server already holds what this device was waiting on, the local
       * shortcut has done its job and is dropped. Confirmation is this device's
       * own sequence and nothing else -- a position written by another device
       * says nothing about whether this one's save arrived.
       */
      const store = browserStore()
      if (store && deviceRef.current && pendingSequenceRef.current > 0) {
        if (serverHasConfirmed(truth, deviceRef.current, pendingSequenceRef.current)) {
          clearPending(namespace, book.slug, store)
        }
      }

      if (!truth || truth.chapterSlug !== chapter.slug) return
      if (!truth.paragraphId) return

      // A link to a paragraph was an explicit request; never overrule it.
      if (window.location.hash) return
      // They are already reading. Their eyes win over any record of them.
      if (userMovedRef.current) return

      /*
       * And the guard that actually holds: has the page moved at all since this
       * component placed it?
       *
       * `userMovedRef` watches for a wheel, a touch or a key, and that is not
       * everything that can move a page. This request is a network round trip,
       * so it can land seconds after the reader began reading -- and when it
       * did, it scrolled them back to where they had started *and* overwrote
       * the pending position with it, so the reading they had just done was
       * never written. Measured: two screens of reading lost.
       *
       * Comparing the scroll offset needs no guess about what moved it. If the
       * page is not exactly where we left it, somebody else is driving.
       */
      if (placedScrollYRef.current < 0) return
      if (Math.abs(window.scrollY - placedScrollYRef.current) > 8) return
      // The page already agrees, to within a hundredth of a paragraph.
      if (
        placeKey(truth.paragraphId, truth.paragraphOffset ?? 0) ===
        placeKey(
          initial.position?.paragraphId ?? '',
          initial.position?.paragraphOffset ?? 0,
        )
      ) {
        return
      }

      const offset = truth.paragraphOffset ?? 0
      if (scrollToParagraph(truth.paragraphId, 'auto', offset)) {
        placedScrollYRef.current = window.scrollY
        lastSavedRef.current = truth.paragraphId
        pendingParagraphRef.current = truth.paragraphId
        pendingOffsetRef.current = offset
        saveGuardRef.current = alreadyOnRecord(
          saveGuardRef.current,
          placeKey(truth.paragraphId, offset),
        )
      }
    })

    return () => {
      cancelled = true
    }
  }, [endpoint, namespace, book.slug, chapter.slug, initial.position])

  /*
   * Note when a person — rather than the browser — moves the page.
   */
  useEffect(() => {
    const moved = () => {
      userMovedRef.current = true
    }
    window.addEventListener('wheel', moved, { passive: true })
    window.addEventListener('touchstart', moved, { passive: true })
    window.addEventListener('keydown', moved)
    return () => {
      window.removeEventListener('wheel', moved)
      window.removeEventListener('touchstart', moved)
      window.removeEventListener('keydown', moved)
    }
  }, [])

  /*
   * Write the place down while the chapter is still on the screen.
   *
   * This is the half of the fix that matters, and it is about *when* rather
   * than what. A `useEffect` cleanup runs in the passive phase, which React
   * reaches only after the commit has already detached the chapter's DOM --
   * every paragraph's `getBoundingClientRect()` is zeroes by then, so a flush
   * that measures from there finds nothing and writes nothing. Measured: the
   * fix flushed correctly on `pagehide` and on a backgrounded tab, and silently
   * did nothing at all on an in-app navigation, which is the common case.
   *
   * A *layout* effect's cleanup runs during the mutation phase, before the host
   * nodes go. The article is still measurable, so the reader's real position is
   * still knowable, which is the only moment it ever is.
   *
   * The passive effect keeps its own cleanup call as well. Whichever runs
   * first writes; the save guard makes the second a no-op.
   */
  useIsomorphicLayoutEffect(() => {
    return () => {
      flushRef.current()

      /*
       * Hand the next page a scroll offset that means something.
       *
       * A chapter is twenty-odd thousand pixels tall; the library is about
       * fourteen hundred. Leaving by the phone's Back button does not reset the
       * document's scroll, so that enormous offset survives the route change and
       * the browser simply clamps it to whatever the next page can take --
       * landing the reviewer at the very bottom of a library they never
       * scrolled. Measured at 390px: the library came back at 564px, which is
       * exactly its maximum. Mike saw this as "the dashboard has scrolled up
       * even though I didn't scroll".
       *
       * The chapter's offset is meaningful only inside the chapter, so it is
       * given up here on the way out. Everything the reviewer can reach from a
       * chapter -- the library, the book, "My reading", the next chapter --
       * wants to start at its top, and a chapter re-entered later is placed by
       * its saved position rather than by a remembered scroll.
       */
      window.scrollTo(0, 0)
    }
  }, [chapter.slug])

  /*
   * A paragraph's controls sit at the end of it, so on a long paragraph they
   * can open just below the fold -- the reviewer taps, and nothing appears to
   * happen. Bring them into view by the smallest amount that works, and only
   * when they are actually out of view, so a tap near the top of the screen
   * does not move the page under someone's eyes.
   */
  useEffect(() => {
    if (!openParagraph) return
    const tools = document
      .getElementById(openParagraph)
      ?.querySelector<HTMLElement>('.rv-para-tools')
    if (!tools) return

    const box = tools.getBoundingClientRect()
    // The dock is fixed over the foot of the page, so "visible" stops above it
    // rather than at the bottom of the viewport.
    const floor = window.innerHeight - DOCK_CLEARANCE
    const ceiling = headerOffset()
    let delta = 0

    if (box.bottom > floor) delta = box.bottom - floor
    else if (box.top < ceiling) delta = box.top - ceiling - 8

    if (delta === 0) return

    // Same reasoning as `scrollToParagraph`: the reader's document is
    // `scroll-behavior: auto`, so a smooth nudge has to say so explicitly
    // rather than hope the option outranks the stylesheet.
    const wanted: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth'
    const root = document.documentElement
    const previous = root.style.scrollBehavior

    root.style.scrollBehavior = wanted
    window.scrollBy({ top: delta, behavior: wanted })
    window.requestAnimationFrame(() => {
      root.style.scrollBehavior = previous
    })
  }, [openParagraph])

  /* ------------------------------------------------- position + progress */

  useEffect(() => {
    let timer: number | null = null
    let raf: number | null = null
    /** Fires once the reader has stopped moving. */
    let settle: number | null = null
    /** Fires regardless, so a continuous scroller is still recorded. */
    let ceiling: number | null = null

    /**
     * Where the reader is, right now, straight off the DOM.
     *
     * Pulled out of `measure` so that leaving the chapter can ask the same
     * question synchronously. Before, the only answer available at leaving time
     * was `pendingParagraphRef` -- a value written by the *previous* completed
     * measurement, which on a quick exit had never run. See `onLeave`.
     *
     * Returns `null` for the first paragraph. That is not a place anyone
     * stopped reading; it is what the top of the chapter looks like, and a mark
     * for it would only ever be used to scroll the title off the screen.
     */
    function currentParagraph(): string | null {
      const paragraphs = paragraphsRef.current
      if (paragraphs.length === 0) return null
      const ceiling = headerOffset()

      /*
       * Binary search, not a walk.
       *
       * Paragraphs are in document order, so "the first one whose bottom is
       * past the header" is a sorted predicate and costs about seven
       * measurements instead of a hundred. That matters because this now runs
       * on every scroll event rather than once per throttled frame: it is what
       * keeps `pendingParagraphRef` true at all times without putting a
       * hundred layout reads into a phone's scroll handler.
       */
      const floor = ceiling + PARAGRAPH_VISIBLE_SLACK
      let low = 0
      let high = paragraphs.length - 1
      let found = -1
      while (low <= high) {
        const mid = (low + high) >> 1
        if (paragraphs[mid].getBoundingClientRect().bottom > floor) {
          found = mid
          high = mid - 1
        } else {
          low = mid + 1
        }
      }

      // `-1` is past the end; `0` is the first paragraph, which is the top of
      // the chapter wearing a paragraph's name and is never a place to return to.
      if (found <= 0) return null

      /*
       * How far through it the reader is, which is the half of the answer a
       * paragraph id cannot carry. The paragraph the reader is *inside* has
       * its top above the header; the fraction of it already gone past is
       * what puts them back on the same line rather than at the paragraph's
       * first one.
       */
      const rect = paragraphs[found].getBoundingClientRect()
      const past = rect.height > 0 ? (ceiling - rect.top) / rect.height : 0
      pendingOffsetRef.current = past < 0 ? 0 : past > 1 ? 1 : past

      return paragraphs[found].dataset.rvPid ?? null
    }

    /** Record what a write is known to have done. Silence means no known failure. */
    function record(result: PositionSaveResult) {
      setPositionFailed(result === 'refused' || result === 'unreachable')
    }

    /** This browser's ordering identity. Minted once, then kept. */
    function device(): string {
      if (deviceRef.current === null) deviceRef.current = deviceId()
      return deviceRef.current
    }

    /**
     * Write down, on this device, where the reader is and which save covers it.
     *
     * This is the shortcut that survives the page being torn down. It is not a
     * second source of truth -- the server's record is the only one -- but the
     * page the reviewer lands on next can be a cached replay of one rendered
     * before any of this reading happened, and this is how that page learns
     * there is something newer on its way. See `../../reading-local.ts`.
     */
    function persistPending(paragraphId: string, paragraphOffset: number, sequence: number) {
      pendingSequenceRef.current = sequence
      persistedAtRef.current = Date.now()
      writePending({
        schema: 1,
        identity: namespace,
        device: device(),
        sequence,
        bookSlug: book.slug,
        bookTitle: book.title,
        chapterSlug: chapter.slug,
        chapterNumber: chapter.number,
        chapterLabel: chapter.label,
        paragraphId,
        paragraphOrdinal: ordinalOf(paragraphId),
        ...(paragraphOffset > 0 ? { paragraphOffset } : {}),
        recordedAt: Date.now(),
        attempts: 0,
      })
    }

    /**
     * The place handed to the network whose fate is not yet known.
     *
     * Held so a failure has something to try again with. It carries its own
     * sequence, and a retry reuses it rather than minting a new one: repeating
     * a save with the same sequence is safe by construction, because the server
     * refuses a sequence at or below what it already has from this device.
     */
    let outstanding: {
      key: string
      paragraphId: string
      paragraphOffset: number
      sequence: number
      tries: number
    } | null = null
    let retry: number | null = null

    function cancelRetry() {
      if (retry !== null) {
        window.clearTimeout(retry)
        retry = null
      }
    }

    /**
     * What a completed attempt means, and what happens next.
     *
     * The important half is the failure path, and specifically the line that
     * releases the flight. While a failed attempt still counted as written,
     * the place it failed to save could never be sent again -- including by the
     * flush on the way out. A refused save silently disabled its own rescue.
     * `afterOutcome` releases it, so the next settle, ceiling or leave sees the
     * place as unsent, because it is.
     */
    function settled(
      attempt: { key: string; sequence: number },
      outcome: { result: PositionSaveResult; retryable: boolean },
    ) {
      const stored = outcome.result === 'stored'
      saveGuardRef.current = afterOutcome(saveGuardRef.current, attempt.key, stored)
      record(outcome.result)

      if (stored) {
        outstanding = null
        cancelRetry()
        /*
         * The local shortcut is dropped when this answer covers it. Sequences
         * from this device only ever rise, so a record at or below the one just
         * confirmed describes this place or an earlier one -- both of which the
         * server now holds something at least as new as. A record with a
         * *higher* sequence is a later place still waiting on its own answer,
         * and is left exactly where it is.
         */
        if (pendingSequenceRef.current <= attempt.sequence) {
          clearPending(namespace, book.slug)
        }
        return
      }

      /*
       * A terminal refusal is not retried. An ended session and an invented
       * paragraph both answer identically however many times they are asked,
       * and a reader is owed the honest line in the bar rather than a request
       * repeating behind it for the rest of the chapter.
       */
      if (!outcome.retryable || !outstanding || outstanding.key !== attempt.key) {
        if (!outcome.retryable) outstanding = null
        return
      }

      if (outstanding.tries >= POSITION_RETRY_LIMIT) {
        outstanding = null
        return
      }

      const wait =
        POSITION_RETRY_BACKOFF_MS[
          Math.min(outstanding.tries - 1, POSITION_RETRY_BACKOFF_MS.length - 1)
        ]
      cancelRetry()
      retry = window.setTimeout(() => {
        retry = null
        if (outstanding) handOver(outstanding)
      }, wait)
    }

    /** Hand one place to the network, and account for it honestly. */
    function handOver(next: NonNullable<typeof outstanding>) {
      next.tries += 1
      saveGuardRef.current = { ...saveGuardRef.current, inFlight: next.key }
      lastSentAtRef.current = Date.now()

      void savePosition(endpoint, {
        bookSlug: book.slug,
        chapterSlug: chapter.slug,
        paragraphId: next.paragraphId,
        paragraphOffset: next.paragraphOffset,
        device: device(),
        sequence: next.sequence,
      }).then((report) =>
        settled(next, { result: report.result, retryable: report.retryable }),
      )
    }

    /** Send the pending position now, if it is worth sending. */
    function flushPending() {
      if (settle !== null) {
        window.clearTimeout(settle)
        settle = null
      }
      if (ceiling !== null) {
        window.clearTimeout(ceiling)
        ceiling = null
      }
      const paragraphId = pendingParagraphRef.current
      if (!paragraphId) return
      const paragraphOffset = pendingOffsetRef.current
      const key = placeKey(paragraphId, paragraphOffset)

      /*
       * Already stored, or already on its way. Two different reasons not to
       * send, and both of them are reasons -- unlike "we once tried", which is
       * what this used to check and is not one.
       */
      if (!mayHandOver(key, saveGuardRef.current)) return

      const sequence = nextSequence()
      persistPending(paragraphId, paragraphOffset, sequence)
      cancelRetry()
      outstanding = { key, paragraphId, paragraphOffset, sequence, tries: 0 }
      handOver(outstanding)
    }

    /*
     * Record where the reader is, on their rhythm rather than on a clock's.
     *
     * This was a plain eight-second throttle, and it was wrong twice over. It
     * had no trailing edge, so a reader who scrolled and then stopped -- which
     * is what a person does once they have reached where they were going --
     * had nothing written at all. And even with one bolted on, the place was
     * only ever as fresh as the last eight seconds, so leaving always risked
     * losing whatever had been read since.
     *
     * Reading is not a steady stream of events. It is a scroll, then twenty
     * seconds of stillness, then another scroll. So the write follows the
     * stillness: a short settle after the reader stops moving, which for almost
     * everybody means the place is already saved long before they think about
     * leaving.
     *
     * The exception Mike named is the reader who scrolls *continuously*, a line
     * at a time, and never pauses long enough for a settle to fire. The ceiling
     * is for them: however long they keep moving, the place is never older than
     * `POSITION_MAX_INTERVAL_MS`.
     *
     * Cost, for a reader who scrolls a burst and then reads: one small write per
     * burst. For a continuous scroller: one every eight seconds. Neither is a
     * request per scroll tick, which is what the throttle was guarding against.
     */
    function remember(paragraphId: string) {
      pendingParagraphRef.current = paragraphId

      // Already stored, or already in flight, to within a hundredth of a
      // paragraph. A place that was merely *attempted* is not on record and is
      // deliberately not counted here.
      const key = placeKey(paragraphId, pendingOffsetRef.current)
      if (!mayHandOver(key, saveGuardRef.current)) return

      const since = Date.now() - lastSentAtRef.current
      if (since >= POSITION_MAX_INTERVAL_MS) {
        flushPending()
        return
      }

      // Restart the settle: the reader is still moving.
      if (settle !== null) window.clearTimeout(settle)
      settle = window.setTimeout(() => {
        settle = null
        flushPending()
      }, POSITION_SETTLE_MS)

      // And make sure the ceiling is armed, so continuous scrolling still lands.
      if (ceiling === null) {
        ceiling = window.setTimeout(() => {
          ceiling = null
          flushPending()
        }, POSITION_MAX_INTERVAL_MS - since)
      }
    }

    /*
     * The progress bar and the remaining-time line, and nothing else.
     *
     * This is the only part of the reader allowed to wait for an animation
     * frame, because it is the only part that is purely about what gets
     * painted. The saved position used to live in here too, and that was the
     * deeper form of the same bug: a backgrounded tab paints nothing, gets no
     * frames, and so recorded nothing — however long the reader had been
     * reading before they switched apps.
     */
    function measure() {
      const article = articleRef.current
      if (article) {
        const height = article.scrollHeight - window.innerHeight
        const ratio = Math.min(1, Math.max(0, height > 0 ? window.scrollY / height : 1))
        setProgress(ratio)

        /*
         * The remaining-time line follows the bar, not the saved position: it
         * is presentation, it claims nothing, and it is as true on a resize as
         * on a scroll. The state is only touched when the words change, so the
         * text under the chapter label does not rewrite itself sixty times a
         * second while somebody is reading past it.
         *
         * The end of the chapter is asked of the **document**, not of the
         * article and not of the estimate. The progress ratio is measured
         * against the prose alone, so it reaches 1 while the dock, the
         * end-of-chapter links and the footer are still below the fold -- and a
         * rounded estimate reaches zero earlier still. Either of those standing
         * in for "you have finished" is how the bar came to say *Almost
         * finished* at the actual bottom, with nothing left to be almost
         * finished with. Only the page running out of scroll says that now.
         */
        const label = remainingReadingLabel(chapter.minutes, ratio, atPageBottom())
        if (label !== remainingRef.current) {
          remainingRef.current = label
          setRemainingLabel(label)
        }
      }

    }

    /**
     * Whether the page genuinely cannot scroll any further.
     *
     * A chapter short enough to fit the screen has no scroll to run out of, and
     * is treated as complete for the same reason: the reader can see all of it.
     */
    function atPageBottom(): boolean {
      const furthest = document.documentElement.scrollHeight - window.innerHeight
      if (furthest <= PAGE_BOTTOM_TOLERANCE) return true
      return window.scrollY >= furthest - PAGE_BOTTOM_TOLERANCE
    }

    function schedule() {
      // At most once every 150ms, and always on a frame boundary: keeping a
      // place is not worth a dropped frame on a phone.
      if (timer !== null || raf !== null) return
      timer = window.setTimeout(() => {
        timer = null
        raf = window.requestAnimationFrame(() => {
          raf = null
          measure()
        })
      }, 150)
    }

    function onScroll() {
      // The reviewer moved the page themselves. From here on, where they stop
      // is worth remembering.
      hasScrolledRef.current = true
      lastScrollYRef.current = window.scrollY

      /*
       * Keep the pending position true on every scroll, synchronously.
       *
       * This used to wait for `measure()`, which is 150ms of timer plus an
       * animation frame away -- and a backgrounded tab has no animation frames
       * at all, so on a phone the pending position could be minutes stale or
       * never set. It is the value the leave flush falls back on when the
       * browser has moved the page itself, so it has to be right *before*
       * anything else happens, not a frame later.
       *
       * Only the cheap part runs here. The write is still throttled to eight
       * seconds, and the progress bar and the remaining-time line still wait
       * for a frame, because neither is worth a dropped one.
       */
      const here = currentParagraph()
      if (here) {
        pendingParagraphRef.current = here
        if (here !== lastSavedRef.current) {
          lastSavedRef.current = here
          remember(here)
        }

        /*
         * And keep the device-local record roughly current as they read.
         *
         * The two moments that actually matter -- a save going out, and the
         * reader leaving -- write it unconditionally elsewhere. This is the
         * running update in between, so a page killed by the operating system
         * without any warning at all still leaves something roughly true
         * behind. Throttled, because `localStorage` is synchronous and this is
         * a phone's scroll handler.
         */
        if (Date.now() - persistedAtRef.current >= PENDING_PERSIST_MS) {
          const key = placeKey(here, pendingOffsetRef.current)
          /*
           * Nothing is recorded for a place that is already stored, or for one
           * whose answer is still coming: the first needs no shortcut and the
           * second has its own. A running record given a sequence that is
           * already in flight would be "confirmed" by that flight's answer even
           * though it describes somewhere further on -- so it always takes a
           * fresh one, and is superseded rather than mistaken for settled.
           */
          if (mayHandOver(key, saveGuardRef.current)) {
            persistPending(here, pendingOffsetRef.current, nextSequence())
          }
        }
      }

      // The bar and the estimate can wait for a frame. The place cannot.
      schedule()
    }

    // A resize re-measures so the progress bar stays honest, but it is the
    // window changing shape, not somebody reading, so it records nothing.
    function onResize() {
      schedule()
    }

    /*
     * The last position is the one that matters most and is the easiest to
     * lose: it is where they were when they closed the tab. `pagehide` is the
     * event that actually fires on a phone -- `beforeunload` does not, reliably,
     * when an app is swiped away -- and the write goes out as a beacon so the
     * browser delivers it after the page is gone.
     *
     * ## The defect this now fixes
     *
     * This used to flush `pendingParagraphRef` -- and *only* that. That ref is
     * written by `measure`, which never runs synchronously: a scroll schedules
     * it 150ms later, on the next animation frame. So a reader who scrolled and
     * then left inside that window left behind a `pending` value describing
     * where they had been at the *previous* measurement, or `null` if no
     * measurement had completed at all. The cleanup then cancelled the pending
     * timer and frame, throwing that measurement away for good.
     *
     * Reproduced before the fix: resume at p112, scroll to p115, tap Contents
     * immediately -- zero requests reached the server and the stored place
     * stayed p112. The whole reading session was lost, not merely its tail.
     *
     * The cause was never the throttle. The throttle correctly holds writes
     * back during reading; what was missing was asking, once, at the moment of
     * leaving, where the reader actually is. So that is what this does now, and
     * the throttle is untouched.
     */
    function onLeave() {
      if (!hasScrolledRef.current) return

      /*
       * Measure now -- but only if the page is still where the reader left it.
       *
       * Pressing the phone's Back button is a history navigation, and a history
       * navigation **restores the previous entry's scroll offset**. That can
       * land before React unmounts this chapter, and when it does, every
       * paragraph measures against a document scrolled back to near the top:
       * the measurement comes back as the first paragraph, which this code
       * correctly refuses to record, and the flush writes nothing at all.
       *
       * That is exactly the difference Mike saw. Leaving by the reader's own
       * back control is an ordinary click -- nothing touches the scroll, the
       * measurement is true, and the new place was saved. Leaving by the
       * phone's Back button restored the scroll first, the measurement was
       * rubbish, and the old place stayed.
       *
       * So: if `scrollY` is still the offset the reader themselves last
       * produced, the measurement is theirs and is used. If something else has
       * moved the page, the measurement describes the browser's scrolling
       * rather than the reader's, and the last position measured while they
       * were actually reading is the better answer.
       *
       * The tolerance absorbs sub-pixel and rubber-band settling; anything
       * larger than a couple of pixels is not the reader.
       */
      const moved = Math.abs(window.scrollY - lastScrollYRef.current) > 2
      const measured = moved ? null : currentParagraph()
      const paragraphId =
        measured ?? pendingParagraphRef.current ?? currentParagraph()
      if (!paragraphId) return

      const paragraphOffset = pendingOffsetRef.current
      const key = placeKey(paragraphId, paragraphOffset)

      /*
       * Nothing to say only when the place is genuinely on record, or its
       * answer is genuinely still coming. It used to be enough that a write had
       * once been *started* for it -- so a save that had already failed left
       * this, the last chance anyone gets, believing the work was done. Leaving
       * is exactly the moment a failed save has to be retried, not the moment
       * to inherit its optimism.
       */
      if (!mayHandOver(key, saveGuardRef.current)) return

      const sequence = nextSequence()
      pendingParagraphRef.current = paragraphId
      lastSavedRef.current = paragraphId
      saveGuardRef.current = { ...saveGuardRef.current, inFlight: key }
      lastSentAtRef.current = Date.now()

      /*
       * Write the local record *before* handing anything to the browser.
       *
       * `sendBeacon` returning true means queued, not stored, and the page is
       * about to stop existing -- there is nobody left to hear the outcome. The
       * page the reviewer lands on is the only thing that can still act on
       * this, and this synchronous line is how it finds out. It is what makes
       * the case Mike reproduced come out right: two screens of Chapter Three,
       * Android Back, and the card names Chapter Three without a refresh.
       */
      persistPending(paragraphId, paragraphOffset, sequence)

      /*
       * The fallback -- and only the fallback -- can still report.
       *
       * A queued beacon never will: the page is gone. But `beaconPosition`
       * falls back to an ordinary request when the beacon is unavailable or
       * refused, and there are two moments where the page survives to hear that
       * answer: a backgrounded tab that comes back, and a `pagehide` the
       * browser then restores from. On those, this is an ordinary failed save
       * with an ordinary bounded retry -- and on the pages that really are
       * going away, nothing runs and nothing is claimed.
       */
      cancelRetry()
      outstanding = { key, paragraphId, paragraphOffset, sequence, tries: 1 }
      beaconPosition(
        endpoint,
        {
          bookSlug: book.slug,
          chapterSlug: chapter.slug,
          paragraphId,
          paragraphOffset,
          device: device(),
          sequence,
        },
        (outcome) =>
          settled({ key, sequence }, { result: outcome.result, retryable: outcome.retryable }),
      )
    }

    /*
     * Only flush when the page is actually going away.
     *
     * `visibilitychange` fires in both directions, and the old handler wrote on
     * both -- so coming *back* to a tab sent a redundant position for a reader
     * who had not moved. Hidden is the half that matters: on a phone that is
     * the app being backgrounded, which is the most common way a chapter is
     * left without any navigation at all.
     */
    function onHide() {
      if (document.visibilityState === 'hidden') onLeave()
    }

    /*
     * Published for the unmount flush below. It has to be a ref rather than a
     * dependency because the flush must run at unmount with whatever the latest
     * closure is, and must not re-subscribe every time one is rebuilt.
     */
    flushRef.current = onLeave

    // The first measurement is for the progress bar and the estimate.
    measure()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onResize, { passive: true })
    window.addEventListener('pagehide', onLeave)
    document.addEventListener('visibilitychange', onHide)
    /*
     * A history navigation, at the earliest moment this code can see one. The
     * unmount flush would catch it too, but `popstate` fires before React has
     * begun tearing the chapter down, so the page is at its most trustworthy
     * here. Flushing twice is free -- the save guard makes the second a
     * no-op.
     */
    window.addEventListener('popstate', onLeave)

    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pagehide', onLeave)
      window.removeEventListener('popstate', onLeave)
      document.removeEventListener('visibilitychange', onHide)
      /*
       * Flush *before* the scheduled measurement is cancelled below. `onLeave`
       * no longer depends on that measurement having run -- it takes its own --
       * so the order is belt and braces rather than load-bearing.
       */
      onLeave()
      if (timer !== null) window.clearTimeout(timer)
      if (settle !== null) window.clearTimeout(settle)
      if (ceiling !== null) window.clearTimeout(ceiling)
      if (raf !== null) window.cancelAnimationFrame(raf)
      cancelRetry()
    }
    // `chapter.minutes` feeds the remaining-time line only; it is constant for
    // the life of a chapter, so listing it re-runs nothing in practice, and the
    // same is true of the title and label the local record carries.
  }, [
    endpoint,
    namespace,
    book.slug,
    book.title,
    chapter.slug,
    chapter.number,
    chapter.label,
    chapter.minutes,
    ordinalOf,
  ])

  /* ----------------------------------------------------------- selection */

  useEffect(() => {
    function readSelection() {
      const found = selectionInParagraph()
      setSelection(found)

      if (!found) {
        setSelectionAt(null)
        return
      }

      const range = window.getSelection()?.getRangeAt(0)
      const rect = range?.getBoundingClientRect()
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        setSelectionAt(null)
        return
      }

      // Above the selection where there is room, below it where there is not,
      // and never underneath the sticky bar.
      const above = rect.top - 8
      const below = rect.bottom + 8
      setSelectionAt({
        top: above > headerOffset() + 44 ? above : below,
        left: Math.min(Math.max(rect.left + rect.width / 2, 96), window.innerWidth - 96),
      })
    }

    // `selectionchange` is the only event that fires for every way a selection
    // can be made or dropped: a drag, a long press, a double tap, a keyboard,
    // or the handles a phone puts on either end of it.
    document.addEventListener('selectionchange', readSelection)
    return () => document.removeEventListener('selectionchange', readSelection)
  }, [])

  const clearSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges()
    setSelection(null)
    setSelectionAt(null)
  }, [])

  /* --------------------------------------------- earlier submitted comments */

  /**
   * The retired model, read only.
   *
   * These rows were submitted before notes existed. They are still a reviewer's
   * history and are still shown, under their own label, with no control that
   * implies they can be edited -- because they cannot be, which is exactly why
   * the model was retired. Nothing on this page can write one: the endpoint
   * refuses `POST`, and this is the only place that touches it.
   */
  const refreshMine = useCallback(async () => {
    if (!isReviewer) return
    try {
      const response = await fetch(
        `/review/api/feedback?book=${encodeURIComponent(book.slug)}`,
        { credentials: 'same-origin' },
      )
      if (!response.ok) return
      const body = (await response.json()) as { entries?: StoredFeedback[] }
      setMine((body.entries ?? []).filter((entry) => entry.chapterSlug === chapter.slug))
    } catch {
      // The reader works without it; this only shows a reviewer their history.
    }
  }, [book.slug, chapter.slug, isReviewer])

  useEffect(() => {
    void refreshMine()
  }, [refreshMine])

  /* ----------------------------------------------------------- bookmarks */

  const retireRibbon = useCallback((paragraphId: string) => {
    if (ribbonTimer.current !== null) window.clearTimeout(ribbonTimer.current)
    setRetiringRibbon(paragraphId)
    ribbonTimer.current = window.setTimeout(() => {
      ribbonTimer.current = null
      setRetiringRibbon(null)
    }, RIBBON_RETIRE_MS)
  }, [])

  /**
   * Add a bookmark here, or take away the one that is already here.
   *
   * There is no single "the bookmark". Every paragraph can carry one, they all
   * coexist, and each is removed on its own -- which is the difference between
   * a bookmark and the automatic position, and the reason they are stored
   * separately and never derived from each other.
   */
  const toggleBookmark = useCallback(
    async (paragraphId: string) => {
      if (busy) return
      const existing = bookmarkedParagraphs.get(paragraphId)
      setBusy(true)
      setOutcome(null)

      try {
        if (existing) {
          const result = await deleteBookmark(endpoint, book.slug, existing.id)
          if (result.ok) {
            setBookmarks((current) => current.filter((row) => row.id !== existing.id))
            retireRibbon(paragraphId)
          } else {
            setOutcome({ ok: false, message: result.message })
          }
        } else {
          const result = await saveBookmark(endpoint, {
            bookSlug: book.slug,
            chapterSlug: chapter.slug,
            paragraphId,
          })
          if (result.ok) {
            const saved = result.value
            setBookmarks((current) =>
              current.some((row) => row.id === saved.id) ? current : [...current, saved],
            )
          } else {
            setOutcome({ ok: false, message: result.message })
          }
        }
      } finally {
        setBusy(false)
        // The row of buttons goes away as soon as it has been used. What is
        // left behind is the ribbon in the margin, which says the same thing
        // without occupying a line of the page.
        setOpenParagraph(null)
      }
    },
    [busy, bookmarkedParagraphs, endpoint, book.slug, chapter.slug, retireRibbon],
  )

  const removeBookmarkById = useCallback(
    async (id: string) => {
      if (busy) return
      const doomed = bookmarks.find((row) => row.id === id)
      setBusy(true)
      const result = await deleteBookmark(endpoint, book.slug, id)
      setBusy(false)
      if (result.ok) {
        setBookmarks((current) => current.filter((row) => row.id !== id))
        if (doomed && doomed.chapterSlug === chapter.slug) retireRibbon(doomed.paragraphId)
      } else {
        setOutcome({ ok: false, message: result.message })
      }
    },
    [busy, bookmarks, endpoint, book.slug, chapter.slug, retireRibbon],
  )

  // A chapter left mid-retract must not leave a timer behind.
  useEffect(() => {
    return () => {
      if (ribbonTimer.current !== null) window.clearTimeout(ribbonTimer.current)
    }
  }, [])

  /* ---------------------------------------------------------- annotations */

  /**
   * The highlight shortcut: a mark on the page, and nothing written.
   *
   * There is no body to pass and no sharing to choose. A highlight is always
   * private when it is made, the server refuses a body on this operation
   * outright, and everything that *is* writing goes through the one composer.
   */
  const createAnnotation = useCallback(
    async (passage: SelectionTarget) => {
      if (busy) return false
      setBusy(true)
      setOutcome(null)

      const result = await saveAnnotation(endpoint, {
        bookSlug: book.slug,
        chapterSlug: chapter.slug,
        paragraphId: passage.paragraphId,
        startOffset: passage.start,
        endOffset: passage.end,
      })

      setBusy(false)

      if (!result.ok) {
        setOutcome({ ok: false, message: result.message })
        return false
      }

      const saved = result.value
      setAnnotations((current) => [...current, saved])
      return true
    },
    [busy, endpoint, book.slug, chapter.slug],
  )

  const changeSharing = useCallback(
    async (id: string, visibility: Visibility) => {
      if (busy) return
      setBusy(true)
      const result = await updateAnnotationRecord(endpoint, book.slug, id, { visibility })
      setBusy(false)
      if (result.ok) {
        const saved = result.value
        setAnnotations((current) => current.map((row) => (row.id === id ? saved : row)))
      } else {
        setOutcome({ ok: false, message: result.message })
      }
    },
    [busy, endpoint, book.slug],
  )

  const removeAnnotationById = useCallback(
    async (id: string) => {
      if (busy) return
      setBusy(true)
      const result = await deleteAnnotation(endpoint, book.slug, id)
      setBusy(false)
      if (result.ok) {
        setAnnotations((current) => current.filter((row) => row.id !== id))
        setOpenAnnotation((current) => (current === id ? null : current))
      } else {
        setOutcome({ ok: false, message: result.message })
      }
    },
    [busy, endpoint, book.slug],
  )

  /* ---------------------------------------------------------------- notes */

  /**
   * Open the one composer, about one place.
   *
   * Every entry point into writing comes through here: the selection row, a
   * paragraph's own controls, the chapter action, and -- for Mike -- the book
   * action. They differ in the scope they open on and in nothing else.
   */
  const openComposer = useCallback(
    (target: ComposerTarget) => {
      setComposer(target)
      setEditingNote(null)
      setEditingNoteRevision(null)
      setNoteText('')
      setNoteVisibility(defaultVisibilityFor(voice))
      setOutcome(null)
      setSheet('note')
    },
    [voice],
  )

  /** The same composer, correcting something already written. */
  const openComposerForEdit = useCallback((note: ClientNote) => {
    setComposer({
      scope: note.anchor.scope,
      passage:
        note.anchor.scope === 'passage'
          ? {
              paragraphId: note.anchor.paragraphId,
              ordinal: note.anchor.paragraphOrdinal,
              start: note.anchor.startOffset,
              end: note.anchor.endOffset,
              quote: note.anchor.quote,
            }
          : null,
      paragraph:
        note.anchor.scope === 'paragraph'
          ? { id: note.anchor.paragraphId, ordinal: note.anchor.paragraphOrdinal }
          : null,
    })
    setEditingNote(note.id)
    setEditingNoteRevision(note.revision)
    setNoteText(note.body)
    setNoteVisibility(note.visibility)
    setOutcome(null)
    setSheet('note')
  }, [])

  /**
   * Save what is in the composer: a new note, or a correction to one.
   *
   * The scope decides which place travels with the request, and nothing else is
   * sent. A chapter or book note carries no paragraph and no offsets, because
   * it is about no paragraph -- the server would refuse an invented one, and
   * this is the half of that agreement the browser keeps.
   */
  const submitComposer = useCallback(async (): Promise<boolean> => {
    if (busy || !composer) return false
    const body = noteText.trim()
    if (body.length === 0 || body.length > MAX_NOTE_LENGTH) return false

    /*
     * A correction is only sendable when the version it corrects is known.
     * The two are set together by `openComposerForEdit` and cleared together
     * by `openComposer`, so this is unreachable -- and it is written down
     * rather than assumed, because the alternative to knowing the revision is
     * guessing one, and a guessed revision is the blind write again.
     */
    const editedRevision = editingNoteRevision
    if (editingNote !== null && editedRevision === null) return false

    /*
     * The order -- busy, clear the banner, one request, busy off, report or
     * accept, and only then end the edit -- is `writeNoteOnce`, and it is
     * asserted in `tests/note-write.test.ts` rather than read out of this
     * file's source. What stays here is what is genuinely the composer's: the
     * two transports, what each is sent, and what ending the edit means.
     *
     * The composer is the one caller that clears the previous report before
     * sending. The two one-tap changes below do not, and never did.
     */
    const effects = {
      busy: setBusy,
      clearReport: true,
      report: (message: string | null) => {
        /*
         * The composer is left exactly as it is -- open, with the typed words
         * still in it -- and `false` stops the caller closing it. That matters
         * most for a 409: the one thing the server does not have is what has
         * just been written here, so discarding the draft to "resynchronise"
         * would destroy the only copy of it. The message says to reload and to
         * copy the text first; it does not do either on somebody's behalf.
         */
        setOutcome(message === null ? null : { ok: false, message })
      },
      accepted: (saved: ClientNote) => {
        setNotes((current) =>
          current.some((row) => row.id === saved.id)
            ? current.map((row) => (row.id === saved.id ? saved : row))
            : [...current, saved],
        )
      },
      finished: () => {
        setComposer(null)
        setEditingNote(null)
        setNoteText('')
        closeSheet()
      },
    }

    return editingNote !== null && editedRevision !== null
      ? writeNoteOnce(
          updateNoteRecord,
          [
            endpoint,
            book.slug,
            editingNote,
            editedRevision,
            {
              body,
              // A reviewer may change who can read it in the same save. Mike has
              // no such field, and sending one would be refused, not ignored.
              ...(isReviewer ? { visibility: noteVisibility } : {}),
            },
          ],
          effects,
        )
      : writeNoteOnce(
          saveNote,
          [
            endpoint,
            {
              bookSlug: book.slug,
              scope: composer.scope,
              ...(composer.scope === 'book' ? {} : { chapterSlug: chapter.slug }),
              ...(composer.scope === 'passage' && composer.passage
                ? {
                    paragraphId: composer.passage.paragraphId,
                    startOffset: composer.passage.start,
                    endOffset: composer.passage.end,
                  }
                : {}),
              ...(composer.scope === 'paragraph'
                ? {
                    // A passage selection knows its paragraph, so widening the
                    // scope from "these words" to "this paragraph" needs no
                    // second gesture -- and still names a real paragraph.
                    paragraphId: composer.paragraph?.id ?? composer.passage?.paragraphId,
                  }
                : {}),
              body,
              // Always explicit. The server fails private on anything else.
              visibility: isReviewer ? noteVisibility : 'private',
            },
          ],
          effects,
        )
  }, [
    busy,
    composer,
    noteText,
    editingNote,
    editingNoteRevision,
    endpoint,
    book.slug,
    chapter.slug,
    isReviewer,
    noteVisibility,
    closeSheet,
  ])

  /*
   * The two one-tap changes. Both take the revision of the note as it was
   * rendered, for the same reason the composer does: `busy` serialises these
   * within one tab and is client state, not a server guarantee -- the same
   * person on a phone and a laptop is two clients, and a retried request is
   * two attempts. A save that cannot say which version it was made against is
   * a save that can undo one made somewhere else.
   */
  const changeNoteVisibility = useCallback(
    async (id: string, expectedRevision: number, visibility: NoteVisibility) => {
      if (busy) return
      await writeNoteOnce(
        updateNoteRecord,
        [endpoint, book.slug, id, expectedRevision, { visibility }],
        {
          busy: setBusy,
          // Including a conflict, which is reported and never retried: the note
          // on screen is stale, and the list is left showing what it was given
          // rather than being repainted from a write that did not happen.
          report: (message) => setOutcome(message === null ? null : { ok: false, message }),
          accepted: (saved) => {
            setNotes((current) => current.map((row) => (row.id === id ? saved : row)))
          },
        },
      )
    },
    [busy, endpoint, book.slug],
  )

  /** Mike's own triage of his own notes. A reviewer has no such state. */
  const changeNoteStatus = useCallback(
    async (id: string, expectedRevision: number, status: 'open' | 'resolved') => {
      if (busy) return
      await writeNoteOnce(
        updateNoteRecord,
        [endpoint, book.slug, id, expectedRevision, { status }],
        {
          busy: setBusy,
          report: (message) => setOutcome(message === null ? null : { ok: false, message }),
          accepted: (saved) => {
            setNotes((current) => current.map((row) => (row.id === id ? saved : row)))
          },
        },
      )
    },
    [busy, endpoint, book.slug],
  )

  const removeNoteById = useCallback(
    async (id: string) => {
      if (busy) return
      setBusy(true)
      const result = await deleteNote(endpoint, book.slug, id)
      setBusy(false)
      if (result.ok) {
        setNotes((current) => current.filter((row) => row.id !== id))
        setNoteLinkFor((current) => (current === id ? null : current))
        setOpenNote((current) => (current === id ? null : current))
      } else {
        setOutcome({ ok: false, message: result.message })
      }
    },
    [busy, endpoint, book.slug],
  )

  /** The paragraph the composer is about, when it is about one. */
  const composerParagraph =
    composer?.paragraph
      ? blocks.find(
          (block): block is Extract<ReaderClientBlock, { kind: 'paragraph' }> =>
            block.kind === 'paragraph' && block.id === composer.paragraph?.id,
        )
      : undefined

  const noteRemaining = MAX_NOTE_LENGTH - noteText.length

  const chapterAnnotations = annotations.filter(
    (annotation) => annotation.chapterSlug === chapter.slug,
  )

  /**
   * The notes this chapter's sheet lists: everything anchored here, plus the
   * book notes, which are about this chapter as much as any other.
   */
  const chapterNotes = notes.filter(
    (note) => note.anchor.scope === 'book' || note.anchor.chapterSlug === chapter.slug,
  )

  /** Paragraphs that already carry a note of this reader's, for the margin mark. */
  const notedParagraphs = new Set(
    notes
      .map((note) =>
        note.anchor.scope === 'passage' || note.anchor.scope === 'paragraph'
          ? (note.paragraphId ?? note.anchor.paragraphId)
          : null,
      )
      .filter((id): id is string => id !== null),
  )

  const commented = new Set(
    mine.filter((entry) => entry.paragraphId).map((entry) => entry.paragraphId as string),
  )

  /**
   * The scopes the composer may currently offer.
   *
   * A scope is offered only when the place it needs is actually known. Offering
   * "selected passage" with nothing selected, or "this paragraph" from the
   * chapter action, would be offering to anchor a note to somewhere this
   * component would then have to invent.
   */
  const availableScopes: NoteScope[] = composer
    ? scopesFor(voice).filter((scope) => {
        if (scope === 'passage') return composer.passage !== null
        if (scope === 'paragraph') return composer.paragraph !== null || composer.passage !== null
        return true
      })
    : []

  return (
    <>
      <header className="rv-bar">
        <Link
          href={bookBase}
          className="rv-icon-btn"
          aria-label="Contents"
          onPointerDown={captureBeforeLeaving}
        >
          <IconBack />
        </Link>
        {/*
         * The chapter label, and under it one line of muted micro-copy.
         *
         * It lives inside the existing title slot rather than in a new row, so
         * the bar keeps its height and every piece of scroll arithmetic that
         * measures it -- resume, bookmarks, `scroll-margin-top` -- is untouched.
         *
         * The slot says one thing at a time, and a failed save outranks the
         * estimate: a reader who needs to know their place was not kept should
         * not have to read past how long the chapter has left. When all is
         * well it shows the estimate; when nothing is known it shows nothing.
         */}
        <span className="rv-bar-title" title={chapter.label}>
          <span className="rv-bar-label">{chapter.label}</span>
          {positionFailed ? (
            <span className="rv-bar-meta rv-bar-meta--bad" role="status">
              Couldn&rsquo;t save your place
            </span>
          ) : remainingLabel ? (
            <span className="rv-bar-meta">{remainingLabel}</span>
          ) : null}
        </span>
        <button
          type="button"
          className="rv-icon-btn"
          onClick={() => setSheet('contents')}
          aria-label="Chapters"
        >
          <IconContents />
        </button>
        <button
          type="button"
          className="rv-icon-btn"
          onClick={() => setSheet('marks')}
          aria-label="Bookmarks and notes"
        >
          <IconBookmark filled={bookmarks.length > 0} />
        </button>
        <button
          type="button"
          className="rv-icon-btn"
          onClick={() => setSheet('type')}
          aria-label="Appearance"
        >
          <IconType />
        </button>
        {/*
         * How reading works, in the bar rather than at the top of the chapter.
         * The chapter-top line is still there, and automatic resume means it is
         * usually scrolled past before it is ever read -- so the explanation
         * also lives somewhere that does not depend on where you happen to be
         * in the text.
         */}
        <button
          type="button"
          className="rv-icon-btn"
          onClick={() => setSheet('help')}
          aria-label="How reading works"
        >
          <IconHelp />
        </button>
        <div className="rv-progress" aria-hidden="true">
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      </header>

      <div className="rv-main rv-page">
        <div className="rv-chapter-head">
          <p className="rv-chapter-eyebrow">{book.title}</p>
          <h1 className="rv-chapter-title">{chapter.title}</h1>
          <p className="rv-chapter-meta">
            {chapter.paragraphCount} paragraphs · about {chapter.minutes} min
          </p>
          <p className="rv-chapter-hint">
            Select any words to highlight them or write a note. Tap a paragraph to bookmark
            it or write a note about it.
            {isReviewer
              ? ' Every note is yours: you choose who can see it, and you can change it or delete it later.'
              : ' Your notes are private to you, and nobody else can see them.'}
          </p>
        </div>

        {outcome && !outcome.ok ? (
          <p className="rv-note rv-note--bad" role="alert">
            {outcome.message}
          </p>
        ) : null}

        <article className="rv-prose" ref={articleRef}>
          {blocks.map((block) => {
            if (block.kind === 'scene-break') {
              return <div key={block.id} className="rv-scene" role="separator" />
            }

            const bookmark = bookmarkedParagraphs.get(block.id)
            const isBookmarked = Boolean(bookmark)
            const isCommented = commented.has(block.id) || notedParagraphs.has(block.id)
            const isActive =
              sheet === 'note' &&
              (composer?.paragraph?.id === block.id || composer?.passage?.paragraphId === block.id)

            const classes = ['rv-para']
            if (block.variant !== 'prose') classes.push(`rv-para--${block.variant}`)
            if (block.tight) classes.push('rv-para--tight')
            if (isBookmarked) classes.push('rv-para--bookmarked')
            if (isCommented) classes.push('rv-para--commented')
            if (isActive) classes.push('rv-para--active')
            if (openParagraph === block.id) classes.push('rv-para--open')

            const pieces = highlightSegments(
              block.segments,
              rangesByParagraph.get(block.id) ?? [],
            )

            return (
              <p
                key={block.id}
                id={block.id}
                data-rv-pid={block.id}
                data-rv-ordinal={block.ordinal}
                className={classes.join(' ')}
                onClick={(event) => {
                  // A tap on one of the paragraph's own controls is that
                  // control's business, not a request to close the row.
                  if ((event.target as HTMLElement).closest('button')) return
                  // Someone selecting text is quoting, not choosing.
                  if ((window.getSelection()?.toString() ?? '').length > 0) return
                  setOpenParagraph((current) => (current === block.id ? null : block.id))
                }}
              >
                {isBookmarked || retiringRibbon === block.id ? (
                  <BookmarkRibbon active={isBookmarked} />
                ) : null}

                {/*
                 * The prose lives in its own element so that a selection's
                 * character offsets are measured against the paragraph's text
                 * alone -- not against the ordinal, the buttons' labels, or
                 * anything else that happens to sit inside the same block.
                 */}
                <span className="rv-para-text">
                  {pieces.map((piece, index) => {
                    const content = (
                      <Marked kind={piece.kind} text={piece.text} within={piece.within} />
                    )

                    if (piece.ids.length === 0) {
                      return <span key={index}>{content}</span>
                    }

                    return (
                      <mark
                        key={index}
                        className="rv-hl"
                        data-rv-an={piece.ids[0]}
                        onClick={(event) => {
                          event.stopPropagation()
                          setOpenAnnotation(piece.ids[0])
                          setSheet('marks')
                        }}
                      >
                        {content}
                      </mark>
                    )
                  })}
                </span>

                <span className="rv-para-tools">
                  <button
                    type="button"
                    className="rv-para-btn"
                    aria-pressed={isBookmarked}
                    disabled={busy}
                    onClick={() => void toggleBookmark(block.id)}
                    aria-label={
                      isBookmarked
                        ? `Remove bookmark from paragraph ${block.ordinal}`
                        : `Bookmark paragraph ${block.ordinal}`
                    }
                  >
                    <IconBookmark filled={isBookmarked} />
                    <span>{isBookmarked ? 'Bookmarked' : 'Bookmark'}</span>
                  </button>
                  {/*
                    * One control, in both voices. It used to be "Comment", it
                    * used to appear only for reviewers, and it used to open a
                    * composer whose Send button wrote something nobody could
                    * take back. It now opens the same composer everything else
                    * opens, already scoped to this paragraph.
                    */}
                  <button
                    type="button"
                    className="rv-para-btn"
                    aria-pressed={isCommented}
                    onClick={() =>
                      openComposer({
                        scope: 'paragraph',
                        passage: null,
                        paragraph: { id: block.id, ordinal: block.ordinal },
                      })
                    }
                    aria-label={`Write a note on paragraph ${block.ordinal}`}
                  >
                    <IconComment />
                    <span>{isCommented ? 'Noted' : 'Note'}</span>
                  </button>
                  <span className="rv-para-count">{block.ordinal}</span>
                </span>
              </p>
            )
          })}
        </article>

        <nav className="rv-endnav" aria-label="Chapter navigation">
          {previousSlug ? (
            <Link
              href={`${bookBase}/${previousSlug}`}
              className="rv-endnav-link"
              onPointerDown={captureBeforeLeaving}
            >
              <IconBack />
              <span>Previous chapter</span>
            </Link>
          ) : (
            <span />
          )}
          <button
            type="button"
            className="rv-btn rv-btn--ghost"
            onClick={() =>
              openComposer({ scope: 'chapter', passage: null, paragraph: null })
            }
          >
            Note on this chapter
          </button>
          {nextSlug ? (
            <Link
              href={`${bookBase}/${nextSlug}`}
              className="rv-endnav-link"
              onPointerDown={captureBeforeLeaving}
            >
              <span>Next chapter</span>
              <IconNext />
            </Link>
          ) : (
            <span />
          )}
        </nav>

        <footer className="rv-foot">
          <span>{book.title}</span>
          <Link href={workspaceHref} onPointerDown={captureBeforeLeaving}>
            My reading
          </Link>
        </footer>
      </div>

      {/* ------------------------------------------------ selection actions */}

      {selection && selectionAt ? (
        <div
          className="rv-sel"
          role="group"
          aria-label="Selected passage"
          style={{ top: `${selectionAt.top}px`, left: `${selectionAt.left}px` }}
        >
          <button
            type="button"
            className="rv-sel-btn"
            disabled={busy}
            onClick={() => {
              const passage = selection
              clearSelection()
              void createAnnotation(passage)
            }}
          >
            <IconHighlight />
            <span>Highlight</span>
          </button>
          <button
            type="button"
            className="rv-sel-btn"
            disabled={busy}
            onClick={() => {
              const passage = selection
              clearSelection()
              openComposer({ scope: 'passage', passage, paragraph: null })
            }}
          >
            <IconComment />
            <span>Note</span>
          </button>
        </div>
      ) : null}

      {/* Thumb-reachable actions on a phone. Hidden once the viewport is wide
          enough for the end-of-chapter navigation to be reachable instead. */}
      <div className="rv-dock">
        {previousSlug ? (
          <Link
            href={`${bookBase}/${previousSlug}`}
            className="rv-icon-btn"
            aria-label="Previous chapter"
            onPointerDown={captureBeforeLeaving}
          >
            <IconBack />
          </Link>
        ) : (
          <span className="rv-icon-btn" aria-hidden="true" />
        )}
        <button
          type="button"
          className="rv-icon-btn"
          onClick={() => setSheet('marks')}
          aria-label={`Bookmarks and notes (${bookmarks.length + annotations.length})`}
        >
          <IconBookmark filled={chapterBookmarks.length > 0} />
        </button>
        <span className="rv-dock-spacer" />
        <button
          type="button"
          className="rv-dock-cta"
          onClick={() => openComposer({ scope: 'chapter', passage: null, paragraph: null })}
        >
          <IconComment />
          <span>Note</span>
        </button>
        <span className="rv-dock-spacer" />
        {nextSlug ? (
          <Link
            href={`${bookBase}/${nextSlug}`}
            className="rv-icon-btn"
            aria-label="Next chapter"
            onPointerDown={captureBeforeLeaving}
          >
            <IconNext />
          </Link>
        ) : (
          <span className="rv-icon-btn" aria-hidden="true" />
        )}
      </div>

      {/* ------------------------------------------------------- contents */}

      {/*
        * Picking a chapter from the contents **replaces** this one in history
        * rather than stacking on top of it.
        *
        * The contents is a menu, and a menu is not a place you travelled to. It
        * used to push, so a reviewer who opened chapter two from inside chapter
        * one found that the phone's Back button returned them to chapter one --
        * and, after sampling a few chapters, walked them back through every one
        * of them instead of returning to the book. Mike reported exactly that.
        *
        * With `replace`, Back always means "out of the reading, back to where I
        * came into this book from", which is the only thing it can usefully mean
        * from inside a chapter.
        *
        * The Previous/Next links at the foot of a chapter still push, and should:
        * reading on to the next chapter is a journey, and going back from it to
        * the chapter you just finished is the right answer there.
        */}
      <Sheet open={sheet === 'contents'} onClose={closeSheet} title="Chapters">
        {contents.map((entry) => (
          <Link
            key={entry.slug}
            href={`${bookBase}/${entry.slug}`}
            replace
            className="rv-toc-item"
            aria-current={entry.slug === chapter.slug ? 'true' : undefined}
            onClick={closeSheet}
            onPointerDown={captureBeforeLeaving}
          >
            <span className="rv-toc-n">{entry.number}</span>
            <span className="rv-toc-text">
              <span className="rv-toc-label">{entry.label}</span>
              {entry.subtitle ? <span className="rv-toc-sub">{entry.subtitle}</span> : null}
            </span>
            <span className="rv-toc-meta">{entry.minutes} min</span>
          </Link>
        ))}
      </Sheet>

      {/* ------------------------------------------- how reading works */}

      <Sheet open={sheet === 'help'} onClose={closeSheet} title="How reading works">
        <ReadingHelp voice={voice} defaultOpen heading={false} />
      </Sheet>

      {/* -------------------------------------------- bookmarks and notes */}

      <Sheet open={sheet === 'marks'} onClose={closeSheet} title="Bookmarks and notes">
        <div className="rv-marks-top">
          <Link
            href={workspaceHref}
            className="rv-btn rv-btn--ghost"
            onClick={closeSheet}
            onPointerDown={captureBeforeLeaving}
          >
            Everything in my reading
          </Link>
        </div>

        <div className="rv-field">
          <span className="rv-field-label">
            Bookmarks in {book.title} ({bookmarks.length})
          </span>
          {bookmarks.length === 0 ? (
            <p className="rv-empty rv-empty--tight">
              No bookmarks yet. Tap a paragraph and choose Bookmark.
            </p>
          ) : (
            bookmarks.map((bookmark) => (
              <div key={bookmark.id} className="rv-mark-row">
                <button
                  type="button"
                  className="rv-mark-go"
                  onClick={() => {
                    closeSheet()
                    if (bookmark.chapterSlug === chapter.slug) {
                      scrollToParagraph(bookmark.paragraphId, 'smooth')
                    } else {
                      window.location.href = `${bookBase}/${bookmark.chapterSlug}#${bookmark.paragraphId}`
                    }
                  }}
                >
                  <span className="rv-mark-where">
                    {bookmark.chapterLabel} · paragraph {bookmark.paragraphOrdinal}
                  </span>
                  <span className="rv-mark-text">{bookmark.excerpt}</span>
                  {bookmark.anchorState === 'ok' ? null : (
                    <span className="rv-mark-flag">
                      This paragraph is no longer in the manuscript — needs relocating.
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="rv-icon-btn rv-icon-btn--quiet"
                  disabled={busy}
                  onClick={() => void removeBookmarkById(bookmark.id)}
                  aria-label={`Remove bookmark at ${bookmark.chapterLabel} paragraph ${bookmark.paragraphOrdinal}`}
                >
                  <IconTrash />
                </button>
              </div>
            ))
          )}
        </div>

        {/* ------------------------------------------------------- notes */}

        <div className="rv-field">
          <div className="rv-notes-head">
            <span className="rv-field-label">
              Notes in {chapter.label} ({chapterNotes.length})
            </span>
            {/*
              * The whole-book scope, which only Mike has. It lives here rather
              * than beside the chapter action because a note about the book is
              * not a thing you reach for while reading one paragraph.
              */}
            {isReviewer ? null : (
              <button
                type="button"
                className="rv-btn rv-btn--ghost"
                onClick={() => {
                  closeSheet()
                  openComposer({ scope: 'book', passage: null, paragraph: null })
                }}
              >
                Note on the whole book
              </button>
            )}
          </div>

          {chapterNotes.length === 0 ? (
            <p className="rv-empty rv-empty--tight">
              Nothing written here yet. Select any words, or tap a paragraph, to start a note.
            </p>
          ) : (
            chapterNotes.map((note) => (
              <div
                key={note.id}
                className={`rv-mark-row rv-mark-row--stack ${
                  openNote === note.id ? 'is-open' : ''
                } ${note.status === 'resolved' ? 'is-resolved' : ''}`}
              >
                <button
                  type="button"
                  className="rv-mark-go"
                  onClick={() => setOpenNote((current) => (current === note.id ? null : note.id))}
                >
                  <span className="rv-mark-where">
                    {noteWhere(note, chapter.label)}
                    {/*
                      * Said the same way in both voices: what it says is who can
                      * read it, not which control was pressed. Mike's own notes
                      * say "private to you" and never offer to be shared.
                      */}
                    {` · ${visibilityLabel(voice, note.visibility)}`}
                    {!isReviewer && note.status === 'resolved' ? ' · resolved' : ''}
                  </span>
                  {noteCaptured(note) ? (
                    <span className="rv-mark-quote">“{noteCaptured(note)}”</span>
                  ) : null}
                  <span className="rv-mark-text">{note.body}</span>
                  {note.anchorState === 'needs-relocation' ? (
                    <span className="rv-mark-flag">
                      The manuscript has changed here. This is the passage as it was when you
                      wrote — it needs relocating, and is not shown in the text.
                    </span>
                  ) : null}
                </button>

                {openNote === note.id ? (
                  <div className="rv-mark-detail">
                    <div className="rv-mark-actions">
                      <button
                        type="button"
                        className="rv-btn rv-btn--ghost"
                        disabled={note.paragraphId === null}
                        onClick={() => {
                          closeSheet()
                          if (note.paragraphId) scrollToParagraph(note.paragraphId, 'smooth')
                        }}
                      >
                        Go to passage
                      </button>
                      <button
                        type="button"
                        className="rv-btn rv-btn--ghost"
                        disabled={busy}
                        onClick={() => openComposerForEdit(note)}
                      >
                        Edit
                      </button>
                      {/*
                        * Post-save only, by construction: this row exists only
                        * for a note that is already stored. The composer has no
                        * such control, and this is not a visibility choice --
                        * see `NoteLink`.
                        */}
                      <button
                        type="button"
                        className="rv-btn rv-btn--ghost"
                        aria-pressed={noteLinkFor === note.id}
                        onClick={() =>
                          setNoteLinkFor((current) => (current === note.id ? null : note.id))
                        }
                      >
                        {NOTE_LINK_LABEL}
                      </button>
                      {isReviewer ? null : (
                        <button
                          type="button"
                          className="rv-btn rv-btn--ghost"
                          disabled={busy}
                          onClick={() =>
                            void changeNoteStatus(
                              note.id,
                              note.revision,
                              note.status === 'resolved' ? 'open' : 'resolved',
                            )
                          }
                        >
                          {note.status === 'resolved' ? 'Reopen' : 'Resolve'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="rv-btn rv-btn--danger"
                        disabled={busy}
                        onClick={() => void removeNoteById(note.id)}
                      >
                        {removeLabel(voice, note.visibility)}
                      </button>
                    </div>
                    {noteLinkFor === note.id ? <NoteLink voice={voice} note={note} /> : null}
                    {isReviewer ? (
                      <div className="rv-share">
                        <span className="rv-field-label" id={`rv-note-share-${note.id}`}>
                          Who can see this
                        </span>
                        <NoteVisibilityControl
                          value={note.visibility}
                          busy={busy}
                          labelledBy={`rv-note-share-${note.id}`}
                          onChange={(visibility) =>
                            void changeNoteVisibility(note.id, note.revision, visibility)
                          }
                        />
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>

        {/* -------------------------------------------------- highlights */}

        <div className="rv-field">
          <span className="rv-field-label">
            Highlights in {chapter.label} ({chapterAnnotations.length})
          </span>
          {chapterAnnotations.length === 0 ? (
            <p className="rv-empty rv-empty--tight">
              Nothing highlighted in this chapter yet. Select any words and choose Highlight.
            </p>
          ) : (
            chapterAnnotations.map((annotation) => (
              <div
                key={annotation.id}
                className={`rv-mark-row rv-mark-row--stack ${
                  openAnnotation === annotation.id ? 'is-open' : ''
                }`}
              >
                <button
                  type="button"
                  className="rv-mark-go"
                  onClick={() =>
                    setOpenAnnotation((current) =>
                      current === annotation.id ? null : annotation.id,
                    )
                  }
                >
                  <span className="rv-mark-where">
                    paragraph {annotation.paragraphOrdinal}
                    {annotation.visibility === 'private' ? '' : ' · shared'}
                  </span>
                  <span className="rv-mark-quote">“{annotation.quote}”</span>
                  {annotation.note ? (
                    <span className="rv-mark-text">{annotation.note}</span>
                  ) : null}
                  {annotation.anchorState === 'ok' ? null : (
                    <span className="rv-mark-flag">
                      The manuscript has changed here. This is the passage as it was saved —
                      it needs relocating, and is not shown in the text.
                    </span>
                  )}
                </button>

                {openAnnotation === annotation.id ? (
                  <div className="rv-mark-detail">
                    <div className="rv-mark-actions">
                      <button
                        type="button"
                        className="rv-btn rv-btn--ghost"
                        disabled={annotation.anchorState !== 'ok'}
                        onClick={() => {
                          closeSheet()
                          scrollToParagraph(annotation.paragraphId, 'smooth')
                        }}
                      >
                        Go to passage
                      </button>
                      <button
                        type="button"
                        className="rv-btn rv-btn--danger"
                        disabled={busy}
                        onClick={() => void removeAnnotationById(annotation.id)}
                      >
                        Delete
                      </button>
                    </div>
                    <SharingControl
                      annotation={annotation}
                      busy={busy}
                      onChange={(visibility) => void changeSharing(annotation.id, visibility)}
                    />
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>

        {/* ------------------------------------ earlier submitted comments */}

        {/*
          * The retired model, kept readable and labelled as what it is.
          *
          * A reviewer who submitted comments before notes existed still has
          * them, and they still say what that reviewer said. There is no
          * control here to edit or remove one, because there never was: that
          * is the property of the old model the note contract replaced, and
          * pretending otherwise now would be a worse answer than naming it.
          */}
        {isReviewer && mine.length > 0 ? (
          <div className="rv-field">
            <span className="rv-field-label">
              Earlier submitted comments in {chapter.label} ({mine.length})
            </span>
            <p className="rv-empty rv-empty--tight">
              Submitted before notes existed. Mike has these, and they cannot be edited or
              withdrawn. Anything new you write is a note.
            </p>
            {mine.map((entry) => (
              <p key={entry.id} className="rv-prior-item">
                <span className="rv-prior-when">
                  {entry.paragraphId
                    ? `Paragraph ${entry.paragraphId.split('-p')[1]}`
                    : 'Chapter'}
                  {' · '}
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
                {entry.comment}
              </p>
            ))}
          </div>
        ) : null}
      </Sheet>

      {/* ------------------------------------------------- the one composer */}

      {/*
        * One composer, one save row.
        *
        * Everything anybody writes about this manuscript is written here: a
        * note about selected words, about a paragraph, about the chapter, or
        * -- for Mike -- about the whole book. The scope is a control inside the
        * composer rather than a choice of which composer to open, so changing
        * your mind about how much of the book you are talking about does not
        * mean starting again somewhere else.
        *
        * There is no second save. The Send button that used to sit beside this
        * one wrote a comment that could never be corrected or withdrawn, and
        * nothing on the screen said so.
        */}
      <Sheet
        open={sheet === 'note'}
        onClose={closeSheet}
        title={composerTitle(Boolean(editingNote))}
      >
        {composer?.scope === 'passage' && composer.passage ? (
          <blockquote className="rv-quote">
            <span className="rv-quote-tag">
              {chapter.label} · paragraph {composer.passage.ordinal}
            </span>
            {composer.passage.quote}
          </blockquote>
        ) : null}

        {composer?.scope === 'paragraph' && composerParagraph ? (
          <blockquote className="rv-quote">
            <span className="rv-quote-tag">
              {chapter.label} · paragraph {composerParagraph.ordinal}
            </span>
            {composerParagraph.segments.map((segment, index) => (
              <Marked
                key={index}
                kind={segment.kind}
                text={segment.text}
                within={segment.within}
              />
            ))}
          </blockquote>
        ) : null}

        {outcome && !outcome.ok ? (
          <p className="rv-note rv-note--bad" role="alert">
            {outcome.message}
          </p>
        ) : null}

        {/*
          * Scope is only offered where there is a real choice. Editing an
          * existing note does not offer it at all: the anchor is written once,
          * and re-scoping a note after the fact would mean re-attaching it to
          * somewhere it was not written about.
          */}
        {composer && !editingNote && availableScopes.length > 1 ? (
          <div className="rv-field">
            <span className="rv-field-label" id="rv-note-scope">
              What this note is about
            </span>
            <div className="rv-segments" role="group" aria-labelledby="rv-note-scope">
              {availableScopes.map((scope) => (
                <button
                  key={scope}
                  type="button"
                  className="rv-segment"
                  aria-pressed={composer.scope === scope}
                  onClick={() => setComposer({ ...composer, scope })}
                >
                  {SCOPE_LABELS[scope]}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="rv-sheet-pad">
          <label className="rv-visually-hidden" htmlFor="rv-note-text">
            Your note
          </label>
          <textarea
            id="rv-note-text"
            className="rv-textarea"
            value={noteText}
            maxLength={MAX_NOTE_LENGTH}
            onChange={(event) => setNoteText(event.target.value)}
            placeholder={
              isReviewer
                ? 'What did you notice? Mike will read this if you share it.'
                : 'What do you want to remember about this?'
            }
          />
        </div>

        <div className="rv-field">
          <span className="rv-field-label" id="rv-note-share">
            Who can see this
          </span>
          {isReviewer ? (
            <NoteVisibilityControl
              value={noteVisibility}
              busy={busy}
              labelledBy="rv-note-share"
              onChange={setNoteVisibility}
            />
          ) : (
            /*
              * Mike is never shown a sharing control, and never a "Share with
              * Mike" segment. There is no state in which one of his notes
              * reaches a reviewer, so a control offering it would be offering
              * something that does not exist.
              */
            <p className="rv-share-hint">{AUTHOR_PRIVACY_LINE}</p>
          )}
        </div>

        <div className="rv-sheet-actions">
          <span className={`rv-count ${noteRemaining < 0 ? 'rv-count--over' : ''}`}>
            {noteRemaining.toLocaleString()} left
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" className="rv-btn rv-btn--ghost" onClick={closeSheet}>
            Cancel
          </button>
          <button
            type="button"
            className="rv-btn rv-btn--primary"
            disabled={busy || !composer || noteText.trim().length === 0 || noteRemaining < 0}
            onClick={() => {
              // What a save that succeeded does next is the composer's own
              // `finished` effect, so there is nothing to decide out here.
              void submitComposer()
            }}
          >
            {busy ? 'Saving…' : saveLabel(Boolean(editingNote))}
          </button>
        </div>
      </Sheet>

      {/* ----------------------------------------------------- appearance */}

      <Sheet open={sheet === 'type'} onClose={closeSheet} title="Appearance">
        <div className="rv-field">
          <span className="rv-field-label" id="rv-theme-label">
            Theme
          </span>
          <div className="rv-segments" role="group" aria-labelledby="rv-theme-label">
            {(['system', 'light', 'sepia', 'dark'] as Theme[]).map((theme) => (
              <button
                key={theme}
                type="button"
                className="rv-segment"
                aria-pressed={preferences.theme === theme}
                onClick={() => updatePreferences({ ...preferences, theme })}
              >
                {theme === 'system' ? 'Auto' : theme[0].toUpperCase() + theme.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="rv-field">
          <span className="rv-field-label" id="rv-size-label">
            Text size
          </span>
          <div className="rv-segments" role="group" aria-labelledby="rv-size-label">
            {Array.from({ length: SIZE_STEPS }, (_, size) => (
              <button
                key={size}
                type="button"
                className={`rv-segment rv-segment--a s${size}`}
                aria-pressed={preferences.size === size}
                aria-label={`Text size ${size + 1} of ${SIZE_STEPS}`}
                onClick={() => updatePreferences({ ...preferences, size })}
              >
                A
              </button>
            ))}
          </div>
        </div>
      </Sheet>

    </>
  )
}
