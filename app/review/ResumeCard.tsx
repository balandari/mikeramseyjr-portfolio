import Link from 'next/link'

import type { ReadingPosition } from '@/lib/reviewer-reading'

/**
 * "Pick up where you left off."
 *
 * The automatic position now comes from the server, so this renders on the
 * server with the rest of the page. It used to be a client component that read
 * `localStorage` after mount, which meant the card appeared a moment late and,
 * more importantly, meant a reviewer who opened the book on their phone and
 * then on a laptop was offered nothing on the laptop. A place in a book belongs
 * to the person, not to the browser.
 *
 * This is deliberately *not* a bookmark. Nobody asked for it, there is exactly
 * one of it per book, and it moves as they read. Bookmarks are plural,
 * deliberate, and listed separately.
 */
export default function ResumeCard({
  position,
  base = '/review',
}: {
  position: ReadingPosition | null
  /** `/review` for a reviewer, `/admin/read` for the author. */
  base?: string
}) {
  if (!position) return null

  const href = position.paragraphId
    ? `${base}/${position.bookSlug}/${position.chapterSlug}#${position.paragraphId}`
    : `${base}/${position.bookSlug}/${position.chapterSlug}`

  return (
    <Link href={href} className="rv-resume">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5.5A1.5 1.5 0 0 1 4 18.5z" />
        <path d="M9 9.5l5 2.5-5 2.5z" />
      </svg>
      <span className="rv-resume-text">
        <span className="rv-resume-k">Continue reading</span>
        <span className="rv-resume-v">
          {position.bookTitle}
          {position.chapterLabel ? ` — ${position.chapterLabel}` : ''}
        </span>
      </span>
    </Link>
  )
}
