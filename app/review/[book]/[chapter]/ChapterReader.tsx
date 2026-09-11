'use client'

import Link from 'next/link'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import {
  DEFAULT_SIZE,
  DEFAULT_THEME,
  SIZE_STEPS,
  applyAppearance,
  readBookmarks,
  readChapterPosition,
  readPreferences,
  writeBookmarks,
  writePosition,
  writePreferences,
  type Bookmarks,
  type Preferences,
  type Theme,
} from '../../reader-storage'

/*
 * The reading surface.
 *
 * It receives already-parsed blocks and never the manuscript's plain text: a
 * paragraph arrives as its inline segments plus its identifier, and the exact
 * passage a comment is about is resolved on the server from that identifier.
 *
 * Three things are this component's job beyond rendering prose well: keeping
 * the reviewer's place without being asked, giving them a visible way to mark a
 * paragraph, and letting them say something about a specific passage. Nothing
 * here watches what they read -- no timings, no dwell, no events. The only
 * thing written to the server is a comment they deliberately submitted.
 */

type InlineSegment = { kind: 'text' | 'emphasis'; text: string }

export type ReaderClientBlock =
  | {
      kind: 'paragraph'
      id: string
      ordinal: number
      dateline: boolean
      segments: InlineSegment[]
    }
  | { kind: 'scene-break'; id: string }

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

/** Height of the sticky header, in px. Scroll targets are offset by it. */
const HEADER_OFFSET = 64

/** Space the fixed bottom dock occupies, plus a little breathing room. */
const DOCK_CLEARANCE = 76

/** Longest comment the server will accept. Mirrored here only to show a count. */
const MAX_COMMENT_LENGTH = 4000

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

function scrollToParagraph(id: string, behavior: ScrollBehavior): boolean {
  const element = document.getElementById(id)
  if (!element) return false

  const top = element.getBoundingClientRect().top + window.scrollY - HEADER_OFFSET
  window.scrollTo({
    top: top < 0 ? 0 : top,
    behavior: behavior === 'smooth' && prefersReducedMotion() ? 'auto' : behavior,
  })
  return true
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
     * typing. A sheet with nothing to write in -- Contents, Appearance --
     * still starts at its first focusable element, as before.
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

/* -------------------------------------------------------------------- reader */

export default function ChapterReader({
  namespace,
  book,
  chapter,
  blocks,
  contents,
  previousSlug,
  nextSlug,
}: {
  namespace: string
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
}) {
  const [preferences, setPreferences] = useState<Preferences>({
    theme: DEFAULT_THEME,
    size: DEFAULT_SIZE,
  })
  const [bookmarks, setBookmarks] = useState<Bookmarks>({})
  const [sheet, setSheet] = useState<'contents' | 'type' | 'feedback' | null>(null)
  const [target, setTarget] = useState<FeedbackTarget | null>(null)
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null)
  const [mine, setMine] = useState<StoredFeedback[]>([])
  const [progress, setProgress] = useState(0)
  /*
   * Which paragraph is showing its controls.
   *
   * A permanent control row under all 117 paragraphs of a chapter makes the
   * prose unreadable, and a hidden long-press makes the controls undiscoverable.
   * So: tapping a paragraph opens its row, the hint under the chapter title says
   * so in as many words, and a paragraph that is already bookmarked or already
   * commented on keeps its row open so it can always be undone. On a pointer
   * device, hover reveals it as well.
   */
  const [openParagraph, setOpenParagraph] = useState<string | null>(null)

  const articleRef = useRef<HTMLElement | null>(null)
  const paragraphsRef = useRef<HTMLElement[]>([])
  const lastSavedRef = useRef<string | null>(null)
  /**
   * Whether the reviewer has actually moved through the chapter yet.
   *
   * A resume position is a claim about where someone stopped reading, so only
   * their own scrolling may make one. Mounting, re-rendering and resizing all
   * measure the page too, and none of them is evidence of having read
   * anything -- left ungated they recorded "you were at paragraph one" the
   * instant a chapter opened, and the next visit then scrolled the title,
   * the reading time and the hint off the screen to honour it.
   */
  const hasScrolledRef = useRef(false)

  const bookmarkedId = bookmarks[chapter.slug] ?? null

  /**
   * Closing a sheet, as one stable function.
   *
   * This is passed to `Sheet`, whose focus trap re-arms whenever its handler
   * changes identity. Written inline as an arrow function it was a new
   * function on every render -- and because the comment being typed is state
   * up here, every keystroke re-rendered, re-armed the trap, and moved the
   * keyboard out of the box mid-sentence.
   */
  const closeSheet = useCallback(() => setSheet(null), [])

  /* ---------------------------------------------------------- preferences */

  useIsomorphicLayoutEffect(() => {
    const stored = readPreferences(namespace)
    setPreferences(stored)
    applyAppearance(stored)
    setBookmarks(readBookmarks(namespace, book.slug))
  }, [namespace, book.slug])

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

    const mark = readChapterPosition(namespace, book.slug, chapter.slug)
    if (!mark) return

    /*
     * A mark on the first paragraph is not a place anyone stopped reading --
     * it is the top of the chapter, wearing a paragraph's name. Honouring it
     * scrolls the title, the reading time, the hint and the epigraph off the
     * screen to arrive at the very text those sit above.
     *
     * New marks for it are no longer written, but older ones are already in
     * reviewers' browsers, so they are ignored on the way in too. Opening at
     * the top is exactly what this position means.
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
  }, [namespace, book.slug, chapter.slug])

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
    let delta = 0

    if (box.bottom > floor) delta = box.bottom - floor
    else if (box.top < HEADER_OFFSET) delta = box.top - HEADER_OFFSET - 8

    if (delta === 0) return

    window.scrollBy({
      top: delta,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    })
  }, [openParagraph])

  /* ------------------------------------------------- position + progress */

  useEffect(() => {
    let timer: number | null = null
    let raf: number | null = null

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

      // The topmost paragraph still in view is where the reviewer is.
      let current: string | null = null
      for (const element of paragraphsRef.current) {
        if (element.getBoundingClientRect().bottom > HEADER_OFFSET) {
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
        writePosition(namespace, {
          bookSlug: book.slug,
          bookTitle: book.title,
          chapterSlug: chapter.slug,
          chapterLabel: chapter.label,
          paragraphId: current,
          at: Date.now(),
        })
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

    // The first measurement is for the progress bar alone.
    measure(false)
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onResize, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
      if (timer !== null) window.clearTimeout(timer)
      if (raf !== null) window.cancelAnimationFrame(raf)
    }
  }, [namespace, book.slug, book.title, chapter.slug, chapter.label])

  /* ------------------------------------------------------------ feedback */

  const refreshMine = useCallback(async () => {
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
  }, [book.slug, chapter.slug])

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

  const toggleBookmark = useCallback(
    (paragraphId: string) => {
      setBookmarks((current) => {
        const next = { ...current }
        if (next[chapter.slug] === paragraphId) delete next[chapter.slug]
        else next[chapter.slug] = paragraphId
        writeBookmarks(namespace, book.slug, next)
        return next
      })
    },
    [namespace, book.slug, chapter.slug],
  )

  const targetQuote =
    target?.scope === 'paragraph'
      ? blocks.find(
          (block): block is Extract<ReaderClientBlock, { kind: 'paragraph' }> =>
            block.kind === 'paragraph' && block.id === target.paragraphId,
        )
      : undefined

  const remaining = MAX_COMMENT_LENGTH - comment.length

  return (
    <>
      <header className="rv-bar">
        <Link href={`/review/${book.slug}`} className="rv-icon-btn" aria-label="Contents">
          <IconBack />
        </Link>
        <span className="rv-bar-title">{chapter.label}</span>
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
          onClick={() => setSheet('type')}
          aria-label="Appearance"
        >
          <IconType />
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
            Tap any paragraph to bookmark it or leave a note on that exact passage.
          </p>
        </div>

        <article className="rv-prose" ref={articleRef}>
          {blocks.map((block) => {
            if (block.kind === 'scene-break') {
              return <div key={block.id} className="rv-scene" role="separator" />
            }

            const isBookmarked = bookmarkedId === block.id
            const isCommented = commented.has(block.id)
            const isActive = target?.paragraphId === block.id && sheet === 'feedback'

            const classes = ['rv-para']
            if (block.dateline) classes.push('rv-para--dateline')
            if (isBookmarked) classes.push('rv-para--bookmarked')
            if (isCommented) classes.push('rv-para--commented')
            if (isActive) classes.push('rv-para--active')
            if (openParagraph === block.id) classes.push('rv-para--open')

            return (
              <p
                key={block.id}
                id={block.id}
                data-rv-pid={block.id}
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
                {block.segments.map((segment, index) =>
                  segment.kind === 'emphasis' ? (
                    <em key={index}>{segment.text}</em>
                  ) : (
                    <span key={index}>{segment.text}</span>
                  ),
                )}

                <span className="rv-para-tools">
                  <button
                    type="button"
                    className="rv-para-btn"
                    aria-pressed={isBookmarked}
                    onClick={() => toggleBookmark(block.id)}
                    aria-label={
                      isBookmarked
                        ? `Remove bookmark from paragraph ${block.ordinal}`
                        : `Bookmark paragraph ${block.ordinal}`
                    }
                  >
                    <IconBookmark filled={isBookmarked} />
                    <span>{isBookmarked ? 'Bookmarked' : 'Bookmark'}</span>
                  </button>
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
                  <span className="rv-para-count">{block.ordinal}</span>
                </span>
              </p>
            )
          })}
        </article>

        <nav className="rv-endnav" aria-label="Chapter navigation">
          {previousSlug ? (
            <Link href={`/review/${book.slug}/${previousSlug}`} className="rv-endnav-link">
              <IconBack />
              <span>Previous chapter</span>
            </Link>
          ) : (
            <span />
          )}
          <button
            type="button"
            className="rv-btn rv-btn--ghost"
            onClick={() => openFeedback({ scope: 'chapter', paragraphId: null, ordinal: null })}
          >
            Comment on this chapter
          </button>
          {nextSlug ? (
            <Link href={`/review/${book.slug}/${nextSlug}`} className="rv-endnav-link">
              <span>Next chapter</span>
              <IconNext />
            </Link>
          ) : (
            <span />
          )}
        </nav>

        <footer className="rv-foot">
          <span>{book.title}</span>
          <form action="/review/api/lock" method="post">
            <button type="submit">Sign out</button>
          </form>
        </footer>
      </div>

      {/* Thumb-reachable actions on a phone. Hidden once the viewport is wide
          enough for the end-of-chapter navigation to be reachable instead. */}
      <div className="rv-dock">
        {previousSlug ? (
          <Link
            href={`/review/${book.slug}/${previousSlug}`}
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
          aria-pressed={Boolean(bookmarkedId)}
          disabled={!bookmarkedId}
          onClick={() => bookmarkedId && scrollToParagraph(bookmarkedId, 'smooth')}
          aria-label={bookmarkedId ? 'Go to bookmark' : 'No bookmark in this chapter'}
        >
          <IconBookmark filled={Boolean(bookmarkedId)} />
        </button>
        <span className="rv-dock-spacer" />
        <button
          type="button"
          className="rv-dock-cta"
          onClick={() => openFeedback({ scope: 'chapter', paragraphId: null, ordinal: null })}
        >
          <IconComment />
          <span>Comment</span>
        </button>
        <span className="rv-dock-spacer" />
        {nextSlug ? (
          <Link
            href={`/review/${book.slug}/${nextSlug}`}
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
            href={`/review/${book.slug}/${entry.slug}`}
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
            {targetQuote.segments.map((segment, index) =>
              segment.kind === 'emphasis' ? (
                <em key={index}>{segment.text}</em>
              ) : (
                <span key={index}>{segment.text}</span>
              ),
            )}
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
                  {entry.paragraphId ? `Paragraph ${entry.paragraphId.split('-p')[1]}` : 'Chapter'}
                  {' · '}
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
                {entry.comment}
              </p>
            ))}
          </div>
        ) : null}
      </Sheet>
    </>
  )
}
