import type { Metadata } from 'next'
import Link from 'next/link'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import {
  REVIEWER_COOKIE_NAME,
  reviewerStorageNamespace,
} from '@/lib/reviewer-access'
import { authorizeReviewer } from '@/lib/reviewer-authorization'
import { findBook, releasedChapters } from '@/lib/manuscript'
import ReviewAppearance from './ReviewAppearance'
import ResumeCard from './ResumeCard'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Advance reading',
  robots: { index: false, follow: false, noarchive: true, nocache: true },
}

/**
 * The reviewer's landing page: the titles shared with *them*.
 *
 * The list is built from the reviewer's own entitlements, so it is not a
 * filtered view of a larger catalogue -- a book they have not been given is
 * never fetched, never rendered, and never referenced in the markup. Two
 * reviewers signed in on the same machine see two different pages.
 *
 * The manuscript module is imported at the top of this file but only reached
 * after the cookie check below, and the check redirects before any book is
 * loaded. The request boundary has already refused unauthorized callers; this
 * is the second, independent enforcement that does not depend on it.
 */
export default async function ReviewHomePage() {
  const store = await cookies()
  const reviewer = await authorizeReviewer(store.get(REVIEWER_COOKIE_NAME)?.value)

  if (!reviewer) redirect('/review/login')

  const namespace = await reviewerStorageNamespace(reviewer)

  const books = reviewer.books
    .map((slug) => findBook(slug))
    .filter((book): book is NonNullable<typeof book> => book !== null)
    .map((book) => {
      const chapters = releasedChapters(book)
      return {
        slug: book.slug,
        title: book.title,
        author: book.author,
        subtitle: book.subtitle,
        chapterCount: chapters.length,
        minutes: chapters.reduce((total, chapter) => total + chapter.minutes, 0),
        firstChapterSlug: chapters[0]?.slug ?? null,
      }
    })

  return (
    <div className="rv-root">
      <ReviewAppearance namespace={namespace} />

      <div className="rv-main rv-page">
        <header className="rv-hero">
          <p className="rv-hero-eyebrow">Advance reading</p>
          <h1 className="rv-hero-title">Welcome, {reviewer.name}.</h1>
          <p className="rv-hero-sub">
            {books.length === 0
              ? 'Nothing has been shared with you yet.'
              : books.length === 1
                ? 'One title has been shared with you for review.'
                : `${books.length} titles have been shared with you for review.`}
          </p>
        </header>

        <ResumeCard namespace={namespace} />

        {books.length === 0 ? (
          <p className="rv-empty">
            When Mike shares a manuscript with you it will appear here. Nothing
            else about your access changes.
          </p>
        ) : (
          <div className="rv-stack">
            {books.map((book) => (
              <Link key={book.slug} href={`/review/${book.slug}`} className="rv-card">
                <h2 className="rv-card-title">{book.title}</h2>
                <p className="rv-card-by">
                  {book.author}
                  {book.subtitle ? ` · ${book.subtitle}` : ''}
                </p>
                <p className="rv-card-meta">
                  <span className="rv-pill rv-pill--live">
                    {book.chapterCount === 1
                      ? '1 chapter'
                      : `${book.chapterCount} chapters`}
                  </span>
                  <span>about {book.minutes} min of reading</span>
                </p>
              </Link>
            ))}
          </div>
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
