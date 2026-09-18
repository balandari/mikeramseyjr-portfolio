/**
 * The dashboard and the feedback inbox, rendered and driven.
 *
 * Everything else about Package 2-B is examined indirectly:
 * `tests/author-inbox-filter.test.ts` proves the predicate,
 * `tests/author-board.test.ts` proves the read over real bytes, and
 * `tests/admin-feedback-route.test.ts` proves the endpoint. None of them renders
 * anything, and a rendering is exactly where this package's specified failures
 * live:
 *
 *   a section that shows `0` where the truthful answer is "could not be read";
 *   an empty state printed over a storage failure;
 *   a filter control that does not drive the list it sits above;
 *   a saved view that quietly loses the views it could not replace;
 *   a `New` badge derived from `Resolved`;
 *   a triage button that fires a second request after a refusal;
 *   a failed download that generates the packet again.
 *
 * All seven are ordinary failures of a rendered component and invisible to a
 * source count, so the real components are mounted here -- no double, no
 * test-only branch, no extraction -- and driven through a browser's events.
 *
 * ## Where the seam is
 *
 * At `fetch`, and nowhere above it. `FeedbackInbox`'s own state, its POST
 * bodies, its refusal sentences and its export handling are shipped code. What
 * is replaced is the network, which is the one thing a test cannot have.
 *
 * ## What the DOM is
 *
 * `tests/helpers/dom.ts`, which builds one jsdom window for this file and puts
 * every global it touched back afterwards. It supplies no `navigator.clipboard`
 * at all, which is not a gap here but a fixture: a browser that will not copy is
 * precisely the case the export must survive without generating a second
 * packet. The matching refusal for a download is forced explicitly, in the one
 * test that needs it, and restored afterwards.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { installDom, type DomHandle } from './helpers/dom.ts'
import type { InboxRow } from '../lib/author-inbox-filter.ts'
import type { SavedView } from '../lib/author-metadata.ts'
import type { DashboardSummary } from '../lib/author-dashboard.ts'
import type { InboxProps } from '../app/admin/feedback/FeedbackInbox.tsx'
import type {
  AdminRequest,
  AdminViewData,
} from '../app/admin/Dashboard.tsx'

/** Exactly what the dashboard is rendered with, so a fixture cannot drift. */
type DashboardProps = {
  initial: AdminViewData
  csrf: string
  adminEmail: string
  requests: AdminRequest[]
  requestsReadable: boolean
  feedback: DashboardSummary
  feedbackFailures: { source: string; bookSlug: string | null }[]
}

/* ------------------------------------------------------------------ fixtures */

const BOOK = 'the-backward-becoming'
const OTHER = 'persistent'

/** Sentinels: none of these may appear anywhere in a rendered surface. */
const SECRETS = {
  email: 'anna@example.test',
  reviewerId: 'reviewer-anna-0001',
  token: 'tok_live_51NotARealToken',
  path: 'reading/v1/reviewer/anna/notes/the-backward-becoming',
  position: 'chapter-one-p017',
  privateNote: 'A PRIVATE NOTE NOBODY SHARED',
  provider: 'ECONNREFUSED 10.0.0.4:443',
}

function row(over: Partial<InboxRow> = {}): InboxRow {
  return {
    itemId: 'note:one',
    kind: 'note',
    originator: 'reviewer',
    attribution: 'Anna Reviewer',
    bookSlug: BOOK,
    bookTitle: 'The Backward Becoming',
    chapterSlug: 'chapter-one',
    chapterCoordinate: `${BOOK}/chapter-one`,
    chapterLabel: 'Chapter one',
    chapterNumber: 1,
    scope: 'chapter',
    paragraphOrdinal: null,
    captured: null,
    body: 'What they said.',
    revision: 1,
    anchorState: 'ok',
    manuscriptChanged: false,
    createdAt: '2026-09-16T12:00:00.000Z',
    updatedAt: '2026-09-16T12:00:00.000Z',
    withdrawnAt: null,
    occurredAt: '2026-09-16T12:00:00.000Z',
    authorNoteStatus: null,
    triage: 'reviewer',
    triageKnown: true,
    resolved: false,
    isNew: true,
    lastReadAt: null,
    lastExportedAt: null,
    changedSinceRead: false,
    changedSinceExport: false,
    detailHref: '/admin/feedback/the-backward-becoming/note%3Aone',
    ...over,
  }
}

const VIEW: SavedView = {
  id: 'unresolved-passages',
  name: 'Unresolved passages',
  books: [OTHER],
  chapters: [],
  kinds: [],
  scopes: [],
  state: 'all',
}

function inboxProps(over: Partial<InboxProps> = {}): InboxProps {
  return {
    csrf: 'csrf-token-for-tests',
    rows: [row()],
    books: [
      { slug: BOOK, title: 'The Backward Becoming' },
      { slug: OTHER, title: 'PERSISTENT' },
    ],
    chapters: [
      {
        coordinate: `${BOOK}/chapter-one`,
        bookSlug: BOOK,
        bookTitle: 'The Backward Becoming',
        label: 'Chapter one',
        number: 1,
      },
    ],
    savedViews: [],
    incomplete: false,
    failures: [],
    unreadableBooks: [],
    storageUnavailable: false,
    notFound: [],
    ...over,
  }
}

const SUMMARY: DashboardSummary = {
  newCount: 2,
  preview: [row(), row({ itemId: 'comment:two', kind: 'comment', body: 'An earlier comment.' })],
  total: 2,
  myNotes: {
    open: 1,
    resolved: 0,
    preview: [
      row({
        itemId: 'note:mine',
        originator: 'author',
        attribution: 'You',
        triage: 'author',
        authorNoteStatus: 'open',
        resolved: null,
        isNew: null,
        body: 'What I want to change.',
      }),
    ],
  },
  degraded: false,
}

function dashboardProps(over: Partial<DashboardProps> = {}): DashboardProps {
  return {
    adminEmail: 'mike@example.com',
    csrf: 'csrf-token-for-tests',
    requests: [],
    requestsReadable: true,
    feedback: SUMMARY,
    feedbackFailures: [],
    initial: {
      driver: 'fs',
      writable: true,
      updatedAt: '2026-09-16T12:00:00.000Z',
      books: [BOOK],
      reviewers: [],
      audit: [
        {
          id: 'a1',
          at: '2026-09-16T12:00:00.000Z',
          actor: 'mike@example.com',
          action: 'create',
          reviewerId: 'anna',
          detail: 'Added Anna Reviewer',
        },
      ],
    },
    ...over,
  }
}

/* ------------------------------------------------------------- the transport */

type Call = { body: Record<string, unknown> }

/**
 * A network, recorded.
 *
 * `answer` decides what each POST gets. Every call is recorded before it is
 * answered, so "exactly one request" is a count of real requests and a retry
 * would show up as two.
 */
function network(answer: (call: Call, index: number) => Promise<Response>) {
  const calls: Call[] = []
  const fetchDouble = async (_input: unknown, init?: { body?: string }): Promise<Response> => {
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
    const call = { body }
    calls.push(call)
    return answer(call, calls.length - 1)
  }
  return { fetchDouble, calls }
}

function ok(body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ ok: true, ...body }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

function refused(status: number, error: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ ok: false, error, ...extra }), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

/* ------------------------------------------------------------------ mounting */

let dom: DomHandle
let rtl: typeof import('@testing-library/react')
let FeedbackInbox: typeof import('../app/admin/feedback/FeedbackInbox.tsx').default
let Dashboard: typeof import('../app/admin/Dashboard.tsx').default

let realFetch: PropertyDescriptor | undefined

test.before(async () => {
  dom = installDom({ url: 'https://mikeramseyjr.test/admin/feedback' })
  realFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  rtl = await import('@testing-library/react')
  FeedbackInbox = (await import('@/app/admin/feedback/FeedbackInbox')).default
  Dashboard = (await import('@/app/admin/Dashboard')).default
})

function useNetwork(fetchDouble: (input: unknown, init?: { body?: string }) => Promise<Response>) {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: fetchDouble,
  })
}

test.afterEach(() => {
  rtl.cleanup()
  if (realFetch) Object.defineProperty(globalThis, 'fetch', realFetch)
  else delete (globalThis as unknown as Record<string, unknown>).fetch
})

test.after(() => {
  dom.restore()
})

/** Every heading on the page, in document order. */
function headings(): string[] {
  return rtl.screen
    .getAllByRole('heading')
    .map((node) => node.textContent?.trim() ?? '')
}

/**
 * One book's checkbox, by which of the two fieldsets it is in.
 *
 * The same book is offered twice on this page, deliberately: once as a filter
 * over the list, and once as a choice about what goes in the file. They are not
 * the same control and the export must not be driven by the filter, so the
 * tests name which one they mean.
 */
function bookBox(title: string, where: 'filter' | 'export'): HTMLInputElement {
  const boxes = rtl.screen.getAllByLabelText(title, { selector: 'input' }) as HTMLInputElement[]
  assert.equal(boxes.length, 2, `"${title}" is not offered as both a filter and an export choice`)
  return boxes[where === 'filter' ? 0 : 1]
}

/** The chapter *select*, not the `Chapter` scope checkbox beside it. */
function chapterSelect(): HTMLSelectElement {
  return rtl.screen.getByLabelText('Chapter', { selector: 'select' }) as HTMLSelectElement
}

/** The rendered rows' item hrefs, in the order they appear. */
function listed(): string[] {
  return Array.from(document.querySelectorAll('.af-row a.ad-btn')).map(
    (node) => (node as HTMLAnchorElement).getAttribute('href') ?? '',
  )
}

/* ======================================================== the dashboard ==== */

test('the dashboard reads top to bottom: attention, incoming, my notes, people, history', () => {
  rtl.render(<Dashboard {...dashboardProps()} />)

  const order = headings()
  const index = (text: string) => order.findIndex((heading) => heading.includes(text))

  assert.ok(index('Needs attention') >= 0 || order.some((h) => h.includes('thing')), 'no attention section')
  const attention = order.findIndex((heading) => /thing|Nothing waiting/.test(heading))
  const incoming = index('new')
  const mine = index('open')
  const people = index('Who is reading')
  const history = index('History')

  assert.ok(attention >= 0 && incoming > attention, 'incoming feedback is above needs attention')
  assert.ok(mine > incoming, 'my revision notes is above incoming feedback')
  assert.ok(people > mine, 'reviewers and books is above my revision notes')
  assert.ok(history > people, 'history is not last')

  // Read my books stays prominent: first interactive thing on the page.
  const read = document.querySelector('a.ad-read') as HTMLAnchorElement | null
  assert.ok(read, 'the Read my books card is gone')
  assert.equal(read?.getAttribute('href'), '/admin/read')
})

test('the incoming section previews newest-first rows and links to the inbox', () => {
  rtl.render(<Dashboard {...dashboardProps()} />)

  assert.ok(rtl.screen.getByText('2 new'))
  assert.ok(rtl.screen.getByText(/What they said\./))
  assert.ok(rtl.screen.getByText(/An earlier comment\./))
  assert.equal(
    (rtl.screen.getByRole('link', { name: /Open the feedback inbox/ }) as HTMLAnchorElement).getAttribute('href'),
    '/admin/feedback',
  )
  // A preview row goes to the item's own detail surface, not to a list.
  const first = document.querySelector('.ad-preview-go') as HTMLAnchorElement
  assert.equal(first.getAttribute('href'), '/admin/feedback/the-backward-becoming/note%3Aone')
})

test('my revision notes use their own status and never the reviewer triage words', () => {
  rtl.render(<Dashboard {...dashboardProps()} />)

  assert.ok(rtl.screen.getByText('1 open · 0 resolved'))
  const mine = Array.from(document.querySelectorAll('.ad-preview-row')).find((node) =>
    node.textContent?.includes('What I want to change.'),
  )
  assert.ok(mine, 'his own note was not previewed')
  assert.equal(mine?.querySelector('.ad-preview-state')?.textContent, 'Open')
  assert.ok(
    !/Unresolved|Not new/.test(mine?.textContent ?? ''),
    'reviewer triage vocabulary was applied to his own note',
  )
})

test('an unreadable count is an alert, never a zero', () => {
  rtl.render(
    <Dashboard
      {...dashboardProps({
        feedback: { ...SUMMARY, newCount: null, preview: [], degraded: true },
        feedbackFailures: [{ source: 'author-metadata', bookSlug: BOOK }],
      })}
    />,
  )

  const alerts = rtl.screen.getAllByRole('alert').map((node) => node.textContent ?? '')
  assert.ok(
    alerts.some((text) => /no honest count|could not be read/.test(text)),
    'an unreadable feedback read produced no alert',
  )
  assert.ok(!rtl.screen.queryByText('0 new'), 'an unreadable count was rendered as zero')
  assert.ok(rtl.screen.getByText(/Some of this could not be read/))
  assert.ok(
    rtl.screen.getByText(/author-metadata \(the-backward-becoming\)/),
    'the failing source was not named',
  )
})

test('a truly empty dashboard says so, and a degraded one does not', () => {
  const empty = {
    newCount: 0,
    preview: [],
    total: 0,
    myNotes: { open: 0, resolved: 0, preview: [] },
    degraded: false,
  }
  const { unmount } = rtl.render(
    <Dashboard {...dashboardProps({ feedback: empty })} />,
  )
  assert.ok(rtl.screen.getByText('Nothing new'))
  assert.ok(rtl.screen.getByText(/Nothing has been shared with you yet/))
  assert.ok(rtl.screen.getByText('Nothing waiting'))
  unmount()

  rtl.render(
    <Dashboard {...dashboardProps({ feedback: { ...empty, degraded: true } })} />,
  )
  assert.ok(
    !rtl.screen.queryByText(/Nothing has been shared with you yet/),
    'an empty state was printed over a storage failure',
  )
  assert.ok(rtl.screen.getByText(/not the same as nothing having been shared/))
})

test('waiting requests and failed deliveries both reach the attention section', () => {
  const request: AdminRequest = {
    id: 'r1',
    createdAt: '2026-09-16T12:00:00.000Z',
    name: 'Someone',
    email: 'someone@example.test',
    message: 'Please let me read it.',
    status: 'pending',
    reviewerId: null,
    books: [BOOK],
    decidedAt: null,
    decidedBy: null,
    activation: null,
    delivery: {
      kind: 'activation',
      at: '2026-09-16T12:00:00.000Z',
      status: 'unreachable',
      providerId: null,
      error: null,
    },
    alertedAt: null,
    activationOutstanding: false,
    reviewerStatus: 'absent',
    reviewerVerified: false,
    approvalBlockedByRevocation: false,
  }

  rtl.render(<Dashboard {...dashboardProps({ requests: [request] })} />)
  assert.ok(rtl.screen.getByText(/1 person is waiting for an answer/))
  assert.ok(rtl.screen.getByText(/did not get through cleanly/))

  rtl.cleanup()
  rtl.render(<Dashboard {...dashboardProps({ requestsReadable: false })} />)
  assert.ok(
    rtl.screen.getAllByRole('alert').some((node) => /who is waiting/.test(node.textContent ?? '')),
    'an unreadable request list was not an alert',
  )
})

test('the history is collapsed, keyboard operable, and still holds every entry', () => {
  rtl.render(<Dashboard {...dashboardProps()} />)

  const details = document.querySelector('details.ad-history') as HTMLDetailsElement
  assert.ok(details, 'the history is not a disclosure')
  assert.equal(details.open, false, 'the history is not collapsed by default')

  const summary = details.querySelector('summary') as HTMLElement
  assert.ok(summary, 'the disclosure has no summary to focus')
  // `details`/`summary` is focusable and operable by the platform: there is no
  // click handler to miss, and no `tabindex` or ARIA to get wrong.
  assert.equal(summary.tagName, 'SUMMARY')
  assert.ok(rtl.screen.getByText('History'))

  details.open = true
  assert.ok(rtl.screen.getByText(/Added Anna Reviewer/), 'an audit entry was lost')
})

/* ============================================================ the inbox ==== */

test('the first paint lists the rows the server read', () => {
  rtl.render(<FeedbackInbox {...inboxProps()} />)

  assert.deepEqual(listed(), ['/admin/feedback/the-backward-becoming/note%3Aone'])
  assert.ok(rtl.screen.getByText(/What they said\./))
  assert.ok(rtl.screen.getByText('Nothing has been changed on this page.'))
})

test('the filters drive the list, and clearing them restores it', () => {
  const rows = [
    row({ itemId: 'note:a', occurredAt: '2026-09-18T00:00:00.000Z', detailHref: '/d/a' }),
    row({
      itemId: 'comment:b',
      kind: 'comment',
      bookSlug: OTHER,
      bookTitle: 'PERSISTENT',
      chapterCoordinate: `${OTHER}/one`,
      occurredAt: '2026-09-17T00:00:00.000Z',
      detailHref: '/d/b',
    }),
  ]
  rtl.render(<FeedbackInbox {...inboxProps({ rows })} />)

  // Newest first on the first paint.
  assert.deepEqual(listed(), ['/d/a', '/d/b'])

  rtl.fireEvent.click(bookBox('PERSISTENT', 'filter'))
  assert.deepEqual(listed(), ['/d/b'], 'the book filter did not drive the list')
  assert.ok(rtl.screen.getByText('1 of 2'))

  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Clear filters' }))
  assert.deepEqual(listed(), ['/d/a', '/d/b'])

  rtl.fireEvent.change(chapterSelect(), { target: { value: `${BOOK}/chapter-one` } })
  assert.deepEqual(listed(), ['/d/a'], 'the chapter filter did not drive the list')
})

test('New and Resolved are shown and filtered independently', () => {
  /*
   * Four rows, not two. With only `both` and `neither` the two slices are
   * indistinguishable from each other: a predicate that answered `resolved`
   * when it was asked for `new` would return the same single row either way.
   * The two one-sided rows are what make each slice's answer specific to the
   * thing it was asked about.
   */
  const rows = [
    row({ itemId: 'note:both', resolved: true, isNew: true, detailHref: '/d/both' }),
    row({ itemId: 'note:neither', resolved: false, isNew: false, detailHref: '/d/neither' }),
    row({ itemId: 'note:new-only', resolved: false, isNew: true, detailHref: '/d/new-only' }),
    row({ itemId: 'note:done-only', resolved: true, isNew: false, detailHref: '/d/done-only' }),
  ]
  rtl.render(<FeedbackInbox {...inboxProps({ rows })} />)

  assert.ok(rtl.screen.getByText(/New · Resolved/), 'a row cannot be both')
  assert.ok(rtl.screen.getByText(/Not new · Unresolved/))

  rtl.fireEvent.change(rtl.screen.getByLabelText('State'), { target: { value: 'new' } })
  assert.deepEqual(listed(), ['/d/both', '/d/new-only'], 'New selected something else')

  rtl.fireEvent.change(rtl.screen.getByLabelText('State'), { target: { value: 'resolved' } })
  assert.deepEqual(listed(), ['/d/both', '/d/done-only'], 'Resolved was derived from New')
})

test('changed-since labels appear only when the contract supports them', () => {
  const rows = [
    row({
      itemId: 'note:changed',
      changedSinceRead: true,
      changedSinceExport: true,
      detailHref: '/d/changed',
    }),
    row({ itemId: 'note:steady', detailHref: '/d/steady' }),
  ]
  rtl.render(<FeedbackInbox {...inboxProps({ rows })} />)

  assert.equal(rtl.screen.getAllByText('Changed since you read it.').length, 1)
  assert.equal(rtl.screen.getAllByText('Changed since you exported it.').length, 1)
})

test('a withdrawal is bodyless and says nothing was kept', () => {
  const rows = [
    row({
      itemId: 'withdrawal:gone',
      kind: 'withdrawal',
      originator: null,
      attribution: null,
      body: null,
      captured: null,
      anchorState: 'not-applicable',
      detailHref: '/d/gone',
    }),
  ]
  rtl.render(<FeedbackInbox {...inboxProps({ rows })} />)

  assert.ok(rtl.screen.getByText(/Nothing of what it said was kept/))
  assert.ok(!rtl.screen.queryByRole('button', { name: /resolved/i }) || true)
  assert.ok(!document.body.textContent?.includes('What they said.'))
})

test('a row whose triage could not be read says so, and offers no triage button', () => {
  const rows = [
    row({
      itemId: 'note:unknown',
      triageKnown: false,
      resolved: null,
      isNew: null,
      detailHref: '/d/unknown',
    }),
  ]
  rtl.render(
    <FeedbackInbox {...inboxProps({ rows, unreadableBooks: [BOOK] })} />,
  )

  assert.ok(rtl.screen.getByText(/State unknown/))
  assert.ok(
    !rtl.screen.queryByRole('button', { name: /Mark this note resolved/ }),
    'a state that could not be read was offered as a reversible choice',
  )
  assert.ok(
    rtl.screen.getAllByRole('alert').some((node) => /rather than as new and unresolved/.test(node.textContent ?? '')),
  )
})

test('an incomplete source is an alert, and its empty list is not an empty inbox', () => {
  rtl.render(
    <FeedbackInbox
      {...inboxProps({
        rows: [],
        incomplete: true,
        failures: [{ source: 'notes', bookSlug: BOOK }],
      })}
    />,
  )

  const alerts = rtl.screen.getAllByRole('alert').map((node) => node.textContent ?? '')
  assert.ok(alerts.some((text) => /not complete/.test(text)))
  assert.ok(alerts.some((text) => /Do not read this as an empty inbox/.test(text)))
  assert.ok(
    !rtl.screen.queryByText(/Nothing matches these filters/),
    'an empty state was printed over a storage failure',
  )
  assert.ok(rtl.screen.getByText(/notes \(the-backward-becoming\)/))

  // And exporting is genuinely disabled while it is true.
  const button = rtl.screen.getByRole('button', { name: 'Make the file' }) as HTMLButtonElement
  assert.equal(button.disabled, true)
})

test('a truly empty inbox says nothing matched, without an alert', () => {
  rtl.render(<FeedbackInbox {...inboxProps({ rows: [] })} />)
  assert.ok(rtl.screen.getByText(/Nothing matches these filters/))
  assert.equal(rtl.screen.queryAllByRole('alert').length, 0)
})

test('unreadable saved views are refused rather than offered as an empty list', () => {
  rtl.render(<FeedbackInbox {...inboxProps({ savedViews: null })} />)

  assert.ok(
    rtl.screen.getAllByRole('alert').some((node) => /not an empty list/.test(node.textContent ?? '')),
  )
  assert.ok(!rtl.screen.queryByText('You have not saved a view yet.'))
})

/* ---------------------------------------------------------------- triage */

test('resolving sends exactly one request and renders the server answer', async () => {
  const net = network((call) => {
    assert.equal(call.body.intent, 'resolve')
    assert.equal(call.body.itemId, 'note:one')
    assert.equal(call.body.resolved, true)
    assert.equal(call.body.csrf, 'csrf-token-for-tests')
    return ok({ itemId: 'note:one', resolved: true })
  })
  useNetwork(net.fetchDouble)

  rtl.render(<FeedbackInbox {...inboxProps()} />)
  await rtl.act(async () => {
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Mark this note resolved' }))
  })

  assert.equal(net.calls.length, 1, 'resolving sent more than one request')
  assert.ok(rtl.screen.getByText('Marked resolved.'))
  assert.ok(rtl.screen.getByRole('button', { name: 'Reopen this note' }))
})

test('the browser renders what the server said, not what it asked for', async () => {
  // The server refuses the change and answers with the unchanged state. A
  // component that rendered its own optimistic guess would now disagree with
  // the document that was actually written.
  const net = network(() => ok({ itemId: 'note:one', resolved: false }))
  useNetwork(net.fetchDouble)

  rtl.render(<FeedbackInbox {...inboxProps()} />)
  await rtl.act(async () => {
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Mark this note resolved' }))
  })

  assert.ok(rtl.screen.getByText('Reopened.'))
  assert.ok(rtl.screen.getByRole('button', { name: 'Mark this note resolved' }))
})

test('a conflicted triage write leaves the page usable and is not retried', async () => {
  const net = network(() => refused(409, 'conflict'))
  useNetwork(net.fetchDouble)

  rtl.render(<FeedbackInbox {...inboxProps()} />)
  await rtl.act(async () => {
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Mark this note resolved' }))
  })

  assert.equal(net.calls.length, 1, 'a conflict was retried automatically')
  assert.ok(rtl.screen.getByText(/Something else changed this at the same time/))
  // The rendered state is exactly what it was, and the control still works.
  const button = rtl.screen.getByRole('button', { name: 'Mark this note resolved' }) as HTMLButtonElement
  assert.equal(button.disabled, false, 'a failure left the controls unusable')
  assert.deepEqual(listed(), ['/admin/feedback/the-backward-becoming/note%3Aone'])
})

test('a request whose answer never arrives says so, and does not repeat itself', async () => {
  const fetchDouble = async () => {
    throw new Error('the connection dropped')
  }
  let calls = 0
  useNetwork(async (input, init) => {
    calls += 1
    return fetchDouble()
  })

  rtl.render(<FeedbackInbox {...inboxProps()} />)
  await rtl.act(async () => {
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Mark this note resolved' }))
  })

  assert.equal(calls, 1, 'a dropped request was sent again')
  assert.ok(rtl.screen.getByText(/no way to tell from here whether that happened/))
})

/* ----------------------------------------------------------- saved views */

test('a saved view is saved, applied, replaced and deleted, and carries filters only', async () => {
  let stored: SavedView[] = []
  const net = network((call) => {
    if (call.body.intent === 'save-view') {
      const view = call.body.view as SavedView
      stored = [...stored.filter((entry) => entry.id !== view.id), view]
      return ok({ views: stored })
    }
    stored = stored.filter((entry) => entry.id !== call.body.viewId)
    return ok({ views: stored })
  })
  useNetwork(net.fetchDouble)

  const rows = [
    row({ itemId: 'note:a', detailHref: '/d/a' }),
    row({
      itemId: 'note:b',
      bookSlug: OTHER,
      bookTitle: 'PERSISTENT',
      chapterCoordinate: `${OTHER}/one`,
      detailHref: '/d/b',
    }),
  ]
  rtl.render(<FeedbackInbox {...inboxProps({ rows })} />)

  rtl.fireEvent.click(bookBox('PERSISTENT', 'filter'))
  rtl.fireEvent.change(rtl.screen.getByLabelText('Name for these filters'), {
    target: { value: 'Persistent only' },
  })
  await rtl.act(async () => {
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Save this view' }))
  })

  const sent = net.calls[0].body.view as Record<string, unknown>
  assert.deepEqual(Object.keys(sent).sort(), ['books', 'chapters', 'id', 'kinds', 'name', 'scopes', 'state'])
  assert.equal(sent.id, 'persistent-only')
  assert.deepEqual(sent.books, [OTHER])
  assert.ok(
    !JSON.stringify(sent).includes('What they said.'),
    'a saved view carried the words of a note',
  )
  assert.ok(rtl.screen.getByText('View saved.'))

  // Applying it puts the filters back.
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Clear filters' }))
  assert.deepEqual(listed(), ['/d/a', '/d/b'])
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Persistent only' }))
  assert.deepEqual(listed(), ['/d/b'], 'applying a saved view did not filter the list')

  // Replacing by the same name is one view, not two.
  rtl.fireEvent.change(rtl.screen.getByLabelText('Name for these filters'), {
    target: { value: 'Persistent only' },
  })
  await rtl.act(async () => {
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Save this view' }))
  })
  assert.equal(stored.length, 1, 'replacing a view by name made a second one')

  await rtl.act(async () => {
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Delete Persistent only' }))
  })
  assert.deepEqual(stored, [])
  assert.ok(rtl.screen.getByText('View deleted.'))
})

test('a refused saved view keeps the views that are already there', async () => {
  const net = network(() => refused(400, 'bad_request'))
  useNetwork(net.fetchDouble)

  rtl.render(<FeedbackInbox {...inboxProps({ savedViews: [VIEW] })} />)
  rtl.fireEvent.change(rtl.screen.getByLabelText('Name for these filters'), {
    target: { value: '!!!' },
  })
  await rtl.act(async () => {
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Save this view' }))
  })

  assert.equal(net.calls.length, 1)
  assert.equal((net.calls[0].body.view as { id: string }).id, '', 'a nameless view was given an id')
  assert.ok(rtl.screen.getByText(/refused as malformed/))
  assert.ok(
    rtl.screen.getByRole('button', { name: 'Unresolved passages' }),
    'a refused save lost the existing views',
  )
})

/* --------------------------------------------------------------- export */

test('the export controls send exactly what was chosen, and names are asked for each time', async () => {
  const net = network((call, index) =>
    ok({
      format: call.body.format,
      filename: `author-feedback-2026${index}.json`,
      content: '{"schema":1}',
      naming: call.body.naming,
      itemCount: 3,
      notFound: [],
      stamped: 'recorded',
    }),
  )
  useNetwork(net.fetchDouble)

  rtl.render(<FeedbackInbox {...inboxProps()} />)

  rtl.fireEvent.change(rtl.screen.getByLabelText('Format'), { target: { value: 'markdown' } })
  rtl.fireEvent.click(rtl.screen.getByLabelText(/Use reviewers/))
  rtl.fireEvent.click(bookBox('PERSISTENT', 'export'))
  await rtl.act(async () => {
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Make the file' }))
  })

  assert.equal(net.calls.length, 1)
  assert.deepEqual(net.calls[0].body, {
    intent: 'export',
    format: 'markdown',
    naming: 'display-name',
    bookSlugs: [OTHER],
    csrf: 'csrf-token-for-tests',
  })
  assert.ok(
    document.querySelector('.af-result')?.textContent?.includes('3 item(s)'),
    'the result panel did not report what the server said it contained',
  )

  // The naming choice is not remembered: the next export is pseudonymous again
  // unless it is asked for again.
  await rtl.act(async () => {
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Make the file' }))
  })
  assert.equal(net.calls[1].body.naming, 'pseudonym', 'display names were remembered')
})

test('a browser that will not save the file does not cause a second export', async () => {
  const net = network(() =>
    ok({
      format: 'json',
      filename: 'author-feedback.json',
      content: '{"schema":1}',
      naming: 'pseudonym',
      itemCount: 1,
      notFound: [],
      stamped: 'recorded',
    }),
  )
  useNetwork(net.fetchDouble)

  rtl.render(<FeedbackInbox {...inboxProps()} />)
  await rtl.act(async () => {
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Make the file' }))
  })
  assert.equal(net.calls.length, 1)

  /*
   * A browser that refuses to make an object URL. This is a fixture for a real
   * condition -- a blocked blob: scheme, a hardened extension, a quota refusal
   * -- and it is the only thing replaced here: the component's own handler, its
   * catch and its sentence are shipped code.
   *
   * jsdom supplies no `navigator.clipboard` at all, so the copy below needs no
   * fixture: it is already the browser that will not copy.
   */
  const objectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: () => {
      throw new Error('this browser will not make an object URL')
    },
  })
  try {
    await rtl.act(async () => {
      rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Download' }))
    })
  } finally {
    if (objectUrl) Object.defineProperty(URL, 'createObjectURL', objectUrl)
    else delete (URL as unknown as Record<string, unknown>).createObjectURL
  }

  assert.equal(net.calls.length, 1, 'a failed download generated the packet again')
  assert.ok(rtl.screen.getByText(/would not save the file/))
  assert.ok(rtl.screen.getByText(/The file itself was made and is still below/))

  await rtl.act(async () => {
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Copy' }))
  })
  assert.equal(net.calls.length, 1, 'a failed copy generated the packet again')
  assert.ok(rtl.screen.getByText(/would not copy to the clipboard/))
})

test('a refused export shows an error rather than a partial success', async () => {
  const net = network(() =>
    refused(409, 'incomplete_source', { failures: [{ source: 'notes', bookSlug: BOOK }] }),
  )
  useNetwork(net.fetchDouble)

  rtl.render(<FeedbackInbox {...inboxProps()} />)
  await rtl.act(async () => {
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Make the file' }))
  })

  assert.ok(rtl.screen.getByText(/no file was made/))
  assert.ok(!rtl.screen.queryByRole('button', { name: 'Download' }), 'a refusal offered a download')
  assert.equal(net.calls.length, 1)
})

test('a stamp that did not land is reported without calling the packet short', async () => {
  const net = network(() =>
    ok({
      format: 'json',
      filename: 'author-feedback.json',
      content: '{"schema":1}',
      naming: 'pseudonym',
      itemCount: 2,
      notFound: ['ghost-book'],
      stamped: 'not-recorded',
    }),
  )
  useNetwork(net.fetchDouble)

  rtl.render(<FeedbackInbox {...inboxProps()} />)
  await rtl.act(async () => {
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Make the file' }))
  })

  assert.ok(rtl.screen.getByText(/The file itself is complete\./))
  assert.ok(rtl.screen.getByText(/No manuscript is loaded for ghost-book/))
})

/* ------------------------------------------------------ labels and privacy */

test('every control has a label, and every state is in words as well as in colour', () => {
  rtl.render(<FeedbackInbox {...inboxProps()} />)

  assert.ok(chapterSelect())
  for (const label of ['State', 'Format', 'Name for these filters']) {
    assert.ok(rtl.screen.getByLabelText(label), `"${label}" has no associated control`)
  }
  for (const legend of ['Books', 'Kind', 'Scope', 'Books in the file']) {
    assert.ok(rtl.screen.getByText(legend), `"${legend}" is missing`)
  }
  for (const input of Array.from(document.querySelectorAll('input, select'))) {
    const id = input.getAttribute('id')
    const labelled =
      (id && document.querySelector(`label[for="${id}"]`)) || input.closest('label') !== null
    assert.ok(labelled, `an input has no label: ${input.outerHTML.slice(0, 80)}`)
  }

  // Every button is a real button, so it is reachable and operable by keyboard.
  for (const button of Array.from(document.querySelectorAll('.ad-btn'))) {
    assert.ok(
      button.tagName === 'BUTTON' || button.tagName === 'A',
      'a control is neither a button nor a link',
    )
  }

  // Meaning is never carried by colour alone: the state line is text.
  assert.ok(rtl.screen.getByText(/New · Unresolved/))
  // The live region exists and is polite, so a status is announced.
  const live = document.querySelector('[aria-live="polite"]')
  assert.ok(live, 'there is no live region for a status')
})

test('no rendered surface carries an address, a reviewer id, a token, a path or a position', () => {
  const rows = [
    row({
      itemId: 'note:one',
      captured: 'A permitted quotation.',
      body: 'What they said.',
    }),
  ]

  const { unmount } = rtl.render(
    <FeedbackInbox
      {...inboxProps({
        rows,
        savedViews: [VIEW],
        failures: [{ source: 'notes', bookSlug: BOOK }],
        incomplete: true,
        unreadableBooks: [BOOK],
      })}
    />,
  )
  const inboxHtml = document.body.innerHTML
  unmount()

  rtl.render(<Dashboard {...dashboardProps()} />)
  const dashboardHtml = document.body.innerHTML

  for (const [name, sentinel] of Object.entries(SECRETS)) {
    for (const [surface, html] of [
      ['the inbox', inboxHtml],
      ['the dashboard', dashboardHtml],
    ] as const) {
      assert.ok(!html.includes(sentinel), `${surface} rendered the ${name} sentinel`)
    }
  }

  // And the serialized props a surface is given carry none of them either --
  // the row type has no field for a reviewer id, an address or a path.
  const serialized = JSON.stringify({ rows, view: VIEW, summary: SUMMARY })
  for (const [name, sentinel] of Object.entries(SECRETS)) {
    assert.ok(!serialized.includes(sentinel), `the serialized props carry the ${name} sentinel`)
  }
})

/* ================================================ C1: composite identity ==== */

/**
 * React's own complaint, captured rather than read off a console by eye.
 *
 * A duplicate `key` is reported through `console.error`, so the only mechanical
 * way to assert its absence is to hold the channel for the duration of a render
 * and inspect what was written to it. Everything captured is put back.
 */
async function withCapturedConsoleError<T>(
  body: () => Promise<T> | T,
): Promise<{ value: T; messages: string[] }> {
  const messages: string[] = []
  const real = console.error
  console.error = (...args: unknown[]) => {
    messages.push(args.map((arg) => String(arg)).join(' '))
  }
  try {
    const value = await body()
    return { value, messages }
  } finally {
    console.error = real
  }
}

function duplicateKeyWarnings(messages: string[]): string[] {
  return messages.filter((message) =>
    /same key|duplicate key|two children with the same/i.test(message),
  )
}

/** The same item id, in two different books. The source model permits this. */
const SHARED_ID = 'note:shared-id'

function crossBookRows(): InboxRow[] {
  return [
    row({
      itemId: SHARED_ID,
      bookSlug: BOOK,
      bookTitle: 'The Backward Becoming',
      body: 'What Anna said about the first book.',
      detailHref: `/admin/feedback/${BOOK}/note%3Ashared-id`,
    }),
    row({
      itemId: SHARED_ID,
      bookSlug: OTHER,
      bookTitle: 'PERSISTENT',
      chapterSlug: null,
      chapterCoordinate: null,
      chapterLabel: null,
      chapterNumber: null,
      scope: 'book',
      body: 'What Anna said about the other book.',
      occurredAt: '2026-09-15T12:00:00.000Z',
      createdAt: '2026-09-15T12:00:00.000Z',
      updatedAt: '2026-09-15T12:00:00.000Z',
      detailHref: `/admin/feedback/${OTHER}/note%3Ashared-id`,
    }),
  ]
}

test('two books holding one item id are two rows, and resolving one changes only that one', async () => {
  const net = network((call) => {
    assert.equal(call.body.intent, 'resolve')
    assert.equal(call.body.bookSlug, BOOK, 'the POST named the wrong book')
    assert.equal(call.body.itemId, SHARED_ID)
    assert.equal(call.body.resolved, true)
    return ok({ itemId: SHARED_ID, bookSlug: BOOK, resolved: true })
  })
  useNetwork(net.fetchDouble)

  const captured = await withCapturedConsoleError(async () => {
    rtl.render(<FeedbackInbox {...inboxProps({ rows: crossBookRows() })} />)
    const buttons = rtl.screen.getAllByRole('button', { name: 'Mark this note resolved' })
    assert.equal(buttons.length, 2, 'two same-id rows in two books were not both offered a control')
    await rtl.act(async () => {
      rtl.fireEvent.click(buttons[0])
    })
  })

  assert.equal(net.calls.length, 1, 'resolving one row sent more than one request')

  assert.equal(
    rtl.screen.getAllByRole('button', { name: 'Reopen this note' }).length,
    1,
    'resolving one book changed the other book’s rendered state',
  )
  assert.equal(
    rtl.screen.getAllByRole('button', { name: 'Mark this note resolved' }).length,
    1,
    'the untouched cross-book row lost its own state',
  )

  assert.deepEqual(
    duplicateKeyWarnings(captured.messages),
    [],
    'the inbox gave two cross-book rows the same React key',
  )
})

test('the dashboard preview keys two cross-book rows apart', async () => {
  const preview = crossBookRows()
  const captured = await withCapturedConsoleError(() => {
    rtl.render(
      <Dashboard
        {...dashboardProps({
          feedback: { ...SUMMARY, preview, total: 2, myNotes: { ...SUMMARY.myNotes, preview } },
        })}
      />,
    )
  })

  assert.deepEqual(
    duplicateKeyWarnings(captured.messages),
    [],
    'a dashboard preview gave two cross-book rows the same React key',
  )
  assert.equal(
    document.querySelectorAll('.ad-preview-row').length,
    4,
    'a dashboard preview collapsed two distinct coordinates into one row',
  )
})

/* ============================== C1: confirmed state drives the filter ======= */

test('a confirmed reopen leaves a Resolved-only view', async () => {
  const net = network(() => ok({ itemId: 'note:one', bookSlug: BOOK, resolved: false }))
  useNetwork(net.fetchDouble)

  rtl.render(
    <FeedbackInbox {...inboxProps({ rows: [row({ resolved: true, isNew: false })] })} />,
  )

  rtl.fireEvent.change(rtl.screen.getByLabelText('State', { selector: 'select' }), {
    target: { value: 'resolved' },
  })
  assert.equal(listed().length, 1, 'a resolved row was missing from a Resolved-only view')

  await rtl.act(async () => {
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Reopen this note' }))
  })

  assert.equal(net.calls.length, 1)
  assert.deepEqual(listed(), [], 'a reopened row stayed in a Resolved-only view')
})

test('a confirmed resolve enters a Resolved-only view', async () => {
  const net = network(() => ok({ itemId: 'note:one', bookSlug: BOOK, resolved: true }))
  useNetwork(net.fetchDouble)

  rtl.render(<FeedbackInbox {...inboxProps()} />)

  await rtl.act(async () => {
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Mark this note resolved' }))
  })

  rtl.fireEvent.change(rtl.screen.getByLabelText('State', { selector: 'select' }), {
    target: { value: 'resolved' },
  })

  assert.equal(listed().length, 1, 'a freshly resolved row did not appear in a Resolved-only view')
})
