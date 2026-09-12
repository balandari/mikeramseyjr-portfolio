'use client'

import Link from 'next/link'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import BookmarkRibbon from '@/components/motion/BookmarkRibbon'
import { highlightSegments } from '@/lib/reading-anchor'
import ReadingHelp from '@/components/reader/ReadingHelp'

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
import {
  beaconPosition,
  deleteAnnotation,
  deleteBookmark,
  saveAnnotation,
  saveBookmark,
  savePositionQuietly,
  updateAnnotationRecord,
  type ClientAnnotation,
  type ClientBookmark,
  type ClientPosition,
  type ReadingEndpoint,
  type Visibility,
} from '../../reading-client'

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
 *   **Annotations** are a selected passage -- words, a sentence, a paragraph --
 *   with an optional note, anchored by paragraph and character offsets and
 *   carrying the quotation and the chapter's fingerprint.
 *
 *   **Feedback** is a comment submitted to Mike about a paragraph or a chapter.
 *   It is durable history and is never rewritten from here.
 *
 * The same component serves the author's reader. What changes is the endpoint
 * it writes to and whether feedback is offered at all -- nothing about the
 * prose, and nothing about how a passage is identified.
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

type FeedbackTarget =
  | { scope: 'chapter'; paragraphId: null; ordinal: null }
  | { scope: 'paragraph'; paragraphId: string; ordinal: number }

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

/** Longest comment the server will accept. Mirrored here only to show a count. */
const MAX_COMMENT_LENGTH = 4000

/** Longest note the server will accept on an annotation. */
const MAX_NOTE_LENGTH = 4000

/** How often the automatic position may be written back, in milliseconds. */
const POSITION_INTERVAL_MS = 8000

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
function scrollToParagraph(id: string, behavior: ScrollBehavior): boolean {
  const element = document.getElementById(id)
  if (!element) return false

  const wanted: ScrollBehavior =
    behavior === 'smooth' && !prefersReducedMotion() ? 'smooth' : 'auto'

  const top = element.getBoundingClientRect().top + window.scrollY - headerOffset()
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

export default function ChapterReader({
  namespace,
  endpoint,
  bookBase,
  workspaceHref,
  feedbackEnabled,
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
   * Whether to offer reviewer feedback. False for the author: submitting
   * reviewer feedback as the author is exactly the contamination the separate
   * namespace exists to prevent, so the control is not rendered and the
   * endpoint is not called.
   */
  feedbackEnabled: boolean
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
  }
}) {
  const [preferences, setPreferences] = useState<Preferences>({
    theme: DEFAULT_THEME,
    size: DEFAULT_SIZE,
  })
  const [bookmarks, setBookmarks] = useState<ClientBookmark[]>(initial.bookmarks)
  const [annotations, setAnnotations] = useState<ClientAnnotation[]>(initial.annotations)
  const [sheet, setSheet] = useState<
    'contents' | 'type' | 'feedback' | 'marks' | 'note' | 'help' | null
  >(
    null,
  )
  const [target, setTarget] = useState<FeedbackTarget | null>(null)
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null)
  const [mine, setMine] = useState<StoredFeedback[]>([])
  const [progress, setProgress] = useState(0)
  const [busy, setBusy] = useState(false)

  /** The live text selection, and where its floating action row should sit. */
  const [selection, setSelection] = useState<SelectionTarget | null>(null)
  const [selectionAt, setSelectionAt] = useState<{ top: number; left: number } | null>(null)

  /** The passage a note is being written about, and the note itself. */
  const [noteFor, setNoteFor] = useState<SelectionTarget | null>(null)
  const [noteText, setNoteText] = useState('')
  const [noteVisibility, setNoteVisibility] = useState<Visibility>('private')

  /** The annotation whose detail is open in the marks sheet. */
  const [openAnnotation, setOpenAnnotation] = useState<string | null>(null)

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
    scrollToParagraph(mark, 'auto')

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
      scrollToParagraph(mark, 'auto')
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

    function remember(paragraphId: string) {
      pendingParagraphRef.current = paragraphId
      const now = Date.now()
      // At most one write every few seconds. The position is a convenience, not
      // a telemetry stream, and a request per scroll tick would be both.
      if (now - lastSentAtRef.current < POSITION_INTERVAL_MS) return
      lastSentAtRef.current = now
      void savePositionQuietly(endpoint, {
        bookSlug: book.slug,
        chapterSlug: chapter.slug,
        paragraphId,
      })
    }

    function measure(persist: boolean) {
      const article = articleRef.current
      if (article) {
        const height = article.scrollHeight - window.innerHeight
        const ratio = height > 0 ? window.scrollY / height : 1
        setProgress(Math.min(1, Math.max(0, ratio)))
      }

      // The progress bar is free to follow anything. A saved position is not:
      // it survives the session and decides where the next visit opens.
      if (!persist || !hasScrolledRef.current) return

      // The topmost paragraph still in view is where the reader is.
      let current: string | null = null
      const ceiling = headerOffset()
      for (const element of paragraphsRef.current) {
        if (element.getBoundingClientRect().bottom > ceiling) {
          current = element.dataset.rvPid ?? null
          break
        }
      }

      // The first paragraph is never worth remembering. It is what the top of
      // the chapter looks like, and a mark for it would only ever be used to
      // scroll past the title to reach it -- which is where this came in.
      if (current && current === (paragraphsRef.current[0]?.dataset.rvPid ?? null)) return

      if (current && current !== lastSavedRef.current) {
        lastSavedRef.current = current
        remember(current)
      }
    }

    function schedule(persist: boolean) {
      // At most once every 150ms, and always on a frame boundary: keeping a
      // place is not worth a dropped frame on a phone.
      if (timer !== null || raf !== null) return
      timer = window.setTimeout(() => {
        timer = null
        raf = window.requestAnimationFrame(() => {
          raf = null
          measure(persist)
        })
      }, 150)
    }

    function onScroll() {
      // The reviewer moved the page themselves. From here on, where they stop
      // is worth remembering.
      hasScrolledRef.current = true
      schedule(true)
    }

    // A resize re-measures so the progress bar stays honest, but it is the
    // window changing shape, not somebody reading, so it records nothing.
    function onResize() {
      schedule(false)
    }

    /*
     * The last position is the one that matters most and is the easiest to
     * lose: it is where they were when they closed the tab. `pagehide` is the
     * event that actually fires on a phone -- `beforeunload` does not, reliably,
     * when an app is swiped away -- and the write goes out as a beacon so the
     * browser delivers it after the page is gone.
     */
    function onLeave() {
      const paragraphId = pendingParagraphRef.current
      if (!paragraphId || !hasScrolledRef.current) return
      beaconPosition(endpoint, {
        bookSlug: book.slug,
        chapterSlug: chapter.slug,
        paragraphId,
      })
    }

    // The first measurement is for the progress bar alone.
    measure(false)
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onResize, { passive: true })
    window.addEventListener('pagehide', onLeave)
    document.addEventListener('visibilitychange', onLeave)

    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pagehide', onLeave)
      document.removeEventListener('visibilitychange', onLeave)
      onLeave()
      if (timer !== null) window.clearTimeout(timer)
      if (raf !== null) window.cancelAnimationFrame(raf)
    }
  }, [endpoint, book.slug, chapter.slug])

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

  /* ------------------------------------------------------------ feedback */

  const refreshMine = useCallback(async () => {
    if (!feedbackEnabled) return
    try {
      const response = await fetch(
        `/review/api/feedback?book=${encodeURIComponent(book.slug)}`,
        { credentials: 'same-origin' },
      )
      if (!response.ok) return
      const body = (await response.json()) as { entries?: StoredFeedback[] }
      setMine((body.entries ?? []).filter((entry) => entry.chapterSlug === chapter.slug))
    } catch {
      // The reader works without it; this only decorates paragraphs already
      // commented on.
    }
  }, [book.slug, chapter.slug, feedbackEnabled])

  useEffect(() => {
    void refreshMine()
  }, [refreshMine])

  const commented = new Set(
    mine.filter((entry) => entry.paragraphId).map((entry) => entry.paragraphId as string),
  )

  const openFeedback = useCallback((next: FeedbackTarget) => {
    setTarget(next)
    setComment('')
    setOutcome(null)
    setSheet('feedback')
  }, [])

  async function submitFeedback() {
    if (!target || sending) return
    const text = comment.trim()
    if (text.length === 0 || text.length > MAX_COMMENT_LENGTH) return

    setSending(true)
    setOutcome(null)

    try {
      const response = await fetch('/review/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          bookSlug: book.slug,
          chapterSlug: chapter.slug,
          scope: target.scope,
          paragraphId: target.paragraphId,
          comment: text,
        }),
      })

      if (response.status === 201) {
        setComment('')
        setOutcome({ ok: true, message: 'Saved. Thank you.' })
        void refreshMine()
      } else if (response.status === 503) {
        // Say plainly that it was not kept. Never pretend, and never fall back
        // to writing it into this browser instead.
        setOutcome({
          ok: false,
          message:
            'Feedback storage is not configured on this deployment, so this comment was NOT saved. Please copy it somewhere safe and let Mike know.',
        })
      } else if (response.status === 401) {
        setOutcome({
          ok: false,
          message: 'Your session has ended. Reload the page and sign in again.',
        })
      } else {
        setOutcome({ ok: false, message: 'That could not be saved. Please try again.' })
      }
    } catch {
      setOutcome({
        ok: false,
        message: 'That could not be saved — you may be offline. Please try again.',
      })
    } finally {
      setSending(false)
    }
  }

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

  const createAnnotation = useCallback(
    async (passage: SelectionTarget, note: string | null, visibility: Visibility) => {
      if (busy) return false
      setBusy(true)
      setOutcome(null)

      const result = await saveAnnotation(endpoint, {
        bookSlug: book.slug,
        chapterSlug: chapter.slug,
        paragraphId: passage.paragraphId,
        startOffset: passage.start,
        endOffset: passage.end,
        note,
        visibility,
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

  const targetQuote =
    target?.scope === 'paragraph'
      ? blocks.find(
          (block): block is Extract<ReaderClientBlock, { kind: 'paragraph' }> =>
            block.kind === 'paragraph' && block.id === target.paragraphId,
        )
      : undefined

  const remaining = MAX_COMMENT_LENGTH - comment.length
  const noteRemaining = MAX_NOTE_LENGTH - noteText.length

  const chapterAnnotations = annotations.filter(
    (annotation) => annotation.chapterSlug === chapter.slug,
  )

  return (
    <>
      <header className="rv-bar">
        <Link href={bookBase} className="rv-icon-btn" aria-label="Contents">
          <IconBack />
        </Link>
        {/* `title` so the full label is available where the bar has to clip it. */}
        <span className="rv-bar-title" title={chapter.label}>
          {chapter.label}
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
            Select any words to highlight them or add a note. Tap a paragraph to bookmark it
            {feedbackEnabled ? ' or send Mike a comment' : ''}.
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
            const isCommented = commented.has(block.id)
            const isActive = target?.paragraphId === block.id && sheet === 'feedback'

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
                  {feedbackEnabled ? (
                    <button
                      type="button"
                      className="rv-para-btn"
                      aria-pressed={isCommented}
                      onClick={() =>
                        openFeedback({
                          scope: 'paragraph',
                          paragraphId: block.id,
                          ordinal: block.ordinal,
                        })
                      }
                      aria-label={`Comment on paragraph ${block.ordinal}`}
                    >
                      <IconComment />
                      <span>{isCommented ? 'Commented' : 'Comment'}</span>
                    </button>
                  ) : null}
                  <span className="rv-para-count">{block.ordinal}</span>
                </span>
              </p>
            )
          })}
        </article>

        <nav className="rv-endnav" aria-label="Chapter navigation">
          {previousSlug ? (
            <Link href={`${bookBase}/${previousSlug}`} className="rv-endnav-link">
              <IconBack />
              <span>Previous chapter</span>
            </Link>
          ) : (
            <span />
          )}
          {feedbackEnabled ? (
            <button
              type="button"
              className="rv-btn rv-btn--ghost"
              onClick={() => openFeedback({ scope: 'chapter', paragraphId: null, ordinal: null })}
            >
              Comment on this chapter
            </button>
          ) : (
            <span />
          )}
          {nextSlug ? (
            <Link href={`${bookBase}/${nextSlug}`} className="rv-endnav-link">
              <span>Next chapter</span>
              <IconNext />
            </Link>
          ) : (
            <span />
          )}
        </nav>

        <footer className="rv-foot">
          <span>{book.title}</span>
          <Link href={workspaceHref}>My reading</Link>
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
              void createAnnotation(passage, null, 'private')
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
              setNoteFor(selection)
              setNoteText('')
              setNoteVisibility('private')
              setOutcome(null)
              clearSelection()
              setSheet('note')
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
        {feedbackEnabled ? (
          <button
            type="button"
            className="rv-dock-cta"
            onClick={() => openFeedback({ scope: 'chapter', paragraphId: null, ordinal: null })}
          >
            <IconComment />
            <span>Comment</span>
          </button>
        ) : (
          <Link href={workspaceHref} className="rv-dock-cta">
            <IconHighlight />
            <span>My reading</span>
          </Link>
        )}
        <span className="rv-dock-spacer" />
        {nextSlug ? (
          <Link
            href={`${bookBase}/${nextSlug}`}
            className="rv-icon-btn"
            aria-label="Next chapter"
          >
            <IconNext />
          </Link>
        ) : (
          <span className="rv-icon-btn" aria-hidden="true" />
        )}
      </div>

      {/* ------------------------------------------------------- contents */}

      <Sheet open={sheet === 'contents'} onClose={closeSheet} title="Chapters">
        {contents.map((entry) => (
          <Link
            key={entry.slug}
            href={`${bookBase}/${entry.slug}`}
            className="rv-toc-item"
            aria-current={entry.slug === chapter.slug ? 'true' : undefined}
            onClick={closeSheet}
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
        <ReadingHelp voice={feedbackEnabled ? 'reviewer' : 'author'} defaultOpen heading={false} />
      </Sheet>

      {/* -------------------------------------------- bookmarks and notes */}

      <Sheet open={sheet === 'marks'} onClose={closeSheet} title="Bookmarks and notes">
        <div className="rv-marks-top">
          <Link href={workspaceHref} className="rv-btn rv-btn--ghost" onClick={closeSheet}>
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

        <div className="rv-field">
          <span className="rv-field-label">
            Highlights and notes in {chapter.label} ({chapterAnnotations.length})
          </span>
          {chapterAnnotations.length === 0 ? (
            <p className="rv-empty rv-empty--tight">
              Nothing highlighted in this chapter yet. Select any words to start.
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
      </Sheet>

      {/* ------------------------------------------------------------ note */}

      <Sheet
        open={sheet === 'note'}
        onClose={closeSheet}
        title={noteFor ? `Note on paragraph ${noteFor.ordinal}` : 'Note'}
      >
        {noteFor ? (
          <blockquote className="rv-quote">
            <span className="rv-quote-tag">
              {chapter.label} · paragraph {noteFor.ordinal}
            </span>
            {noteFor.quote}
          </blockquote>
        ) : null}

        {outcome && !outcome.ok ? (
          <p className="rv-note rv-note--bad" role="alert">
            {outcome.message}
          </p>
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
            placeholder="What did you notice about this passage? (optional)"
          />
        </div>

        <div className="rv-field">
          <span className="rv-field-label" id="rv-note-share">
            Who can see this
          </span>
          <div className="rv-segments rv-segments--share" role="group" aria-labelledby="rv-note-share">
            {SHARING.map((option) => (
              <button
                key={option.value}
                type="button"
                className="rv-segment"
                aria-pressed={noteVisibility === option.value}
                onClick={() => setNoteVisibility(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="rv-share-hint">
            {SHARING.find((option) => option.value === noteVisibility)?.hint}
          </p>
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
            disabled={busy || !noteFor || noteRemaining < 0}
            onClick={() => {
              if (!noteFor) return
              void createAnnotation(
                noteFor,
                noteText.trim() === '' ? null : noteText.trim(),
                noteVisibility,
              ).then((saved) => {
                if (saved) {
                  setNoteFor(null)
                  setNoteText('')
                  closeSheet()
                }
              })
            }}
          >
            {busy ? 'Saving…' : 'Save note'}
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

      {/* ------------------------------------------------------- feedback */}

      {feedbackEnabled ? (
        <Sheet
          open={sheet === 'feedback'}
          onClose={closeSheet}
          title={
            target?.scope === 'paragraph'
              ? `Comment on paragraph ${target.ordinal}`
              : `Comment on ${chapter.label}`
          }
        >
          {targetQuote ? (
            <blockquote className="rv-quote">
              <span className="rv-quote-tag">
                {chapter.label} · paragraph {target?.ordinal}
              </span>
              {targetQuote.segments.map((segment, index) => (
                <Marked
                  key={index}
                  kind={segment.kind}
                  text={segment.text}
                  within={segment.within}
                />
              ))}
            </blockquote>
          ) : null}

          {outcome ? (
            <p
              className={`rv-note ${outcome.ok ? 'rv-note--ok' : 'rv-note--bad'}`}
              role={outcome.ok ? 'status' : 'alert'}
            >
              {outcome.message}
            </p>
          ) : null}

          <div className="rv-sheet-pad">
            <label className="rv-visually-hidden" htmlFor="rv-comment">
              Your comment
            </label>
            <textarea
              id="rv-comment"
              className="rv-textarea"
              value={comment}
              maxLength={MAX_COMMENT_LENGTH}
              onChange={(event) => setComment(event.target.value)}
              placeholder={
                target?.scope === 'paragraph'
                  ? 'What did you notice here?'
                  : 'How did this chapter land?'
              }
            />
          </div>

          <div className="rv-sheet-actions">
            <span className={`rv-count ${remaining < 0 ? 'rv-count--over' : ''}`}>
              {remaining.toLocaleString()} left
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" className="rv-btn rv-btn--ghost" onClick={closeSheet}>
              Close
            </button>
            <button
              type="button"
              className="rv-btn rv-btn--primary"
              disabled={sending || comment.trim().length === 0 || remaining < 0}
              onClick={() => void submitFeedback()}
            >
              {sending ? 'Saving…' : 'Send'}
            </button>
          </div>

          {mine.length > 0 ? (
            <div className="rv-prior">
              <span className="rv-field-label">
                Your notes on {chapter.label} ({mine.length})
              </span>
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
      ) : null}
    </>
  )
}
