import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { ADMIN_COOKIE_NAME, adminCsrfToken, verifyAdminToken } from '@/lib/admin-auth'
import {
  dashboardSummary,
  loadAuthorBoard,
  type DashboardSummary,
} from '@/lib/author-dashboard'
import type { AuthorSourceFailure } from '@/lib/author-feedback-source'
import { authorContext } from '@/lib/reading-session'
import { loadAdminView } from '@/lib/reviewer-admin'
import { loadRequestViews, type RequestView } from '@/lib/reviewer-onboarding'
import { listRequests } from '@/lib/reviewer-requests'
import Dashboard from './Dashboard'

/**
 * What the feedback sections show when the read itself threw.
 *
 * Not an empty board. `newCount: null` is "there is no honest count", which the
 * dashboard renders as an alert; a zero would be a claim that nothing is
 * waiting, made by the code path that just failed to find out.
 */
const UNREAD_FEEDBACK: DashboardSummary = {
  newCount: null,
  preview: [],
  total: 0,
  myNotes: { open: 0, resolved: 0, preview: [] },
  degraded: true,
}

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Author dashboard',
  robots: { index: false, follow: false, noarchive: true, nocache: true },
}

/**
 * The dashboard.
 *
 * The session is verified here, in this server component, before the roster
 * module is reached -- the request boundary already turned unauthorized callers
 * away, and this is the second, independent enforcement that does not depend on
 * it having done so. Nothing about the roster is loaded for somebody who is not
 * signed in, and nothing about it is ever rendered into a page that could be
 * cached: the route is `force-dynamic` and every response carries `no-store`.
 *
 * What crosses into the client component is deliberately narrow: reviewer rows
 * without their code fingerprints, the assignable books, the audit lines, and a
 * CSRF token bound to this session. No secret, no credential, and no access
 * code -- a code exists only in the response to the action that issued it.
 */
export default async function AdminPage() {
  const store = await cookies()
  const token = store.get(ADMIN_COOKIE_NAME)?.value
  const session = await verifyAdminToken(token)

  if (!session || !token) redirect('/admin/login')

  const csrf = await adminCsrfToken(token)
  if (!csrf) redirect('/admin/login?error=unconfigured')

  let view
  try {
    view = await loadAdminView()
  } catch {
    /*
     * The roster could not be read. Showing an empty dashboard would be a lie
     * with consequences -- it would read as "you have no reviewers", and the
     * obvious next action would be to add one, which would then be saved over
     * whatever is actually there.
     */
    return (
      <div className="ad-root">
        <div className="ad-gate">
          <div className="ad-gate-panel">
            <h1>Author dashboard</h1>
            <p className="ad-note ad-note--bad" role="alert">
              The roster could not be read, so it is not being shown. This is a storage or
              configuration fault, not an empty roster — nothing has been changed, and
              nothing should be added until it can be read again.
            </p>
            <form action="/admin/api/auth/signout" method="post" style={{ marginTop: '1rem' }}>
              <button type="submit" className="ad-btn">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </div>
    )
  }

  /*
   * Requests are loaded separately and are allowed to fail on their own.
   *
   * The roster failing is fatal to this page -- every row below it would be a
   * guess, and an empty roster that gets saved over the real one is how a
   * revocation becomes a restoration. A request listing failing is not: Mike
   * can still see and revoke his reviewers, and the section says plainly that
   * it could not be read rather than showing an empty list that means "nobody
   * is waiting".
   */
  let requests: RequestView[] = []
  let requestsReadable = true
  try {
    requests = await loadRequestViews(await listRequests())
  } catch {
    requestsReadable = false
  }

  /*
   * The feedback half, read separately and allowed to fail on its own.
   *
   * It is not fatal to this page: the roster, the requests and every reviewer
   * control below are still exactly as readable as they were, and a failure
   * here turns into "this could not be read" in the two sections that are about
   * it rather than into a gate over the whole dashboard. What it must never
   * become is a zero -- see `UNREAD_FEEDBACK`.
   *
   * Reading it marks nothing read and resolves nothing: `loadAuthorBoard` has
   * no write in it, and `dashboardSummary` is arithmetic over what it returned.
   */
  let feedback: DashboardSummary = UNREAD_FEEDBACK
  let feedbackFailures: AuthorSourceFailure[] = [{ source: 'author-feedback', bookSlug: null }]
  try {
    const context = await authorContext()
    if (context) {
      const board = await loadAuthorBoard(context.viewer)
      feedback = dashboardSummary(board)
      feedbackFailures = board.failures
    }
  } catch {
    // Left at the honest defaults above. No message from the store is kept,
    // shown or logged.
  }

  return (
    <Dashboard
      adminEmail={session.email}
      csrf={csrf}
      requests={requests}
      requestsReadable={requestsReadable}
      feedback={feedback}
      feedbackFailures={feedbackFailures}
      initial={{
        driver: view.driver,
        writable: view.writable,
        updatedAt: view.updatedAt,
        books: view.books,
        reviewers: view.reviewers.map((reviewer) => ({
          id: reviewer.id,
          name: reviewer.name,
          email: reviewer.email,
          books: reviewer.books,
          status: reviewer.status,
          createdAt: reviewer.createdAt,
          codeUpdatedAt: reviewer.codeUpdatedAt,
          lastAccessAt: reviewer.lastAccessAt,
          emailVerifiedAt: reviewer.emailVerifiedAt,
          origin: reviewer.origin,
        })),
        audit: view.audit.map((event) => ({
          id: event.id,
          at: event.at,
          actor: event.actor,
          action: event.action,
          reviewerId: event.reviewerId,
          detail: event.detail,
        })),
      }}
    />
  )
}
