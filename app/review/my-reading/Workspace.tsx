'use client'

import Link from 'next/link'
import { useCallback, useMemo, useState } from 'react'

import {
  deleteAnnotation,
  deleteBookmark,
  updateAnnotationRecord,
  type ReadingEndpoint,
  type Visibility,
  type WorkspaceBook,
} from '../reading-client'

/**
 * The reading workspace: everything one person has made, in one place.
 *
 * It is grouped the way a book is read -- book, then chapter, then position in
 * the chapter -- rather than the way a log is written, because the question
 * being answered is "what did I say about chapter two?" and not "what did I do
 * on Tuesday?".
 *
 * Every location-based item is a link back to its exact passage: the chapter
 * URL plus the paragraph's identifier as a fragment, which the reader honours
 * ahead of the automatic position. An item whose anchor no longer matches the
 * manuscript is shown with its saved quotation and labelled as needing
 * relocation, and its "go to" is disabled -- never pointed at whatever text now
 * occupies those offsets.
 *
 * The same component serves the author's own workspace. It is given a different
 * endpoint and a different link prefix and nothing else changes, because the
 * records are the same shape and the rules about them are enforced on the
 * server either way.
 */

const SHARING: { value: Visibility; label: string }[] = [
  { value: 'private', label: 'Private' },
  { value: 'author', label: 'Share with Mike' },
  { value: 'link', label: 'Private link' },
]

function when(value: string): string {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? '' : new Date(parsed).toLocaleString()
}

export default function Workspace({
  endpoint,
  books,
  /** What to call the person whose workspace this is, in the empty state. */
  emptyHint,
}: {
  endpoint: ReadingEndpoint
  books: WorkspaceBook[]
  emptyHint: string
}) {
  const [state, setState] = useState(books)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const totals = useMemo(() => {
    let bookmarks = 0
    let annotations = 0
    let feedback = 0
    for (const book of state) {
      bookmarks += book.bookmarks.length
      annotations += book.annotations.length
      feedback += book.feedback.length
    }
    return { bookmarks, annotations, feedback }
  }, [state])

  const removeBookmark = useCallback(
    async (bookSlug: string, id: string) => {
      if (busy) return
      setBusy(true)
      setProblem(null)
      const result = await deleteBookmark(endpoint, bookSlug, id)
      setBusy(false)
      if (!result.ok) {
        setProblem(result.message)
        return
      }
      setState((current) =>
        current.map((book) =>
          book.slug === bookSlug
            ? { ...book, bookmarks: book.bookmarks.filter((row) => row.id !== id) }
            : book,
        ),
      )
    },
    [busy, endpoint],
  )

  const removeAnnotation = useCallback(
    async (bookSlug: string, id: string) => {
      if (busy) return
      setBusy(true)
      setProblem(null)
      const result = await deleteAnnotation(endpoint, bookSlug, id)
      setBusy(false)
      if (!result.ok) {
        setProblem(result.message)
        return
      }
      setState((current) =>
        current.map((book) =>
          book.slug === bookSlug
            ? { ...book, annotations: book.annotations.filter((row) => row.id !== id) }
            : book,
        ),
      )
    },
    [busy, endpoint],
  )

  const changeSharing = useCallback(
    async (bookSlug: string, id: string, visibility: Visibility) => {
      if (busy) return
      setBusy(true)
      setProblem(null)
      const result = await updateAnnotationRecord(endpoint, bookSlug, id, { visibility })
      setBusy(false)
      if (!result.ok) {
        setProblem(result.message)
        return
      }
      const saved = result.value
      setState((current) =>
        current.map((book) =>
          book.slug === bookSlug
            ? {
                ...book,
                annotations: book.annotations.map((row) => (row.id === id ? saved : row)),
              }
            : book,
        ),
      )
    },
    [busy, endpoint],
  )

  if (state.length === 0) {
    return <p className="rv-empty">{emptyHint}</p>
  }

  return (
    <div className="rv-work">
      <p className="rv-work-tally">
        {totals.bookmarks} bookmark{totals.bookmarks === 1 ? '' : 's'} ·{' '}
        {totals.annotations} highlight{totals.annotations === 1 ? '' : 's'} and note
        {totals.annotations === 1 ? '' : 's'} · {totals.feedback} comment
        {totals.feedback === 1 ? '' : 's'} sent
      </p>

      {problem ? (
        <p className="rv-note rv-note--bad" role="alert">
          {problem}
        </p>
      ) : null}

      {state.map((book) => {
        const order = new Map(book.chapters.map((chapter) => [chapter.slug, chapter.number]))
        const chapterSlugs = book.chapters
          .filter(
            (chapter) =>
              book.bookmarks.some((row) => row.chapterSlug === chapter.slug) ||
              book.annotations.some((row) => row.chapterSlug === chapter.slug) ||
              book.feedback.some((row) => row.chapterSlug === chapter.slug),
          )
          .sort((a, b) => a.number - b.number)

        // A record whose chapter is no longer in the manuscript still belongs to
        // its owner and is still shown -- under its own heading, so it is
        // neither lost nor silently filed under a chapter it is not in.
        const orphanSlugs = Array.from(
          new Set(
            [
              ...book.bookmarks.map((row) => row.chapterSlug),
              ...book.annotations.map((row) => row.chapterSlug),
              ...book.feedback.map((row) => row.chapterSlug),
            ].filter((slug) => !order.has(slug)),
          ),
        )

        return (
          <section key={book.slug} className="rv-work-book">
            <div className="rv-work-head">
              <h2 className="rv-work-title">
                <Link href={book.base}>{book.title}</Link>
              </h2>
              {book.position ? (
                <Link
                  className="rv-work-resume"
                  href={
                    book.position.paragraphId
                      ? `${book.base}/${book.position.chapterSlug}#${book.position.paragraphId}`
                      : `${book.base}/${book.position.chapterSlug}`
                  }
                >
                  Continue reading — {book.position.chapterLabel}
                  {book.position.paragraphOrdinal
                    ? `, paragraph ${book.position.paragraphOrdinal}`
                    : ''}
                </Link>
              ) : (
                <p className="rv-work-resume rv-work-resume--none">Not started yet</p>
              )}
            </div>

            {chapterSlugs.length === 0 && orphanSlugs.length === 0 ? (
              <p className="rv-empty rv-empty--tight">
                Nothing saved in this book yet.
              </p>
            ) : null}

            {[
              ...chapterSlugs.map((chapter) => ({
                slug: chapter.slug,
                label: chapter.label,
                present: true,
              })),
              ...orphanSlugs.map((slug) => ({
                slug,
                label: slug,
                present: false,
              })),
            ].map((chapter) => {
              const bookmarks = book.bookmarks.filter((row) => row.chapterSlug === chapter.slug)
              const annotations = book.annotations.filter(
                (row) => row.chapterSlug === chapter.slug,
              )
              const feedback = book.feedback.filter((row) => row.chapterSlug === chapter.slug)

              return (
                <div key={chapter.slug} className="rv-work-chapter">
                  <h3 className="rv-work-chapter-title">
                    {chapter.present ? (
                      <Link href={`${book.base}/${chapter.slug}`}>{chapter.label}</Link>
                    ) : (
                      <span>{chapter.label} — no longer in the manuscript</span>
                    )}
                  </h3>

                  {bookmarks.length > 0 ? (
                    <div className="rv-work-group">
                      <span className="rv-field-label">Bookmarks</span>
                      {bookmarks.map((bookmark) => (
                        <div key={bookmark.id} className="rv-mark-row">
                          {bookmark.anchorState === 'ok' ? (
                            <Link
                              className="rv-mark-go"
                              href={`${book.base}/${bookmark.chapterSlug}#${bookmark.paragraphId}`}
                            >
                              <span className="rv-mark-where">
                                paragraph {bookmark.paragraphOrdinal} · {when(bookmark.createdAt)}
                              </span>
                              <span className="rv-mark-text">{bookmark.excerpt}</span>
                            </Link>
                          ) : (
                            <span className="rv-mark-go rv-mark-go--dead">
                              <span className="rv-mark-where">
                                paragraph {bookmark.paragraphOrdinal}
                              </span>
                              <span className="rv-mark-text">{bookmark.excerpt}</span>
                              <span className="rv-mark-flag">
                                That paragraph is no longer in the manuscript — this bookmark
                                needs relocating.
                              </span>
                            </span>
                          )}
                          <button
                            type="button"
                            className="rv-btn rv-btn--ghost"
                            disabled={busy}
                            onClick={() => void removeBookmark(book.slug, bookmark.id)}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {annotations.length > 0 ? (
                    <div className="rv-work-group">
                      <span className="rv-field-label">Highlights and notes</span>
                      {annotations.map((annotation) => (
                        <div key={annotation.id} className="rv-mark-row rv-mark-row--stack">
                          {annotation.anchorState === 'ok' ? (
                            <Link
                              className="rv-mark-go"
                              href={`${book.base}/${annotation.chapterSlug}#${annotation.paragraphId}`}
                            >
                              <span className="rv-mark-where">
                                paragraph {annotation.paragraphOrdinal} ·{' '}
                                {when(annotation.createdAt)}
                              </span>
                              <span className="rv-mark-quote">“{annotation.quote}”</span>
                              {annotation.note ? (
                                <span className="rv-mark-text">{annotation.note}</span>
                              ) : null}
                            </Link>
                          ) : (
                            <span className="rv-mark-go rv-mark-go--dead">
                              <span className="rv-mark-where">
                                paragraph {annotation.paragraphOrdinal}
                              </span>
                              <span className="rv-mark-quote">“{annotation.quote}”</span>
                              {annotation.note ? (
                                <span className="rv-mark-text">{annotation.note}</span>
                              ) : null}
                              <span className="rv-mark-flag">
                                The manuscript has changed here. This is the passage as it was
                                saved — it needs relocating.
                              </span>
                            </span>
                          )}

                          {annotation.own ? (
                            <div className="rv-mark-detail">
                              <div
                                className="rv-segments rv-segments--share"
                                role="group"
                                aria-label={`Sharing for the note on paragraph ${annotation.paragraphOrdinal}`}
                              >
                                {SHARING.map((option) => (
                                  <button
                                    key={option.value}
                                    type="button"
                                    className="rv-segment"
                                    aria-pressed={annotation.visibility === option.value}
                                    disabled={busy}
                                    onClick={() =>
                                      void changeSharing(book.slug, annotation.id, option.value)
                                    }
                                  >
                                    {option.label}
                                  </button>
                                ))}
                              </div>

                              {annotation.sharePath ? (
                                <p className="rv-share-link">
                                  <code>{annotation.sharePath}</code>
                                </p>
                              ) : null}

                              <div className="rv-mark-actions">
                                <button
                                  type="button"
                                  className="rv-btn rv-btn--danger"
                                  disabled={busy}
                                  onClick={() => void removeAnnotation(book.slug, annotation.id)}
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {feedback.length > 0 ? (
                    <div className="rv-work-group">
                      <span className="rv-field-label">Comments you sent</span>
                      {feedback.map((entry) => (
                        <div key={entry.id} className="rv-mark-row">
                          {entry.paragraphId ? (
                            <Link
                              className="rv-mark-go"
                              href={`${book.base}/${entry.chapterSlug}#${entry.paragraphId}`}
                            >
                              <span className="rv-mark-where">
                                paragraph {entry.paragraphOrdinal} · {when(entry.createdAt)}
                              </span>
                              {entry.quote ? (
                                <span className="rv-mark-quote">“{entry.quote}”</span>
                              ) : null}
                              <span className="rv-mark-text">{entry.comment}</span>
                            </Link>
                          ) : (
                            <span className="rv-mark-go">
                              <span className="rv-mark-where">
                                on the chapter · {when(entry.createdAt)}
                              </span>
                              <span className="rv-mark-text">{entry.comment}</span>
                            </span>
                          )}
                        </div>
                      ))}
                      {/*
                       * Submitted feedback is durable history. It is shown here
                       * and nowhere offered for editing or deletion: a recorded
                       * opinion of a manuscript is evidence, and evidence is not
                       * revised after the fact.
                       */}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}
