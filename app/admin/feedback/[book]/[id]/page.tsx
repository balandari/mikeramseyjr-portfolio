import type { Metadata } from 'next'
import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { loadAuthorBoard } from '@/lib/author-dashboard'
import { ITEM_ID_PATTERN, markItemOpened, SAVED_VIEW_HOME_SLUG } from '@/lib/author-metadata'
import { authorContext } from '@/lib/reading-session'
import type { InboxRow } from '@/lib/author-inbox-filter'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'One piece of feedback',
  description: 'Administration.',
  keywords: null,
  robots: { index: false, follow: false, noarchive: true, nocache: true },
}

/**
 * One item, opened -- and the only place in the product that marks one read.
 *
 * ## Why this page exists at all
 *
 * `markItemOpened` is the sole writer of `lastReadAt`, and the rule it enforces
 * is that the field moves when Mike **opens** something, never when a list
 * happens to contain it. A list that marked its rows read would empty the one
 * signal telling him what he has not looked at, one scroll at a time.
 *
 * A shared note has a locator already -- `/admin/note/<book>/<id>` -- but three
 * of the four kinds do not: an earlier submitted comment, a shared highlight and
 * a withdrawal have no private link to open. Without a destination they would
 * either never be readable, or would have to be marked read from the list, which
 * is the thing that must not happen. So this is that destination: bounded,
 * author-only, one item, and it shows exactly the row the inbox already showed.
 *
 * ## The mark, and what is allowed to cause it
 *
 * Only an **affirmative browser navigation**: `Sec-Fetch-Dest: document` and
 * `Sec-Fetch-Mode: navigate`, both exactly, and nothing else.
 *
 * `Sec-Fetch-Dest` alone does not say a human opened anything. A same-site page
 * can embed this URL in a hidden frame, the browser attaches the host-scoped
 * administrator cookie, and the GET-side write happens before any framing policy
 * could matter: that request arrives as `iframe`, and an `<embed>` or
 * `<object>` arrives as its own destination. A request with no `Sec-Fetch-*` at
 * all claims nothing, and "claims nothing" is not evidence that Mike read
 * something. A `document` destination fetched in a non-navigate mode is a script
 * retrieving the page, not a person arriving at it.
 *
 * Every one of those still **renders** the item -- the caller is already an
 * authorized author and refusing to show him his own feedback would help nobody
 * -- and says plainly that nothing was recorded. A cross-site *navigation* does
 * mark: Mike followed a link and is looking at his own item, which is what being
 * read means.
 *
 * The mark is attempted once, and a failure is reported rather than retried: the
 * item is shown either way, and "this is still counted as new" is a true
 * sentence that costs nothing. Nothing about `resolved` is touched here.
 */
export default async function AdminFeedbackItemPage({
  params,
}: {
  params: { book: string; id: string }
}) {
  const here = `/admin/feedback/${encodeURIComponent(params.book)}/${encodeURIComponent(params.id)}`
  const context = await authorContext()
  if (!context) redirect(`/admin/login?next=${encodeURIComponent(here)}`)

  /*
   * The saved-view document is not a book and holds no items. Refusing it by
   * name keeps the one document that must never carry triage from being reached
   * through a path that writes some.
   */
  if (params.book === SAVED_VIEW_HOME_SLUG || !ITEM_ID_PATTERN.test(params.id)) {
    return <Missing />
  }

  // Restricted to the one book, so nothing about any other book is read to
  // render one item.
  const board = await loadAuthorBoard(context.viewer, [params.book])
  const row = board.rows.find((entry) => entry.itemId === params.id) ?? null

  if (!row) {
    // An unreadable source and a genuinely absent item are different answers
    // and are never given the same sentence.
    return board.incomplete ? <Unreadable /> : <Missing />
  }

  const navigation = await isDocumentNavigation()
  let marked: 'recorded' | 'not-recorded' | 'not-attempted' = 'not-attempted'
  if (navigation) {
    const outcome = await markItemOpened(context.viewer, row.bookSlug, row.itemId)
    marked = outcome.ok ? 'recorded' : 'not-recorded'
  }

  return (
    <div className="ad-root">
      <header className="ad-bar">
        <Link href="/admin/feedback" className="ad-bar-back">
          Feedback
        </Link>
        <span className="ad-bar-title">One piece of feedback</span>
        <span />
      </header>

      <div className="ad-shell">
        <section className="ad-card">
          <h1 className="ad-card-title">{row.bookTitle}</h1>
          <p className="ad-card-sub">
            {row.attribution ?? 'Nobody named'} · {label(row)}
            {row.chapterLabel ? ` · ${row.chapterLabel}` : ''}
            {row.paragraphOrdinal ? ` · paragraph ${row.paragraphOrdinal}` : ''}
          </p>

          {row.kind === 'withdrawal' ? (
            <p className="af-row-body af-row-body--none">
              This was taken back. Nothing of what it said was kept, so there is nothing here to
              show — not hidden, not stored somewhere else, gone.
            </p>
          ) : (
            <>
              {row.captured ? <blockquote className="ad-quote">{row.captured}</blockquote> : null}
              {row.body ? (
                <p className="ad-note-body">{row.body}</p>
              ) : (
                <p className="af-row-body af-row-body--none">
                  A highlight with nothing written about it.
                </p>
              )}
            </>
          )}

          <p className="ad-hint">
            {row.triage === 'author'
              ? `Your own note · ${row.authorNoteStatus === 'resolved' ? 'Resolved' : 'Open'}`
              : !row.triageKnown
                ? 'Your record for this book could not be read, so its state is not being shown.'
                : `${row.resolved ? 'Resolved' : 'Unresolved'}`}
          </p>

          {row.anchorState === 'needs-relocation' ? (
            <p className="ad-note ad-note--bad" role="status">
              The manuscript has changed since this was written, so it no longer points at the
              same words. What is above is what was saved.
            </p>
          ) : locator(row) ? (
            <p style={{ marginTop: '1rem' }}>
              <Link href={locator(row) as string} className="ad-btn">
                Open this passage
              </Link>
            </p>
          ) : null}

          <p className="ad-note" role="status">
            {marked === 'recorded'
              ? 'Opening this counted as reading it, so it is no longer new.'
              : marked === 'not-recorded'
                ? 'That could not be recorded, so this is still counted as new. Nothing else changed.'
                : 'Nothing was recorded about this being read.'}
          </p>
        </section>
      </div>
    </div>
  )
}

/**
 * Did a browser affirmatively navigate here, or did something else fetch this?
 *
 * Both headers, both exact. An absent header, an empty one, an `iframe` or any
 * other destination, and a `document` in any mode but `navigate`, all answer
 * `false` -- the page is still rendered and nothing is recorded. See the block
 * comment above for why an absent header is not read as a navigation.
 */
async function isDocumentNavigation(): Promise<boolean> {
  try {
    const store = await headers()
    return store.get('sec-fetch-dest') === 'document' && store.get('sec-fetch-mode') === 'navigate'
  } catch {
    // No header store at all. Nothing is claimed about the request, so the
    // safer answer is the one that writes nothing.
    return false
  }
}

function label(row: InboxRow): string {
  if (row.kind === 'withdrawal') return 'Withdrawn'
  if (row.kind === 'comment') return 'Earlier submitted comment'
  if (row.kind === 'annotation') return 'Shared highlight'
  return row.triage === 'author' ? 'Your own note' : 'Note'
}

/** Where the passage is, when the row has one and it still points at the text. */
function locator(row: InboxRow): string | null {
  if (row.anchorState !== 'ok') return null
  if (row.scope === 'book') return `/admin/read/${row.bookSlug}`
  if (row.chapterSlug === null) return null
  return `/admin/read/${row.bookSlug}/${row.chapterSlug}`
}

function Missing() {
  return (
    <div className="ad-root">
      <div className="ad-gate">
        <div className="ad-gate-panel">
          <h1>One piece of feedback</h1>
          <p className="ad-note" role="status">
            That does not open anything you can see. Either there is no such item, it has been
            deleted, or it is private to the reviewer who wrote it.
          </p>
          <p style={{ marginTop: '1rem' }}>
            <Link href="/admin/feedback" className="ad-btn">
              Back to the feedback
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}

function Unreadable() {
  return (
    <div className="ad-root">
      <div className="ad-gate">
        <div className="ad-gate-panel">
          <h1>One piece of feedback</h1>
          <p className="ad-note ad-note--bad" role="alert">
            Part of the feedback for this book could not be read just now, so there is no way to
            tell from here whether this item is missing or simply unreadable. It has not been
            marked as read, and nothing has been lost.
          </p>
          <p style={{ marginTop: '1rem' }}>
            <Link href="/admin/feedback" className="ad-btn">
              Back to the feedback
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
