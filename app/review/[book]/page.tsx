import type { Metadata } from 'next'
import Link from 'next/link'
import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'

import {
  REVIEWER_COOKIE_NAME,
  reviewerMayRead,
  reviewerStorageNamespace,
  verifyReviewerToken,
} from '@/lib/reviewer-access'
import { findBook, releasedChapters } from '@/lib/manuscript'
import ReviewAppearance from '../ReviewAppearance'
import ResumeCard from '../ResumeCard'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Advance reading',
  robots: { index: false, follow: false, noarchive: true, nocache: true },
}

/**
 * One book's table of contents.
 *
 * Entitlement is checked before the book is loaded, and a reviewer who is not
 * entitled gets the same 404 as a book that does not exist. That is deliberate:
 * "you may not read this" and "this is not here" must be indistinguishable, or
 * the reader becomes a way to enumerate unpublished work.
 */
export default async function BookPage({ params }: { params: { book: string } }) {
  const store = await cookies()
  const reviewer = await verifyReviewerToken(store.get(REVIEWER_COOKIE_NAME)?.value)

  if (!reviewer) redirect('/review/login')
  if (!reviewerMayRead(reviewer, params.book)) notFound()

  const book = findBook(params.book)
  if (!book) notFound()

  const chapters = releasedChapters(book)
  const namespace = await reviewerStorageNamespace(reviewer)
  const minutes = chapters.reduce((total, chapter) => total + chapter.minutes, 0)

  return (
    <div className="rv-root">
      <ReviewAppearance namespace={namespace} />

      <header className="rv-bar">
        <Link href="/review" className="rv-icon-btn" aria-label="All titles">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </Link>
        <span className="rv-bar-title">{book.title}</span>
        <span className="rv-icon-btn" aria-hidden="true" />
      </header>

      <div className="rv-main rv-page">
        <div className="rv-hero">
          <p className="rv-hero-eyebrow">Advance reading</p>
          <h1 className="rv-hero-title">{book.title}</h1>
          <p className="rv-hero-sub">
            {book.author}
            {book.subtitle ? ` · ${book.subtitle}` : ''}
          </p>
          <p className="rv-card-meta">
            <span className="rv-pill rv-pill--live">
              {chapters.length === 1 ? '1 chapter' : `${chapters.length} chapters`}
            </span>
            <span>about {minutes} min of reading</span>
          </p>
        </div>

        <ResumeCard namespace={namespace} bookSlug={book.slug} />

        {chapters.length === 0 ? (
          <p className="rv-empty">No chapters have been released yet.</p>
        ) : (
          <nav className="rv-stack" aria-label="Chapters">
            {chapters.map((chapter) => (
              <Link
                key={chapter.slug}
                href={`/review/${book.slug}/${chapter.slug}`}
                className="rv-card"
              >
                <h2 className="rv-card-title">{chapter.label}</h2>
                {chapter.subtitle ? <p className="rv-card-by">{chapter.subtitle}</p> : null}
                <p className="rv-card-meta">
                  <span>{chapter.paragraphCount} paragraphs</span>
                  <span>·</span>
                  <span>about {chapter.minutes} min</span>
                </p>
              </Link>
            ))}
          </nav>
        )}

        <footer className="rv-foot">
          <span>Signed in as {reviewer.name}</span>
          <form action="/review/api/lock" method="post">
            <button type="submit">Sign out</button>
          </form>
        </footer>
      </div>
    </div>
  )
}
