import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { reviewerStorageNamespace } from '@/lib/reviewer-access'
import { reviewerContext } from '@/lib/reading-session'
import { buildWorkspace, FeedbackUnreadableError } from '@/lib/reading-workspace'
import ReviewAppearance from '../ReviewAppearance'
import Workspace from './Workspace'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'My reading',
  robots: { index: false, follow: false, noarchive: true, nocache: true },
}

/**
 * "My reading": everything this reviewer has made, grouped by book and chapter.
 *
 * The whole page is built from this reviewer's own prefixes. Their entitlements
 * decide which books are consulted at all, and within each book the store is
 * only ever asked for records under their own owner prefix -- so there is no
 * step at which another reviewer's material is fetched and then filtered out.
 *
 * Annotations shared with them by someone else would appear here too, and none
 * do, because in this slice sharing targets Mike or a private link rather than
 * a named reviewer. A link-shared annotation belongs in a list only for the
 * person who made it: a link is handed to somebody, not published to everybody
 * who happens to hold the same book.
 */
export default async function MyReadingPage() {
  const context = await reviewerContext()
  if (!context) redirect('/review/login')

  const { reviewer, viewer } = context
  const namespace = await reviewerStorageNamespace(reviewer)

  let books
  let feedbackProblem: string | null = null

  try {
    books = await buildWorkspace(viewer, reviewer.books, {
      base: '/review',
      includeFeedback: true,
    })
  } catch (error) {
    if (!(error instanceof FeedbackUnreadableError)) throw error
    /*
     * The comments could not be read. Everything else still can, so the page is
     * built without them and says so -- explicitly, because an empty list here
     * would read as "you have never commented", and that is a much worse thing
     * to tell somebody than "this could not be loaded".
     */
    feedbackProblem =
      'Your submitted comments could not be loaded just now. They have not been lost — this is a storage fault, not an empty history. Please try again shortly.'
    books = await buildWorkspace(viewer, reviewer.books, {
      base: '/review',
      includeFeedback: false,
    })
  }

  return (
    <div className="rv-root">
      <ReviewAppearance namespace={namespace} />

      <header className="rv-bar">
        <Link href="/review" className="rv-icon-btn" aria-label="All titles">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </Link>
        <span className="rv-bar-title">My reading</span>
        <span className="rv-icon-btn" aria-hidden="true" />
      </header>

      <div className="rv-main rv-page">
        <div className="rv-hero">
          <p className="rv-hero-eyebrow">Advance reading</p>
          <h1 className="rv-hero-title">My reading</h1>
          <p className="rv-hero-sub">
            Where you are in each book, every bookmark and highlight you have saved, and
            every comment you have sent. Only yours.
          </p>
        </div>

        {feedbackProblem ? (
          <p className="rv-note rv-note--bad" role="alert">
            {feedbackProblem}
          </p>
        ) : null}

        <Workspace
          endpoint={{ url: '/review/api/reading' }}
          books={books}
          emptyHint="When Mike shares a manuscript with you it will appear here."
        />

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
