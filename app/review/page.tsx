import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { reviewerStorageNamespace } from '@/lib/reviewer-access'
import { reviewerContext } from '@/lib/reading-session'
import { loadPositions } from '@/lib/reading-service'
import { findBook, releasedChapters } from '@/lib/manuscript'
import ReadingHelp from '@/components/reader/ReadingHelp'
import AuthorMark from '@/components/site/AuthorMark'
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
  const context = await reviewerContext()
  if (!context) redirect('/review/login')

  const { reviewer, viewer } = context
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

  // The automatic position in each entitled book; the most recent is what
  // "Continue reading" offers. One per book means there is nothing to guess
  // about which one was meant.
  const positions = await loadPositions(viewer, reviewer.books)
  const latest =
    positions.length === 0
      ? null
      : positions.reduce((newest, position) =>
          position.updatedAt > newest.updatedAt ? position : newest,
        )

  return (
    <div className="rv-root">
      <ReviewAppearance namespace={namespace} />

      <div className="rv-main rv-page">
        <header className="rv-hero">
          {/*
           * Whose reading room this is. The library is the one page under
           * `/review` that says it at all -- a chapter never does, because a
           * mark above someone's book is a mark on someone's book.
           */}
          <AuthorMark size={34} className="rv-hero-mark" alt="Mike Ramsey Jr" />
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

        {/*
         * The card reconciles itself against the reading endpoint on arrival.
         * `latest` is the server's answer for this render; the card's own job
         * is to notice when this page is a cached replay of an older one, and
         * when this device has a newer place still in flight. See ResumeCard.
         */}
        <ResumeCard
          position={latest}
          identity={namespace}
          endpoint={{ url: '/review/api/reading' }}
          books={reviewer.books}
        />

        {/*
         * The workspace, said plainly and placed where it cannot be missed.
         * Everything a reviewer has made -- bookmarks, highlights, notes and
         * every comment they have submitted -- is one tap away from the page
         * they land on.
         */}
        <Link href="/review/my-reading" className="rv-workspace-link">
          <span className="rv-workspace-k">My reading</span>
          <span className="rv-workspace-v">
            Your bookmarks, highlights, notes and comments, in one place
          </span>
        </Link>

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

        <ReadingHelp voice="reviewer" />

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
