'use client'

import { useCallback, useMemo, useState } from 'react'

import {
  ALL_FEEDBACK,
  filterRows,
  rowKey,
  type ChapterChoice,
  type InboxFilter,
  type InboxRow,
} from '@/lib/author-inbox-filter'
import type { AuthorSourceKind, SavedView, SavedViewScope, SavedViewState } from '@/lib/author-metadata'

/**
 * The feedback inbox's interactive half.
 *
 * It holds no authority. Every write is one POST to `/admin/api/feedback`,
 * which re-verifies the administrator session and the CSRF token, re-reads the
 * document it is about to change, and answers with what it actually stored.
 * Replacing this file wholesale could not make that endpoint do anything it
 * would not already allow.
 *
 * ## The four things this component must not do
 *
 *   **It must not mark anything read.** There is no request here that could:
 *   `lastReadAt` is written by `markItemOpened`, which is reached only by
 *   navigating to an item's detail page. Filtering, sorting, counting,
 *   expanding and exporting are all local or read-only, and none of them sends
 *   anything.
 *
 *   **It must not turn a server read failure into an empty list.** The failure
 *   flags arrive as props from the server render and are shown as alerts.
 *   `rows` is the server's answer and is never replaced by a client re-read,
 *   because there is no client re-read.
 *
 *   **It must not retry.** A refused, conflicted or lost action leaves the
 *   rendered state exactly as it was, says what did not change, and stops.
 *   Mike decides whether to do it again, after reloading if he wants to know
 *   what the server now believes.
 *
 *   **It must not make a second export out of a browser failure.** The server
 *   response *is* the export event -- the packet was generated and the stamp was
 *   attempted before this component saw anything. A download that the browser
 *   refuses and a clipboard that is unavailable are reported and nothing else;
 *   generating again would produce a second packet and a second stamp for one
 *   thing Mike asked for once.
 */

export type BookChoice = { slug: string; title: string }

export type InboxProps = {
  csrf: string
  /** The server's rows, newest first. Never re-read from the browser. */
  rows: InboxRow[]
  books: BookChoice[]
  chapters: ChapterChoice[]
  /** Null when the saved-view document could not be read. Never `[]` for that. */
  savedViews: SavedView[] | null
  /** A feedback source did not answer. Export is refused while this is true. */
  incomplete: boolean
  failures: { source: string; bookSlug: string | null }[]
  unreadableBooks: string[]
  storageUnavailable: boolean
  notFound: string[]
}

const KINDS: { value: AuthorSourceKind; label: string }[] = [
  { value: 'note', label: 'Notes' },
  { value: 'annotation', label: 'Shared highlights' },
  { value: 'comment', label: 'Earlier submitted comments' },
  { value: 'withdrawal', label: 'Withdrawals' },
]

const SCOPES: { value: SavedViewScope; label: string }[] = [
  { value: 'passage', label: 'Passage' },
  { value: 'paragraph', label: 'Paragraph' },
  { value: 'chapter', label: 'Chapter' },
  { value: 'book', label: 'Whole book' },
]

const STATES: { value: SavedViewState; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'new', label: 'New' },
  { value: 'resolved', label: 'Resolved' },
]

/** What a failure code means, in Mike's words. Never the server's own text. */
const REFUSALS: Record<string, string> = {
  not_authorized: 'Your session is no longer signed in, so nothing was changed. Sign in again.',
  bad_csrf: 'That request was not accepted, so nothing was changed. Reload the page and try again.',
  bad_request: 'That request was refused as malformed, so nothing was changed.',
  too_large: 'That request was too large to accept, so nothing was changed.',
  conflict:
    'Something else changed this at the same time, so nothing was changed. Reload to see what it now says.',
  unreadable: 'That record could not be read, so nothing was changed. Nothing has been lost.',
  storage_unavailable: 'There is no durable store configured here, so nothing was changed.',
  incomplete_source:
    'Some of the feedback could not be read, so no file was made. An export has to be complete or it is not an export.',
  metadata_unreadable:
    'Your own record of handling one of these books could not be read, so no file was made and nothing was stamped.',
  write_failed: 'That did not go through, so nothing was changed.',
}

function sentence(code: string): string {
  return REFUSALS[code] ?? 'That did not go through, so nothing was changed.'
}

/** A name, as an id. Empty when the name holds nothing an id can be made of. */
export function viewIdFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
}

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]
}

function when(value: string | null): string {
  if (!value) return 'unknown'
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return 'unknown'
  return new Date(parsed).toLocaleString()
}

type ExportResult = {
  filename: string
  content: string
  format: 'json' | 'markdown'
  itemCount: number
  stamped: 'recorded' | 'not-recorded'
  notFound: string[]
}

export default function FeedbackInbox(props: InboxProps) {
  const {
    csrf,
    rows,
    books,
    chapters,
    savedViews,
    incomplete,
    failures,
    unreadableBooks,
    storageUnavailable,
    notFound,
  } = props

  const [filter, setFilter] = useState<InboxFilter>(ALL_FEEDBACK)
  const [views, setViews] = useState<SavedView[] | null>(savedViews)
  const [viewName, setViewName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  /**
   * The triage this browser has been told about, over the server's rows.
   *
   * Keyed by `rowKey` -- the `(bookSlug, itemId)` coordinate -- and not by the
   * item id, which does not identify a row: two books may each hold the same id,
   * and an id-keyed map answers for both.
   */
  const [resolvedOverride, setResolvedOverride] = useState<Record<string, boolean>>({})

  const [format, setFormat] = useState<'json' | 'markdown'>('json')
  /** Reset after every export: naming by display name is asked for each time. */
  const [useNames, setUseNames] = useState(false)
  const [exportBooks, setExportBooks] = useState<string[]>([])
  const [result, setResult] = useState<ExportResult | null>(null)

  /*
   * Confirmed state **first**, then the filter.
   *
   * These are two versions of the same rows, and selecting from one while
   * rendering the other is how a reopened item stays in a Resolved-only view: it
   * was resolved when the predicate looked at it and unresolved by the time it
   * was painted. The server's answer is the current state, so the predicate has
   * to see it -- which also means a freshly resolved row appears in Resolved
   * rather than only after a reload.
   */
  const shown = useMemo(() => {
    const current = rows.map((row) => {
      const key = rowKey(row.bookSlug, row.itemId)
      return key in resolvedOverride ? { ...row, resolved: resolvedOverride[key] } : row
    })
    const applied = filterRows(current, filter)
    return { rows: applied.rows, stateUnknown: applied.stateUnknown }
  }, [rows, filter, resolvedOverride])

  const degraded = incomplete || unreadableBooks.length > 0 || views === null || storageUnavailable

  const post = useCallback(
    async (key: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
      setBusy(key)
      setProblem(null)
      setStatus(null)
      try {
        const response = await fetch('/admin/api/feedback', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, csrf }),
        })
        const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null
        if (!response.ok || !answer || answer.ok !== true) {
          const code = answer && typeof answer.error === 'string' ? answer.error : 'write_failed'
          setProblem(sentence(code))
          return null
        }
        return answer
      } catch {
        /*
         * The answer never arrived. The action may or may not have happened,
         * and this is not the place to guess: nothing is retried, nothing is
         * assumed, and the page keeps showing what it was showing.
         */
        setProblem(
          'No answer came back, so there is no way to tell from here whether that happened. ' +
            'Reload before doing it again.',
        )
        return null
      } finally {
        setBusy(null)
      }
    },
    [csrf],
  )

  const setResolved = useCallback(
    async (row: InboxRow, resolved: boolean) => {
      const key = rowKey(row.bookSlug, row.itemId)
      const answer = await post(`resolve:${key}`, {
        intent: 'resolve',
        bookSlug: row.bookSlug,
        itemId: row.itemId,
        resolved,
      })
      if (!answer) return
      // The server's answer, not this browser's assumption about it, and
      // recorded against the one coordinate this request named.
      setResolvedOverride((current) => ({
        ...current,
        [key]: answer.resolved === true,
      }))
      setStatus(answer.resolved === true ? 'Marked resolved.' : 'Reopened.')
    },
    [post],
  )

  const saveView = useCallback(async () => {
    /*
     * Structural filters and a name, and there is no line here that could add
     * anything else: the object is built field by field from `filter`, which
     * holds slugs, coordinates and enumerated values. No row, no body, no
     * quotation and no person is in scope at this call site.
     */
    const answer = await post('save-view', {
      intent: 'save-view',
      view: {
        id: viewIdFor(viewName),
        name: viewName,
        books: filter.books,
        chapters: filter.chapters,
        kinds: filter.kinds,
        scopes: filter.scopes,
        state: filter.state,
      },
    })
    if (!answer) return
    setViews((answer.views as SavedView[]) ?? [])
    setStatus('View saved.')
    setViewName('')
  }, [post, viewName, filter])

  const deleteView = useCallback(
    async (view: SavedView) => {
      const answer = await post(`delete-view:${view.id}`, {
        intent: 'delete-view',
        viewId: view.id,
      })
      if (!answer) return
      setViews((answer.views as SavedView[]) ?? [])
      setStatus('View deleted.')
    },
    [post],
  )

  const applyView = useCallback((view: SavedView) => {
    setFilter({
      books: [...view.books],
      chapters: [...view.chapters],
      kinds: [...view.kinds],
      scopes: [...view.scopes],
      state: view.state,
    })
    setStatus(`Showing “${view.name}”.`)
  }, [])

  const generate = useCallback(async () => {
    setResult(null)
    const answer = await post('export', {
      intent: 'export',
      format,
      naming: useNames ? 'display-name' : 'pseudonym',
      ...(exportBooks.length > 0 ? { bookSlugs: exportBooks } : {}),
    })
    // Asked for each time: whatever happened, the next export is pseudonymous
    // again unless Mike ticks the box again.
    setUseNames(false)
    if (!answer) return
    setResult({
      filename: String(answer.filename ?? 'author-feedback'),
      content: String(answer.content ?? ''),
      format,
      itemCount: Number(answer.itemCount ?? 0),
      stamped: answer.stamped === 'recorded' ? 'recorded' : 'not-recorded',
      notFound: Array.isArray(answer.notFound) ? (answer.notFound as string[]) : [],
    })
    setStatus(`A file was made with ${Number(answer.itemCount ?? 0)} item(s) in it.`)
  }, [post, format, useNames, exportBooks])

  /**
   * Save what the server already made.
   *
   * This cannot fail back into a new export. If the browser will not make a
   * download, that is said and the file is still here to copy -- the packet in
   * `result` is the one the server generated and stamped, and it does not need
   * to be generated twice.
   */
  const download = useCallback(() => {
    if (!result) return
    try {
      const blob = new Blob([result.content], {
        type: result.format === 'json' ? 'application/json' : 'text/markdown',
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = result.filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      setStatus('Saved.')
    } catch {
      setProblem(
        'This browser would not save the file. The file itself was made and is still below — ' +
          'copy it instead. Nothing needs generating again.',
      )
    }
  }, [result])

  const copy = useCallback(async () => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.content)
      setStatus('Copied.')
    } catch {
      setProblem(
        'This browser would not copy to the clipboard. The file was made and is still below. ' +
          'Nothing needs generating again.',
      )
    }
  }, [result])

  return (
    <div className="af-root">
      {/* ------------------------------------------------- what went wrong */}

      {storageUnavailable ? (
        <p className="ad-note ad-note--bad" role="alert">
          There is no durable store configured here, so your own record of what you have read,
          resolved and exported cannot be read or written. What is listed below is what was
          shared with you; how you have handled it is not being shown.
        </p>
      ) : null}

      {incomplete ? (
        <p className="ad-note ad-note--bad" role="alert">
          Some of the feedback could not be read just now, so this list is not complete. This is
          a storage fault, not an empty inbox — what is missing has not been lost, and exporting
          is refused until it can be read again.{' '}
          {failures.length > 0 ? (
            <span>
              Could not be read:{' '}
              {failures
                .map((entry) => (entry.bookSlug ? `${entry.source} (${entry.bookSlug})` : entry.source))
                .join(', ')}
              .
            </span>
          ) : null}
        </p>
      ) : null}

      {unreadableBooks.length > 0 ? (
        <p className="ad-note ad-note--bad" role="alert">
          Your own record of what you have read and resolved could not be read for{' '}
          {unreadableBooks.join(', ')}. Those rows are shown without a state rather than as new
          and unresolved, which is not something that can be known from here.
        </p>
      ) : null}

      {views === null ? (
        <p className="ad-note ad-note--bad" role="alert">
          Your saved views could not be read, so none are being offered. This is not an empty
          list — saving one now would write over whatever is there.
        </p>
      ) : null}

      {notFound.length > 0 ? (
        <p className="ad-note" role="status">
          No manuscript is loaded for {notFound.join(', ')}, so nothing is listed for it.
        </p>
      ) : null}

      {problem ? (
        <p className="ad-note ad-note--bad" role="alert">
          {problem}
        </p>
      ) : null}

      <p className="ad-note ad-note--quiet" role="status" aria-live="polite">
        {status ?? 'Nothing has been changed on this page.'}
      </p>

      {/* ------------------------------------------------------- the filters */}

      <section className="af-section" aria-labelledby="af-filters">
        <h2 className="ad-section-title" id="af-filters">
          Show
        </h2>

        <div className="af-filter-grid">
          <fieldset className="ad-fieldset">
            <legend className="ad-label ad-legend">Books</legend>
            <div className="ad-books">
              {books.length === 0 ? <p className="ad-hint">No book has been read.</p> : null}
              {books.map((book) => (
                <label className="ad-book" key={book.slug}>
                  <input
                    type="checkbox"
                    checked={filter.books.includes(book.slug)}
                    onChange={() =>
                      setFilter((current) => ({ ...current, books: toggle(current.books, book.slug) }))
                    }
                  />
                  <span>{book.title}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="ad-field">
            <label className="ad-label" htmlFor="af-chapter">
              Chapter
            </label>
            <select
              id="af-chapter"
              className="ad-input"
              value={filter.chapters[0] ?? ''}
              onChange={(event) =>
                setFilter((current) => ({
                  ...current,
                  chapters: event.target.value === '' ? [] : [event.target.value],
                }))
              }
            >
              <option value="">Every chapter</option>
              {chapters.map((chapter) => (
                <option key={chapter.coordinate} value={chapter.coordinate}>
                  {chapter.bookTitle} · {chapter.label}
                </option>
              ))}
            </select>
          </div>

          <fieldset className="ad-fieldset">
            <legend className="ad-label ad-legend">Kind</legend>
            <div className="ad-books">
              {KINDS.map((kind) => (
                <label className="ad-book" key={kind.value}>
                  <input
                    type="checkbox"
                    checked={filter.kinds.includes(kind.value)}
                    onChange={() =>
                      setFilter((current) => ({ ...current, kinds: toggle(current.kinds, kind.value) }))
                    }
                  />
                  <span>{kind.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="ad-fieldset">
            <legend className="ad-label ad-legend">Scope</legend>
            <div className="ad-books">
              {SCOPES.map((scope) => (
                <label className="ad-book" key={scope.value}>
                  <input
                    type="checkbox"
                    checked={filter.scopes.includes(scope.value)}
                    onChange={() =>
                      setFilter((current) => ({
                        ...current,
                        scopes: toggle(current.scopes, scope.value),
                      }))
                    }
                  />
                  <span>{scope.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="ad-field">
            <label className="ad-label" htmlFor="af-state">
              State
            </label>
            <select
              id="af-state"
              className="ad-input"
              value={filter.state}
              onChange={(event) =>
                setFilter((current) => ({
                  ...current,
                  state: event.target.value as SavedViewState,
                }))
              }
            >
              {STATES.map((state) => (
                <option key={state.value} value={state.value}>
                  {state.label}
                </option>
              ))}
            </select>
            <p className="ad-hint">
              New and Resolved are separate. Something you resolved and a reviewer then edited is
              both.
            </p>
          </div>
        </div>

        <div className="ad-btn-row">
          <button type="button" className="ad-btn ad-btn--small" onClick={() => setFilter(ALL_FEEDBACK)}>
            Clear filters
          </button>
        </div>
      </section>

      {/* --------------------------------------------------- the saved views */}

      <section className="af-section" aria-labelledby="af-views">
        <h2 className="ad-section-title" id="af-views">
          Saved views
        </h2>
        <p className="ad-hint">
          A saved view keeps the filters above and nothing else — no words from anybody&rsquo;s
          note, and no name but the one you give it.
        </p>

        {views === null ? null : views.length === 0 ? (
          <p className="ad-hint">You have not saved a view yet.</p>
        ) : (
          <ul className="af-views">
            {views.map((view) => (
              <li key={view.id} className="af-view">
                <button
                  type="button"
                  className="ad-btn ad-btn--small"
                  onClick={() => applyView(view)}
                >
                  {view.name}
                </button>
                <button
                  type="button"
                  className="ad-btn ad-btn--small ad-btn--danger"
                  disabled={busy !== null}
                  aria-busy={busy === `delete-view:${view.id}`}
                  onClick={() => void deleteView(view)}
                >
                  {busy === `delete-view:${view.id}` ? 'Deleting…' : `Delete ${view.name}`}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="ad-field">
          <label className="ad-label" htmlFor="af-view-name">
            Name for these filters
          </label>
          <input
            id="af-view-name"
            className="ad-input"
            value={viewName}
            onChange={(event) => setViewName(event.target.value)}
            aria-describedby="af-view-help"
          />
          <p className="ad-hint" id="af-view-help">
            Saving a name you already used replaces that view.
          </p>
        </div>
        <div className="ad-btn-row">
          <button
            type="button"
            className="ad-btn ad-btn--primary ad-btn--small"
            disabled={busy !== null}
            aria-busy={busy === 'save-view'}
            onClick={() => void saveView()}
          >
            {busy === 'save-view' ? 'Saving…' : 'Save this view'}
          </button>
        </div>
      </section>

      {/* -------------------------------------------------------- the export */}

      <section className="af-section" aria-labelledby="af-export">
        <h2 className="ad-section-title" id="af-export">
          Export
        </h2>
        <p className="ad-hint">
          A file made here and handed straight back. Nothing is sent anywhere, nothing is kept on
          the server, and no model reads it. Once it is on your computer it is yours — the site
          cannot withdraw a copy it no longer holds.
        </p>

        <div className="ad-field">
          <label className="ad-label" htmlFor="af-format">
            Format
          </label>
          <select
            id="af-format"
            className="ad-input"
            value={format}
            onChange={(event) => setFormat(event.target.value === 'markdown' ? 'markdown' : 'json')}
          >
            <option value="json">JSON</option>
            <option value="markdown">Markdown</option>
          </select>
        </div>

        <label className="ad-book">
          <input
            type="checkbox"
            checked={useNames}
            onChange={(event) => setUseNames(event.target.checked)}
          />
          <span>Use reviewers&rsquo; names in this file instead of “Reviewer 1”</span>
        </label>

        <fieldset className="ad-fieldset">
          <legend className="ad-label ad-legend">Books in the file</legend>
          <p className="ad-hint">
            Tick none and every book you can open is included. What is ticked here is what is
            sent; the filters above do not change it.
          </p>
          <div className="ad-books">
            {books.map((book) => (
              <label className="ad-book" key={`export-${book.slug}`}>
                <input
                  type="checkbox"
                  checked={exportBooks.includes(book.slug)}
                  onChange={() => setExportBooks((current) => toggle(current, book.slug))}
                />
                <span>{book.title}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="ad-btn-row">
          <button
            type="button"
            className="ad-btn ad-btn--primary"
            disabled={busy !== null || incomplete}
            aria-busy={busy === 'export'}
            onClick={() => void generate()}
          >
            {busy === 'export' ? 'Making the file…' : 'Make the file'}
          </button>
        </div>
        {incomplete ? (
          <p className="ad-hint">
            Exporting is refused while part of the feedback cannot be read. A file that quietly
            left something out would be worse than no file.
          </p>
        ) : null}

        {result ? (
          <div className="af-result">
            <p className="ad-hint">
              <b>{result.filename}</b> — {result.itemCount} item(s).{' '}
              {result.stamped === 'recorded'
                ? 'Each of them now records when it last left in a file.'
                : 'That record could not be written for all of them, so some still say they have never been exported. The file itself is complete.'}
            </p>
            {result.notFound.length > 0 ? (
              <p className="ad-hint">
                No manuscript is loaded for {result.notFound.join(', ')}, so nothing from it is in
                the file.
              </p>
            ) : null}
            <div className="ad-btn-row">
              <button type="button" className="ad-btn ad-btn--small" onClick={download}>
                Download
              </button>
              <button type="button" className="ad-btn ad-btn--small" onClick={() => void copy()}>
                Copy
              </button>
            </div>
            <p className="ad-hint">
              Downloading or copying again uses the file that was already made. Making a new one
              is a new export.
            </p>
          </div>
        ) : null}
      </section>

      {/* ---------------------------------------------------------- the list */}

      <section className="af-section" aria-labelledby="af-list">
        <h2 className="ad-section-title" id="af-list">
          {shown.rows.length === rows.length
            ? `Everything shared with you (${rows.length})`
            : `${shown.rows.length} of ${rows.length}`}
        </h2>

        {shown.stateUnknown > 0 ? (
          <p className="ad-note ad-note--bad" role="alert">
            {shown.stateUnknown} item(s) match these filters and could not be placed in that state,
            because your own record for their book could not be read. They are not being counted
            as new and not being counted as resolved.
          </p>
        ) : null}

        {shown.rows.length === 0 ? (
          degraded ? (
            <p className="ad-note ad-note--bad" role="alert">
              Nothing matched — but part of this could not be read, so that is not the same as
              there being nothing. Do not read this as an empty inbox.
            </p>
          ) : (
            <p className="ad-empty">
              Nothing matches these filters. A reviewer&rsquo;s private notes stay private — you
              see only what they chose to share.
            </p>
          )
        ) : null}

        <ol className="af-rows">
          {shown.rows.map((row) => (
            <li className="af-row" key={rowKey(row.bookSlug, row.itemId)}>
              <p className="af-row-where">
                <span className="af-row-who">{row.attribution ?? 'Nobody named'}</span> ·{' '}
                {row.bookTitle}
                {row.chapterLabel ? ` · ${row.chapterLabel}` : ''}
                {row.paragraphOrdinal ? ` · paragraph ${row.paragraphOrdinal}` : ''}
              </p>

              <p className="af-row-kind">
                {row.kind === 'withdrawal'
                  ? 'Withdrawn'
                  : row.kind === 'comment'
                    ? 'Earlier submitted comment'
                    : row.kind === 'annotation'
                      ? 'Shared highlight'
                      : row.triage === 'author'
                        ? 'Your own note'
                        : 'Note'}
                {' · '}
                {row.triage === 'author'
                  ? row.authorNoteStatus === 'resolved'
                    ? 'Resolved'
                    : 'Open'
                  : !row.triageKnown
                    ? 'State unknown — your record for this book could not be read'
                    : `${row.isNew ? 'New' : 'Not new'} · ${row.resolved ? 'Resolved' : 'Unresolved'}`}
                {' · '}
                {when(row.occurredAt)}
              </p>

              {row.kind === 'withdrawal' ? (
                <p className="af-row-body af-row-body--none">
                  This was taken back. Nothing of what it said was kept, so there is nothing here
                  to show.
                </p>
              ) : (
                <>
                  {row.captured ? <blockquote className="ad-quote">{row.captured}</blockquote> : null}
                  {row.body ? (
                    <p className="af-row-body">{row.body}</p>
                  ) : (
                    <p className="af-row-body af-row-body--none">
                      A highlight with nothing written about it.
                    </p>
                  )}
                </>
              )}

              {row.anchorState === 'needs-relocation' ? (
                <p className="ad-note ad-note--bad">
                  The manuscript has changed here, so this no longer points at the same words.
                </p>
              ) : null}

              {row.changedSinceRead ? (
                <p className="ad-hint">Changed since you read it.</p>
              ) : null}
              {row.changedSinceExport ? (
                <p className="ad-hint">Changed since you exported it.</p>
              ) : null}

              <div className="ad-btn-row">
                <a className="ad-btn ad-btn--small" href={row.detailHref}>
                  Open this
                </a>
                {row.triage === 'reviewer' && row.triageKnown ? (
                  <button
                    type="button"
                    className="ad-btn ad-btn--small"
                    disabled={busy !== null}
                    aria-busy={busy === `resolve:${rowKey(row.bookSlug, row.itemId)}`}
                    onClick={() => void setResolved(row, !row.resolved)}
                  >
                    {busy === `resolve:${rowKey(row.bookSlug, row.itemId)}`
                      ? 'Saving…'
                      : row.resolved
                        ? `Reopen this ${row.kind}`
                        : `Mark this ${row.kind} resolved`}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
