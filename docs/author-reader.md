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
| Reviewer access | `lib/reviewer-access.ts` | the token format and the code comparison |
| The roster | `lib/reviewer-roster.ts` | whatever `REVIEWER_ROSTER_DRIVER` selects |
| Authorisation | `lib/reviewer-authorization.ts` | joins the two, per request |
| Administration | `lib/admin-auth.ts`, `lib/reviewer-admin.ts` | Google OAuth + the roster |
| Reviewer feedback | `lib/reviewer-feedback.ts` | whatever `REVIEWER_FEEDBACK_DRIVER` selects |

Adding a book, granting a reviewer, and choosing a feedback store are therefore
independent operations.

**The roster is runtime state, not deployment configuration.** It used to be a
JSON array in `REVIEWER_ROSTER`, which meant that adding a reviewer, changing
what one may read, or revoking one all required a redeploy. It now lives in the
same private Vercel Blob store the feedback already uses — no new service, no new
account — and is managed from a dashboard at `/admin`. The environment roster is
still supported, read-only, so an existing deployment keeps its reviewers.

---

## Environment

```
REVIEWER_AUTH_SECRET      required  A long random string. Signs cookies and
                                    fingerprints access codes.

REVIEWER_ROSTER_DRIVER    optional  "vercel-blob", "fs", "env", or unset.
REVIEWER_ROSTER_DIR       required when the roster driver is "fs".
REVIEWER_ROSTER           the old read-only roster. Used when the driver is
                          "env", or when no driver is set but this is present.

REVIEWER_FEEDBACK_DRIVER  optional  "vercel-blob", "fs", or unset.
REVIEWER_FEEDBACK_DIR     required when the driver is "fs".
BLOB_READ_WRITE_TOKEN     required when either driver is "vercel-blob".
BLOB_STORE_ID             set by the Blob store connection. Not a secret.

ADMIN_AUTH_SECRET         required for /admin. A long random string, and a
                          DIFFERENT one from REVIEWER_AUTH_SECRET.
ADMIN_ALLOWED_EMAILS      required for /admin. Comma-separated, exact match.
GOOGLE_OAUTH_CLIENT_ID    required for /admin.
GOOGLE_OAUTH_CLIENT_SECRET required for /admin.
ADMIN_OAUTH_REDIRECT_URI  optional. Derived from the request when unset.
```

The roster driver and the feedback driver are chosen independently but normally
match: in production both are `vercel-blob` and share one `BLOB_READ_WRITE_TOKEN`
against one private store. Locally, both are usually `fs`.

With no roster driver set and no `REVIEWER_ROSTER`, the roster is empty and the
reader admits nobody. That is the correct default for an unconfigured
deployment.

`BLOB_READ_WRITE_TOKEN` is created by connecting the Blob store to the project.
It is **production-only and marked Sensitive**, so Vercel will not hand its
value back to `vercel env pull` and a preview or development build has no
credential for the production store at all. That is the intended arrangement:
reviewer feedback is real people's candid opinion of an unpublished manuscript,
and a preview deployment of a branch is not a place it should be reachable from.

With `REVIEWER_AUTH_SECRET` missing, or the roster unreachable or malformed, the
whole area is closed: no code is accepted and no existing cookie is honoured.
That is deliberate — a misconfigured deployment must not become an open one.

A roster that cannot be *read* is never reported as a roster that is *empty*.
An empty roster admits nobody, which sounds like the safe failure, but the
dashboard would then show no reviewers and the obvious next action would write
that over the real roster. So a storage failure is an error everywhere: the
reader refuses to answer, and the dashboard says plainly that it could not read.

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

**Changing `REVIEWER_AUTH_SECRET` signs everyone out and invalidates every
access code at once.** The fingerprints in the roster are derived from it, so
they must be regenerated too. Treat it as permanent unless you intend that.

### A note on when changes take effect

**Immediately.** A revocation, an entitlement change or a new code is in force on
the affected reviewer's very next request. There is nothing to redeploy and no
cookie to wait out.

The mechanism is a deliberate split:

- The request boundary (`middleware.ts`) runs on the Edge runtime and checks the
  cookie's **integrity** only — shape, version, signature, expiry. It does not
  read the roster, because reading it needs a storage driver and a credential
  and this runs on every request.
- Every page and every route handler under `/review` runs on the Node runtime
  and calls `authorizeReviewer()`, which reads the **live roster** and decides.
  A revoked reviewer, a reviewer whose code was replaced, and a reviewer who was
  never there all come back the same way: not authorised.

The enforcement point is therefore the same place it always was — the pages and
the handlers, which have always re-checked for themselves. The boundary is
defence in depth and nothing depends on it having run.

---

## Administration — `/admin`

The dashboard is where reviewers are managed. It is mobile-first, because the
decision it exists for ("revoke that person, now") is one Mike is most likely to
make away from a desk.

### How it is protected

Two independent facts must both hold:

1. **Google says who you are.** Sign-in is Google OAuth, `openid email` and
   nothing more. There is no password field and never will be.
2. **The allowlist says you are Mike.** The verified address must match
   `ADMIN_ALLOWED_EMAILS` exactly, after trimming and lower-casing.

A successful Google sign-in on any other account gets as far as *"that account
signed in successfully, but it is not an administrator of this site"* and
receives no cookie of any kind. The address must also be one Google itself
reports as **verified** — an unverified address is trivially claimable, and
accepting one would let anybody assert they are Mike.

The allowlist is re-checked on **every** request, not just at sign-in, so
removing an address ends its session immediately.

This is completely separate from reviewer access: a different secret
(`ADMIN_AUTH_SECRET`), a different cookie (`mrj_admin`, scoped to `/admin`), a
different token format, and a different code path. A reviewer's access code is
meaningless at `/admin`, and an administrator session opens no manuscript.
Sessions last 12 hours, not the reviewer's year.

Every read and every mutation is enforced server-side in the route handler, on
top of the boundary check, and every mutation additionally requires a CSRF token
derived from the session.

### Setting it up

This repository creates no Google project and no credentials. To enable the
dashboard, Mike:

1. Creates an OAuth 2.0 Web application client in his own Google Cloud project.
2. Registers the redirect URI — `https://mikeramseyjr.com/admin/api/auth/callback`
   in production, `http://localhost:3000/admin/api/auth/callback` locally.
3. Sets `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
   `ADMIN_ALLOWED_EMAILS` and a fresh `ADMIN_AUTH_SECRET`.

Until all four are set, `/admin` says it is not configured and offers no sign-in
button. Nothing else on the site is affected.

### What it can do

| Action | Effect |
|---|---|
| Add a reviewer | Issues a code, shown **once**, behind a copy confirmation |
| New code | Replaces the code; **ends every session that reviewer has open** |
| Can read | Changes entitlements; live on their next request |
| Rename | Changes the name they are greeted by |
| Revoke | Closes everything for them, immediately |
| Restore | Undoes a revocation; **their previous code works again** |

Revoking marks the entry `revoked` rather than deleting it, so their feedback
stays attributed and their identifier is never silently reused by somebody else.

There is no email delivery. Codes are sent by Mike, by hand, deliberately.

### Reviewers, from the command line

The generator still exists, for a deployment running the read-only environment
roster or for issuing a code without opening a browser:

```bash
REVIEWER_AUTH_SECRET=<the deployment's secret> \
  npm run reviewer:code -- --id anna --name "Anna" --books the-backward-becoming
```

It prints the code once and the roster entry to paste into `REVIEWER_ROSTER`. An
entry holds a keyed fingerprint, never the code:

```json
{"id":"anna","name":"Anna","books":["the-backward-becoming"],"codeHash":"<opaque>"}
```

`id` is a stable, non-secret identifier; it appears on that reviewer's feedback
rows, so do not reuse one for a different person. `books` lists the slugs they
may open — a title that is not listed is invisible to them and answers 404.

### What is never stored

Access codes. Not in the repository, not in the roster, not in the audit log,
not in a log line, not in a cookie, not in the browser. The roster holds
`HMAC(derived key, code)`; because the key is secret, possession of the roster
reveals nothing about the codes. A code exists in plaintext for exactly one HTTP
response — the one that issued it — and cannot be recovered afterwards from
anything this system keeps. A lost code is replaced, never recovered.

### The audit history

Every mutation appends one immutable line: what changed, when, and which
administrator address did it. Codes never appear in it. On the Blob driver each
line is its own object written with `allowOverwrite: false`, so history is
appended to and never edited.

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
| `vercel-blob` | **Production.** One immutable, versioned, private JSON object per submission in a Vercel Blob store. Durable on a serverless host. |
| `fs` | Appends newline-delimited JSON to `REVIEWER_FEEDBACK_DIR/<book>.ndjson`. Durable wherever the filesystem is. **Not durable on a serverless host.** Kept as the local and test driver. |
| anything else, or unset | Every write is refused with 503 and the reviewer is told plainly that the comment was not saved. |

The name must match exactly (trimmed, case-insensitive). `blob`, `vercel_blob`
and similar near-misses select nothing and therefore fail closed — a credential
being present in the environment is never on its own a decision to use it.

There is no driver that appears to work and does not. A comment is never
accepted and dropped, never reported as saved unless a store returned a stored
row, and never written into the browser as a substitute for server storage.

### Adding a durable driver

Write a class implementing `ReviewerFeedbackStore`, and add one branch to
`createFeedbackStore()`. No page, component or route handler changes.

### The Vercel Blob driver

`lib/reviewer-feedback-blob.ts`. One submission, one object:

```
feedback/v1/<reviewerId>/<bookSlug>/<createdAt>-<id>.json
```

- **Separate.** Every comment is its own object. Nothing is appended to,
  merged into or rewritten over an existing object.
- **Immutable.** Written with `allowOverwrite: false` and
  `addRandomSuffix: false`, so a second write to the same pathname is refused
  by the store rather than replacing what is there.
- **Versioned.** The schema version is in the row (`schema: 1`) *and* in the
  pathname (`feedback/v1/...`), so a later schema lives alongside this one
  instead of reinterpreting it.
- **Private.** The store is a private Blob store and every object is written
  with `access: 'private'`. An object URL is not a capability; reading needs the
  store credential, which exists only on the server.
- **Prefix-scoped.** Listing only ever happens beneath
  `feedback/v1/<reviewerId>/<bookSlug>/`, built from the signed cookie and the
  verified manuscript. One reviewer's listing cannot reach another's, because
  the prefix that would name it is never constructed. Rows are re-checked
  against the requesting reviewer and book on read as well, so a misfiled
  object is skipped rather than disclosed.
- **Nothing leaks.** The driver returns `FeedbackEntry` values only — never a
  blob URL, pathname, token or another reviewer's row.

Two kinds of failure, and they are not treated alike:

- **The object is wrong, or is not there.** A malformed, truncated, wrong-schema
  or foreign object is skipped, and the rest of the reviewer's comments still
  read — the same stance the filesystem driver takes toward a corrupt line. A
  listed pathname the store answers for with "no such object" is skipped too:
  the store answered, and there is simply nothing to render.
- **The store, the network or the credential failed.** That propagates. The
  listing operation rejects and the reader sees an error. It is never swallowed
  per-object, because an outage that begins *after* a successful listing would
  otherwise fail every single read, skip every single failure, and present a
  reviewer with a blank page meaning "you have written nothing". A lie that
  looks like an answer is worse than an error, and a reviewer's history must
  never be able to appear empty because storage was unreachable.

A storage outage is also *not* a `FeedbackStorageUnavailableError` — that error
means misconfigured, and an outage must not borrow that explanation.

### Verifying it in production

The production credential is deliberately unreachable from a developer machine,
so a production smoke test is performed **through the deployed application and
the Vercel Blob dashboard** — not by obtaining the token.

1. Deploy. The Blob variables and `REVIEWER_FEEDBACK_DRIVER=vercel-blob` are
   production-only and take effect on the next deployment, not before.
2. On the deployed site, sign in to `/review` as a reviewer and submit one
   comment. A `503` "not configured" instead means the driver did not select —
   check `REVIEWER_FEEDBACK_DRIVER` on that deployment.
3. Reload the chapter. The comment coming back proves the write and the
   prefix-scoped read both worked against the real store.
4. Open the `reviewer-feedback` store in the Vercel dashboard and confirm one
   new object beneath `feedback/v1/<reviewerId>/<bookSlug>/`, and that the store
   reports **private** access.

That is the whole check. It exposes nothing, weakens nothing, and needs no
credential on any machine other than the deployment itself.

### Exporting the feedback, for a future migration

**Where this runs.** Only from an environment that has been explicitly
authorised for it and that *already holds* the production Blob credential. The
production `BLOB_READ_WRITE_TOKEN` is stored Sensitive on purpose, so it is not
retrievable onto a developer machine — `vercel env pull` returns it empty by
design. That is not an obstacle to route around: it is the separation that keeps
real reviewers' candid notes on an unpublished manuscript out of every local
checkout. Do not un-mark the variable, do not copy the token anywhere, and do
not enable a development credential against the production store in order to run
an export.

```bash
# From an authorised environment that already has the production credential:
npm run export:feedback -- ./feedback-export
```

Walks the whole `feedback/` tree and writes every object to a local file at the
same relative path, **byte for byte**. Objects are not re-serialised,
re-indented or re-ordered — an export whose purpose is to be the record of what
a reviewer said has to be the record, not a rendering of it. Nothing in the
store is modified or deleted. Whatever the next store is, its importer reads
these files.

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
