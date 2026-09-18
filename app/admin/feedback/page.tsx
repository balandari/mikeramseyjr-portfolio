import type { Metadata } from 'next'
import Link from 'next/link'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { ADMIN_COOKIE_NAME, adminCsrfToken } from '@/lib/admin-auth'
import { dashboardSummary, loadAuthorBoard } from '@/lib/author-dashboard'
import { chapterChoices } from '@/lib/author-inbox-filter'
import { bookChoices } from '@/lib/author-feedback-view'
import { authorContext } from '@/lib/reading-session'
import FeedbackInbox from './FeedbackInbox'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Feedback',
  description: 'Administration.',
  keywords: null,
  robots: { index: false, follow: false, noarchive: true, nocache: true },
}

/**
 * Everything reviewers have sent, in one place.
 *
 * It used to be a section at the bottom of `/admin/read`, which made the page
 * two things at once: the shelf Mike reads his own books from, and the list of
 * what other people said about them. They are different jobs done at different
 * times, and the second one grew filters, states, saved views and an export.
 * So it is its own route now, and `/admin/read` links to it and stops there.
 *
 * ## The first paint is the truth
 *
 * The session is verified here, in this server component, before any source or
 * metadata module is reached -- the request boundary already turned
 * unauthorized callers away, and this is the second, independent enforcement
 * that does not depend on it having done so. The whole board is then read on
 * the server and rendered on the server: the rows, the counts and every way the
 * read fell short are in the HTML before any script runs.
 *
 * The client component below provides the controls. It cannot replace that
 * first state with a better-looking one: it never re-reads, it has no empty
 * default, and the three failure flags reach it as props. A storage failure is
 * visible on the first paint and stays visible.
 *
 * ## Nothing here marks anything read
 *
 * `loadAuthorBoard` reads and does not write, and this page calls nothing else.
 * `lastReadAt` moves when Mike opens an item's detail page --
 * `app/admin/feedback/[book]/[id]/page.tsx` -- and at no other moment.
 *
 * `private, no-store` comes from `middleware.ts`, which sets it on every
 * `/admin` response; the route is `force-dynamic`, so there is nothing to cache
 * in front of it either.
 */
export default async function AdminFeedbackPage() {
  const context = await authorContext()
  if (!context) redirect('/admin/login?next=%2Fadmin%2Ffeedback')

  const store = await cookies()
  const token = store.get(ADMIN_COOKIE_NAME)?.value
  const csrf = token ? await adminCsrfToken(token) : null
  if (!csrf) redirect('/admin/login?error=unconfigured')

  const board = await loadAuthorBoard(context.viewer)
  const summary = dashboardSummary(board)

  return (
    <div className="ad-root">
      <header className="ad-bar">
        <Link href="/admin" className="ad-bar-back">
          Dashboard
        </Link>
        <span className="ad-bar-title">Feedback</span>
        <Link href="/admin/read" className="ad-bar-back">
          Read my books
        </Link>
      </header>

      <div className="ad-shell">
        <p className="ad-section-eyebrow">Incoming</p>
        <h1 className="ad-section-title">
          {summary.newCount === null
            ? 'Some of this could not be read'
            : summary.newCount === 0
              ? 'Nothing new'
              : `${summary.newCount} new`}
        </h1>
        <p className="ad-hint">
          What reviewers chose to share, your own notes, and what has been taken back. A
          reviewer&rsquo;s private notes are not here at any scope. Looking at this list changes
          nothing: an item counts as read when you open it.
        </p>

        <FeedbackInbox
          csrf={csrf}
          rows={board.rows}
          books={bookChoices(board.books)}
          chapters={chapterChoices(board.rows)}
          savedViews={board.savedViews}
          incomplete={board.incomplete}
          failures={board.failures}
          unreadableBooks={board.unreadableBooks}
          storageUnavailable={board.storageUnavailable}
          notFound={board.notFound}
        />

        <footer className="ad-foot">
          <span>Signed in as {context.session.email}</span>
          <Link href="/admin">Dashboard</Link>
        </footer>
      </div>
    </div>
  )
}
