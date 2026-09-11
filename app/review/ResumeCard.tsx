'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { readPosition, type Position } from './reader-storage'

/**
 * "Pick up where you left off", on the library page.
 *
 * The position lives in this browser under the reviewer's own namespace, so it
 * is read after mount rather than rendered on the server: there is nothing the
 * server could know about it. Until it resolves, nothing is shown -- an empty
 * gap is better than a card that appears and then changes what it says.
 */
export default function ResumeCard({
  namespace,
  bookSlug,
}: {
  namespace: string
  /** When given, the card appears only if the saved position is in this book. */
  bookSlug?: string
}) {
  const [position, setPosition] = useState<Position | null>(null)

  useEffect(() => {
    setPosition(readPosition(namespace))
  }, [namespace])

  if (!position) return null
  if (bookSlug && position.bookSlug !== bookSlug) return null

  const href = position.paragraphId
    ? `/review/${position.bookSlug}/${position.chapterSlug}#${position.paragraphId}`
    : `/review/${position.bookSlug}/${position.chapterSlug}`

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
