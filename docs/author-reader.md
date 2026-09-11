# Advance reading (`/review`)

A private reading edition of unpublished manuscripts for invited reviewers.

It is deliberately small. There is no registration, no sharing, no payment, no
analytics and no tracking of what anyone reads. A reviewer signs in once per
device with a code that belongs only to them, reads the titles that have been
shared with them, keeps their place, bookmarks passages, and leaves notes on
specific paragraphs.

Nothing here touches the rest of `mikeramseyjr.com`. The portfolio's own routes
(`/`, `/app`, `/app/learning`) are untouched, and the middleware that guards this
area matches `/review` and nothing else.

---

## The three concerns, kept apart

The feature is three modules that do not import each other. Any one of them can
be changed without disturbing the others.

| Concern | Module | Where the data lives |
|---|---|---|
| Manuscript content | `lib/manuscript.ts` | `content/books/` in the repository |
| Reviewer access | `lib/reviewer-access.ts` | `REVIEWER_ROSTER` environment variable |
| Reviewer feedback | `lib/reviewer-feedback.ts` | whatever `REVIEWER_FEEDBACK_DRIVER` selects |

Adding a book, granting a reviewer, and choosing a feedback store are therefore
three independent operations.

---

## Environment

```
REVIEWER_AUTH_SECRET      required  A long random string. Signs cookies and
                                    fingerprints access codes.
REVIEWER_ROSTER           required  JSON array of reviewer entries (below).
REVIEWER_FEEDBACK_DRIVER  optional  "fs", or unset.
REVIEWER_FEEDBACK_DIR     required when the driver is "fs".
```

With `REVIEWER_AUTH_SECRET` or `REVIEWER_ROSTER` missing or malformed, the whole
area is closed: no code is accepted and no existing cookie is honoured. That is
deliberate — a misconfigured deployment must not become an open one.

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

**Changing `REVIEWER_AUTH_SECRET` signs everyone out and invalidates every
access code at once.** The fingerprints in the roster are derived from it, so
they must be regenerated too. Treat it as permanent unless you intend that.

### A note on when changes take effect

The request boundary (`middleware.ts`) runs on the Edge runtime, where Next
inlines environment variables at build time. Pages and route handlers run on the
Node runtime and read them per request. **Roster changes therefore need a
redeploy to take effect everywhere.** Until one happens, the boundary may still
be working from the previous roster — but every page and every API route
re-checks against the current one, and those are the enforcement points, so a
revoked reviewer is refused regardless.

---

## Reviewers

### Adding one

```bash
REVIEWER_AUTH_SECRET=<the deployment's secret> \
  npm run reviewer:code -- --id anna --name "Anna" --books the-backward-becoming
```

This prints two things:

1. **The access code.** Shown once. Send it to the reviewer directly. It is not
   written to any file and cannot be recovered afterwards — not from the roster,
   not from a cookie, not from this repository.
2. **The roster entry.** Append it to the `REVIEWER_ROSTER` array and redeploy.

An entry looks like this. It contains a keyed fingerprint, never the code:

```json
{"id":"anna","name":"Anna","books":["the-backward-becoming"],"codeHash":"<opaque>"}
```

`id` is a stable, non-secret identifier; it appears on that reviewer's feedback
rows, so do not reuse one for a different person. `books` lists the slugs they
may open — a title that is not listed is invisible to them and answers 404.

### Revoking one

Remove their entry from `REVIEWER_ROSTER` and redeploy. Their cookie stops
working on the next request and their code stops working immediately. Nobody
else is affected, and their existing feedback is untouched.

### Re-issuing a lost code

Run the generator again for the same `id` and replace that one entry. Their old
code and old cookie both die; every other reviewer is unaffected.

### What is never stored

Access codes. Not in the repository, not in the roster, not in a log, not in a
cookie, not in the browser. The roster holds `HMAC(derived key, code)`; because
the key is secret, possession of the roster reveals nothing about the codes.

---

## Content

A book is a directory. A chapter is a file plus one manifest entry.

```
content/books/<book-slug>/
  book.json
  chapters/
    chapter-one.md
    chapter-two.md
```

`book.json`:

```json
{
  "slug": "the-backward-becoming",
  "title": "The Backward Becoming",
  "author": "Mike Ramsey Jr",
  "subtitle": "Advance reading edition",
  "chapters": [
    {
      "slug": "chapter-one",
      "number": 1,
      "title": "Chapter One — Bangladesh",
      "label": "Chapter One",
      "subtitle": "Bangladesh",
      "file": "chapters/chapter-one.md",
      "bytes": 34719,
      "sha256": "6913…",
      "status": "available"
    }
  ]
}
```

### Chapter file format

- The first line is `# ` followed by exactly the manifest's `title`. A mismatch
  is refused at load, so a file cannot be silently swapped for another.
- Paragraphs are separated by blank lines. A hard-wrapped paragraph is joined
  into one, so re-wrapping the source cannot renumber anything.
- A line of three or more hyphens on its own is a scene break.
- `*text*` is italic. No other markup is interpreted.

### Adding a chapter

1. Write the Markdown file into `chapters/`.
2. Get its pins:
   ```bash
   node -e "const f=require('fs'),c=require('crypto');const b=f.readFileSync(process.argv[1]);console.log('bytes',b.length);console.log('sha256',c.createHash('sha256').update(b).digest('hex'))" content/books/<book>/chapters/<file>.md
   ```
3. Add the manifest entry with those values and `"status": "draft"`.
4. `npm run verify:manuscript`
5. Release it by changing `"status"` to `"available"`.

A `draft` chapter is staged but invisible: it is absent from the chapter list,
its URL answers 404 even for an entitled reviewer, and feedback cannot be
attached to it. Anything not explicitly `"available"` is treated as a draft.

### Adding a book

Create the directory and `book.json` as above, then add the book's slug to the
`books` array of every reviewer who should see it. No code changes.

### Why the hashes

Every chapter's byte count and SHA-256 are re-checked on load, by
`npm run verify:manuscript`, and by the test suite. A chapter that has drifted
by a single byte is refused rather than displayed. That is what makes "the prose
is exactly as the author wrote it" a fact rather than an assurance.

`.gitattributes` excludes chapter files from end-of-line conversion. Without it,
`core.autocrlf` would rewrite every file on checkout and break every hash.

---

## Feedback storage

`lib/reviewer-feedback.ts` defines the whole storage boundary — two methods:

```ts
type ReviewerFeedbackStore = {
  readonly driver: string
  readonly durable: boolean
  add(draft: FeedbackDraft): Promise<FeedbackEntry>
  listForReviewer(reviewerId: string, bookSlug: string): Promise<FeedbackEntry[]>
}
```

A stored row:

```ts
{
  schema: 1,
  id: string,              // uuid
  createdAt: string,       // ISO 8601, UTC
  reviewerId: string,      // from the signed cookie, never the request body
  bookSlug: string,
  chapterSlug: string,
  chapterNumber: number,
  scope: 'paragraph' | 'chapter',
  paragraphId: string | null,
  paragraphOrdinal: number | null,
  quote: string | null,    // copied from the verified manuscript, server-side
  comment: string          // <= 4000 characters
}
```

Attribution is established entirely on the server: the reviewer comes from the
cookie, the chapter from the verified manuscript, and the quoted passage is
looked up by paragraph identifier rather than accepted from the browser.

### Drivers

| `REVIEWER_FEEDBACK_DRIVER` | Behaviour |
|---|---|
| `fs` | Appends newline-delimited JSON to `REVIEWER_FEEDBACK_DIR/<book>.ndjson`. Durable wherever the filesystem is. **Not durable on a serverless host.** |
| anything else, or unset | Every write is refused with 503 and the reviewer is told plainly that the comment was not saved. |

There is no driver that appears to work and does not. A comment is never
accepted and dropped, never reported as saved unless a store returned a stored
row, and never written into the browser as a substitute for server storage.

### Adding a durable driver

Write a class implementing `ReviewerFeedbackStore`, and add one branch to
`createFeedbackStore()`. No page, component or route handler changes.

### Reading the feedback

With the `fs` driver, each book is one NDJSON file — one JSON object per line,
append-only. To read it:

```bash
node -e "require('fs').readFileSync(process.argv[1],'utf8').split('\n').filter(Boolean).map(JSON.parse).forEach(r=>console.log(r.createdAt,r.reviewerId,r.chapterSlug,r.paragraphId||'(chapter)',JSON.stringify(r.comment)))" <dir>/the-backward-becoming.ndjson
```

---

## How access works

1. The reviewer submits their code as a form POST, so it never appears in a URL,
   a referrer or a server access log.
2. The server fingerprints it and compares against every roster entry in constant
   time. Exactly one match identifies the reviewer; zero or two refuse.
3. A signed token naming that reviewer is set as an HttpOnly, `SameSite=Lax`
   cookie scoped to `/review`, with a one-year lifetime. Script cannot read it.
4. Every subsequent request re-verifies: shape, version, signature, expiry, and
   that the reviewer is *still* on the roster with the *same* code fingerprint.
   The token is a claim about who someone is, never a grant of what they may see.
5. Entitlement is checked separately, per book, on every page and every API call.
   A reviewer who is not entitled gets the same 404 as a book that does not
   exist, so the reader cannot be used to enumerate unpublished work.

Enforcement happens twice and independently: at the request boundary
(`middleware.ts`) and again in each page and route handler. The boundary is
defence in depth; the pages are the enforcement.

### What the browser keeps

Only this device's own conveniences, under a per-reviewer opaque namespace
derived on the server:

```
rv.<namespace>.prefs          theme and text size
rv.<namespace>.pos            the most recent place in the library
rv.<namespace>.rp.<book>      the place reached in each chapter
rv.<namespace>.bm.<book>      one bookmarked paragraph per chapter
```

No access code, no session token, no reviewer name or id, and no manuscript
text. A bookmark is an identifier, never a passage. Two reviewers sharing a
browser profile cannot read or resume each other's state, and neither can derive
the other's namespace.

---

## Verifying

```bash
npm run verify:manuscript   # chapter hashes, headings, no public exposure
npm test                    # access, manuscript and feedback suites
npm run typecheck
npm run build
```
