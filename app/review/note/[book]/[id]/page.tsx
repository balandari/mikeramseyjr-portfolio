import type { Metadata } from 'next'
import Link from 'next/link'

import { reviewerStorageNamespace } from '@/lib/reviewer-access'
import { reviewerContext } from '@/lib/reading-session'
import { openNoteByLocator, type OpenedNote } from '@/lib/note-service'
import ReviewAppearance from '../../../ReviewAppearance'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'A note',
  robots: { index: false, follow: false, noarchive: true, nocache: true },
}

/**
 * Opening a note from its private link.
 *
 * **The link is a locator, not a key.** The address says which book and which
 * note, and carries nothing else: no token, no signature, no body, no
 * quotation, nothing about who wrote it. It is not consulted when deciding who
 * may read anything. Reaching the note runs the same rule every other note
 * surface runs -- `openNoteByLocator`, and `canViewNote` inside it -- so a
 * reviewer's private note opens for its owner alone, a shared one opens for its
 * owner and for Mike, and one of Mike's own opens for Mike alone. A deleted
 * note is simply gone, and its link stops opening with it.
 *
 * This path is reachable without a session on purpose, exactly as
 * `/review/shared/<token>` is, and for the same reason: the administrator
 * cookie is scoped to `/admin` and is not sent here, so bouncing an
 * unauthenticated visitor to the reviewer sign-in form would ask Mike for a
 * reviewer's access code to read a note a reviewer shared with him.
 *
 * **Nothing is disclosed before authorization.** A visitor with no session, a
 * reviewer who may not read this note, a note that was deleted and an
 * identifier nobody ever minted all receive exactly the same page -- so the
 * link cannot be used to learn whether a note exists, what it says, or who
 * wrote it.
 */
export default async function ReviewerNoteLinkPage({
  params,
}: {
  params: { book: string; id: string }
}) {
  const context = await reviewerContext()
  if (!context) return <NeedsAccess book={params.book} id={params.id} />

  const result = await openNoteByLocator(context.viewer, params.book, params.id)
  if (!result.ok) return <NeedsAccess book={params.book} id={params.id} signedIn />

  const { note, book, chapter } = result.value
  const namespace = await reviewerStorageNamespace(context.reviewer)
  const passageHref =
    note.paragraphId && note.anchor.scope !== 'book' && note.anchor.scope !== 'chapter'
      ? `/review/${book.slug}/${note.anchor.chapterSlug}#${note.paragraphId}`
      : note.anchor.scope === 'chapter'
        ? `/review/${book.slug}/${note.anchor.chapterSlug}`
        : `/review/${book.slug}`

  return (
    <div className="rv-root">
      <ReviewAppearance namespace={namespace} />

      <header className="rv-bar">
        <Link href="/review" className="rv-icon-btn" aria-label="All titles">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </Link>
        <span className="rv-bar-title">A note</span>
        <span className="rv-icon-btn" aria-hidden="true" />
      </header>

      <div className="rv-main rv-page">
        <div className="rv-hero">
          <p className="rv-hero-eyebrow">{book.title}</p>
          <h1 className="rv-hero-title">{noteHeading(result.value)}</h1>
          <p className="rv-hero-sub">{noteWhere(result.value)}</p>
        </div>

        {noteCaptured(result.value) ? (
          <blockquote className="rv-quote">
            <span className="rv-quote-tag">The words, as they were when this was written</span>
            {noteCaptured(result.value)}
          </blockquote>
        ) : null}

        <p className="rv-shared-note">{note.body}</p>

        {note.anchorState === 'needs-relocation' ? (
          <p className="rv-note rv-note--bad" role="status">
            The manuscript has changed since this was written, so it no longer points at the
            same words. What is above is what was saved.
          </p>
        ) : (
          <Link href={passageHref} className="rv-btn rv-btn--primary rv-btn--block">
            {note.anchor.scope === 'book' ? 'Open the book' : 'Open this passage'}
          </Link>
        )}

        <footer className="rv-foot">
          <span>Signed in as {context.reviewer.name}</span>
          <Link href="/review/my-reading">My reading</Link>
        </footer>
      </div>
    </div>
  )
}

/** The chapter the note is in, or the book when it is about all of it. */
function noteHeading({ note, chapter }: OpenedNote): string {
  if (note.anchor.scope === 'book') return 'The whole book'
  return chapter?.label ?? note.anchor.chapterLabel
}

function noteWhere({ note }: OpenedNote): string {
  if (note.anchor.scope === 'book') return 'a note about all of it'
  if (note.anchor.scope === 'chapter') return 'a note about the chapter'
  return `paragraph ${note.anchor.paragraphOrdinal}`
}

/** The words the note was written about, as captured. Never the manuscript now. */
function noteCaptured({ note }: OpenedNote): string | null {
  if (note.anchor.scope === 'passage') return note.anchor.quote
  if (note.anchor.scope === 'paragraph') return note.anchor.paragraphText
  return null
}

/**
 * The one answer given to everybody who may not see the note.
 *
 * Identical whether the note is real, the reader may not read it, it has been
 * deleted, or there is no session at all -- deliberately, so the page reveals
 * nothing by how it differs.
 */
function NeedsAccess({
  book,
  id,
  signedIn = false,
}: {
  book: string
  id: string
  signedIn?: boolean
}) {
  const here = `/review/note/${encodeURIComponent(book)}/${encodeURIComponent(id)}`

  return (
    <div className="rv-root">
      <div className="rv-main rv-page">
        <div className="rv-hero">
          <p className="rv-hero-eyebrow">Advance reading</p>
          <h1 className="rv-hero-title">You need access to open this.</h1>
          <p className="rv-hero-sub">
            A link like this one points at a note. It is not a way in: opening it needs the
            sign-in of somebody the note is already readable by.
          </p>
        </div>

        <div className="rv-stack">
          {signedIn ? null : (
            <Link href={`/review/login?next=${encodeURIComponent(here)}`} className="rv-card">
              <h2 className="rv-card-title">Sign in as a reviewer</h2>
              <p className="rv-card-by">With the access code Mike gave you.</p>
            </Link>
          )}
          <Link
            href={`/admin/note/${encodeURIComponent(book)}/${encodeURIComponent(id)}`}
            className="rv-card"
          >
            <h2 className="rv-card-title">Open as the author</h2>
            <p className="rv-card-by">Mike&rsquo;s own sign-in.</p>
          </Link>
        </div>
      </div>
    </div>
  )
}
