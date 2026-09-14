'use client'

import Link from 'next/link'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { ClientPosition } from '@/lib/reading-view'
import { fetchReading, savePosition, type ReadingEndpoint } from './reading-client'
import {
  clearPending,
  judgePending,
  pendingAsPosition,
  readPending,
  writePending,
  type PendingPosition,
} from './reading-local'

/**
 * "Pick up where you left off."
 *
 * The automatic position comes from the server, and still does: it is rendered
 * with the rest of the page, so the card is correct on the first paint and a
 * reviewer who reads on their phone is offered the same place on their laptop.
 * This is deliberately *not* a bookmark. Nobody asked for it, there is exactly
 * one of it per book, and it moves as they read.
 *
 * ## Why it is a client component now
 *
 * Because a server render is not the only thing that can put this page on the
 * screen. Next's client Router Cache keeps the rendered result of a visited
 * route and replays it on a back navigation, so a reviewer who reads a chapter
 * and presses Back is shown the library **as it was rendered before they read**
 * — with this card naming the chapter before last. `force-dynamic` does not
 * change that: it governs how the server renders, not whether the client
 * re-asks.
 *
 * Mike reproduced it precisely, and the reproduction is why the repair is here
 * rather than in the router: Continue reading said Chapter Two, he opened
 * Chapter Three, read two screens, pressed Back, and it still said Chapter Two
 * — and a manual refresh then said Chapter Three. The place had reached
 * storage. **Nothing was lost; a cached page was being displayed.**
 *
 * The obvious lever — turning the client cache off for dynamic routes — was
 * tried and rejected in the accepted work, because it takes the restored scroll
 * position with it and returns the reviewer to the bottom of the library they
 * came from. So the cache is left exactly as it is, the card asks for the one
 * piece of per-request state it actually needs, and the rest of the cached page
 * is reused as intended. Nothing here refreshes the route.
 *
 * ## What it prefers, and for how long
 *
 * A fresh answer from the server is not automatically the truest one. Right
 * after a back navigation this fetch can easily overtake the write the leaving
 * page handed to the browser — so "newest response wins" would replace the
 * place the reviewer just reached with the one they had before, which is the
 * original defect wearing different clothes. The device's own unconfirmed save
 * is preferred until the server reports it (by this device's sequence, never by
 * another device's), and then only for a bounded time; past that the server's
 * record is shown and the reviewer is told plainly that the newer place was not
 * saved. `./reading-local.ts` holds those rules and the reasoning.
 */

/** What this card needs of a position. Structurally a `ClientPosition`. */
export type ResumePosition = ClientPosition

/**
 * `useLayoutEffect` in the browser, `useEffect` on the server.
 *
 * The local pass below has to run before the browser paints, or a reviewer
 * returning from a chapter sees the cached card's chapter for a frame before it
 * corrects itself — a flicker on exactly the line they came back to read.
 * Resolved once at module scope so the hook order is stable and React stays
 * quiet during server rendering.
 */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export default function ResumeCard({
  position,
  base = '/review',
  identity,
  endpoint,
  books,
}: {
  position: ResumePosition | null
  /** `/review` for a reviewer, `/admin/read` for the author. */
  base?: string
  /**
   * The reader's opaque storage namespace. Without it there is no safe key for
   * a device-local place, so the card simply renders what the server rendered.
   */
  identity?: string
  /** Where to ask. Omitted by a caller that does not want reconciliation. */
  endpoint?: ReadingEndpoint
  /** Which books to reconcile. One for a book page; the shelf for the library. */
  books?: readonly string[]
}) {
  const [shown, setShown] = useState<ResumePosition | null>(position)
  /** True when a place this device measured is known not to have been saved. */
  const [unsaved, setUnsaved] = useState(false)

  const reconcilable = Boolean(identity && endpoint && books && books.length > 0)
  /*
   * Bounded, so a shelf that grows later cannot turn one card into a burst of
   * requests. Reviewers are given a title or two; this is headroom, not a
   * design for a catalogue.
   */
  const shelf = (books ?? []).slice(0, 6)
  const shelfKey = shelf.join(',')

  /** The server's own render, kept so a book's prop can be recognised again. */
  const serverPosition = useRef<ResumePosition | null>(position)
  serverPosition.current = position

  /**
   * Pick between places the **server** recorded: the most recent one.
   *
   * `updatedAt` on these is the server's own clock, so comparing two of them is
   * comparing one clock with itself — the same comparison the library page
   * makes when it chooses which book to offer. A device-local place is never
   * ranked this way, because that *would* be comparing two clocks: a phone
   * running a few minutes slow would lose every time, and one running fast
   * would win forever. Local places are chosen between by their sequence, which
   * is this device's own counter, and they outrank the server's record on the
   * only grounds that matter here — the reader was just there, and the server
   * has not caught up yet.
   */
  const newest = useCallback(
    (candidates: (ResumePosition | null)[]): ResumePosition | null =>
      candidates.reduce<ResumePosition | null>(
        (best, candidate) =>
          !candidate ? best : !best || candidate.updatedAt > best.updatedAt ? candidate : best,
        null,
      ),
    [],
  )

  /** The newest unconfirmed local place, by this device's own counter. */
  const freshest = useCallback(
    (records: PendingPosition[]): PendingPosition | null =>
      records.reduce<PendingPosition | null>(
        (best, record) => (!best || record.sequence > best.sequence ? record : best),
        null,
      ),
    [],
  )

  /*
   * The local pass, before paint and before any request.
   *
   * This is what makes the back navigation correct *immediately* rather than a
   * round trip later. Reading storage is synchronous, so the card can be right
   * in the same frame the cached page is shown in — there is no flash of the
   * stale chapter to see.
   */
  useIsomorphicLayoutEffect(() => {
    if (!reconcilable || !identity) return

    const now = Date.now()
    const local: PendingPosition[] = []
    let expired = false

    for (const bookSlug of shelf) {
      const record = readPending(identity, bookSlug)
      if (!record) continue
      const server =
        serverPosition.current?.bookSlug === bookSlug ? serverPosition.current : null
      const verdict = judgePending(record, server, now)
      if (verdict.kind === 'pending') local.push(verdict.record)
      if (verdict.kind === 'expired') expired = true
    }

    const preferred = freshest(local)
    if (preferred) setShown(pendingAsPosition(preferred))
    if (expired) setUnsaved(true)
    // `shelfKey` stands in for `shelf`, which is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, reconcilable, shelfKey, freshest, position])

  /*
   * The server pass: one small request per book, and nothing else.
   *
   * Deliberately not `router.refresh()`. Re-rendering the whole route to
   * correct one line would throw away the cached page the reviewer is looking
   * at — and with it the scroll position the router restored for them, which is
   * the cost the accepted work already refused to pay once.
   */
  const reconcile = useCallback(async () => {
    if (!reconcilable || !identity || !endpoint) return

    const now = Date.now()
    const stored: (ResumePosition | null)[] = []
    const local: PendingPosition[] = []
    let answered = false
    let expired = false

    for (const bookSlug of shelf) {
      const answer = await fetchReading(endpoint, bookSlug)
      // No answer is not evidence of anything. A refused or unreachable request
      // must never be counted against a pending place, or an offline moment
      // would expire a save that is simply waiting for a connection.
      if (!answer.ok) continue
      answered = true

      const server = answer.value.position
      stored.push(server)

      const record = readPending(identity, bookSlug)
      const verdict = judgePending(record, server, now)

      if (verdict.kind === 'confirmed') {
        if (record) clearPending(identity, bookSlug)
        continue
      }

      if (verdict.kind === 'expired') {
        expired = true
        clearPending(identity, bookSlug)
        continue
      }

      local.push(verdict.record)
      void retry(verdict.record, endpoint, identity)
    }

    if (!answered) return

    /*
     * An unconfirmed local place wins, and only then the server's record. This
     * is the ordering the whole repair turns on: right after a back navigation
     * the fetch above can easily beat the write the leaving page handed to the
     * browser, so "the freshest response wins" would put the reader back where
     * they were before they read — which is the defect, not the fix.
     */
    const preferred = freshest(local)
    setShown(preferred ? pendingAsPosition(preferred) : newest(stored))
    if (expired) setUnsaved(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, endpoint, reconcilable, shelfKey, newest, freshest])

  /*
   * On arrival, and whenever the page becomes the one being looked at again.
   *
   * `visibilitychange` is the event that fires when a phone comes back from
   * another app, and `pageshow` is the one that fires when a page is restored
   * from the back/forward cache without re-running anything at all — which is a
   * page whose card is, by definition, as old as the last time it was seen.
   */
  useEffect(() => {
    if (!reconcilable) return
    let stopped = false
    const run = () => {
      if (!stopped) void reconcile()
    }

    run()
    const onVisible = () => {
      if (document.visibilityState === 'visible') run()
    }
    /*
     * Only a *restored* page. `pageshow` fires on an ordinary load too, and the
     * mount above has already covered that one -- running both would spend two
     * of a pending place's bounded attempts on a single visit, and bring the
     * honest "couldn't save your place" forward to a moment where it is not yet
     * honest. `persisted` is the browser saying this document was brought back
     * from the back/forward cache without re-running anything, which is exactly
     * the page whose card is as old as the last time it was seen.
     */
    const onRestored = (event: PageTransitionEvent) => {
      if (event.persisted) run()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onRestored)
    return () => {
      stopped = true
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', onRestored)
    }
  }, [reconcile, reconcilable])

  if (!shown) {
    return unsaved ? <SaveWarning /> : null
  }

  /*
   * No `#paragraph` on this link, deliberately.
   *
   * It used to carry one, and that quietly defeated the whole point of the
   * card. A chapter treats an explicit link target as a deliberate request and
   * honours it *over* the saved place -- correct for a bookmark, wrong here,
   * because a fragment can only name a paragraph and the saved place is finer
   * than that. A reader who stopped nine tenths of the way through a long
   * paragraph was taken to that paragraph's first line: measured at 1,400px
   * short, two screens of reading apparently lost when it had been saved
   * perfectly.
   *
   * Without the fragment the chapter resumes from the stored place, which is
   * where the offset lives. Bookmarks and shared notes still link with a
   * fragment, and still land at the top of the passage they name, which is what
   * they mean.
   */
  const href = `${base}/${shown.bookSlug}/${shown.chapterSlug}`

  return (
    <>
      <Link href={href} className="rv-resume">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5.5A1.5 1.5 0 0 1 4 18.5z" />
          <path d="M9 9.5l5 2.5-5 2.5z" />
        </svg>
        {/*
          * The action first, and in full.
          *
          * It used to read "CONTINUE READING" as a small uppercase eyebrow above
          * the book's title set large -- so the largest thing on the card was the
          * name of a book the reader already knows they are reading, and the part
          * that said what tapping would *do* was the smallest. Mike read it as a
          * label rather than a button, which is exactly what it looked like.
          *
          * Now the sentence a reader is looking for is the loud line, the book
          * and chapter are the quiet one underneath, and there is a chevron,
          * because that is how a row says "this goes somewhere".
          */}
        <span className="rv-resume-text">
          <span className="rv-resume-k">
            {/* A non-breaking space so the label wraps as "…where you /
                left off" rather than stranding "off" on its own line. */}
            Continue reading where you left&nbsp;off
          </span>
          <span className="rv-resume-v">
            {shown.bookTitle}
            {shown.chapterLabel ? ` · ${shown.chapterLabel}` : ''}
          </span>
        </span>
        <svg
          className="rv-resume-go"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M9 5l7 7-7 7" />
        </svg>
      </Link>
      {unsaved ? <SaveWarning /> : null}
    </>
  )
}

/**
 * The same sentence the reader itself uses when a place could not be kept.
 *
 * One wording for one fact, in both places it can be discovered. It appears
 * only when a place this device measured has run out of chances to be
 * confirmed -- never as a guess, and never instead of showing the best place
 * that *is* on record.
 */
function SaveWarning() {
  return (
    <p className="rv-resume-warn" role="status">
      Couldn&rsquo;t save your place
    </p>
  )
}

/**
 * One more attempt at a place the server has not acknowledged.
 *
 * Sent with the **same** device and sequence, which makes it safe to repeat: if
 * the original did arrive, the server refuses this as stale and answers with
 * what it holds, and nothing moves. If it never arrived, this is the save. It
 * can never resurrect an old place over a newer one from another device,
 * because the ordering rule refuses a sequence at or below this device's own
 * high-water mark and never compares one device's sequence with another's.
 *
 * Bounded by the attempt count carried on the record, which is what eventually
 * turns an unconfirmable place into the honest warning above.
 */
async function retry(
  record: PendingPosition,
  endpoint: ReadingEndpoint,
  identity: string,
): Promise<void> {
  writePending({ ...record, attempts: record.attempts + 1 })

  const report = await savePosition(endpoint, {
    bookSlug: record.bookSlug,
    chapterSlug: record.chapterSlug,
    paragraphId: record.paragraphId,
    ...(record.paragraphOffset === undefined
      ? {}
      : { paragraphOffset: record.paragraphOffset }),
    device: record.device,
    sequence: record.sequence,
  })

  // Stored, or refused as older than something newer from this same device:
  // either way the server's record is at least as new as this one.
  if (report.result === 'stored') clearPending(identity, record.bookSlug)
}
