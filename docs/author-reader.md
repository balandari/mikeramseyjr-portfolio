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
                          Every SDK call passes this token explicitly, so it
                          is the only Blob credential the application uses.

ADMIN_AUTH_SECRET         required for /admin. A long random string, and a
                          DIFFERENT one from REVIEWER_AUTH_SECRET.
ADMIN_ALLOWED_EMAILS      required for /admin. Comma-separated, exact match.
GOOGLE_OAUTH_CLIENT_ID    required for /admin.
GOOGLE_OAUTH_CLIENT_SECRET required for /admin.
ADMIN_OAUTH_REDIRECT_URI  optional. Derived from the request when unset.

EMAIL_DRIVER              optional  "resend", "file", or unset (refuses).
EMAIL_OUTBOX_DIR          required when EMAIL_DRIVER=file. Local only.
RESEND_API_KEY            required when EMAIL_DRIVER=resend. SENSITIVE.
EMAIL_FROM                the sender, e.g. Mike Ramsey Jr <review@...>.
EMAIL_REPLY_TO            where replies go. Resend receiving is disabled, so
                          this must be a mailbox that actually receives.
AUTHOR_ALERT_EMAIL        where a new access request is announced.
SITE_ORIGIN               required for any emailed link. NEVER inferred from
                          the request -- that is what once sent a phone to
                          0.0.0.0 after a perfectly good access code.

RATE_LIMIT_TRUST_STORE    set to "1" once, and only once, this deployment's
                          store has been demonstrated to enforce
                          create-if-absent atomically under concurrency --
                          `npm run probe:blob -- --live` against an isolated
                          store, V1 through V8 green. It says the application
                          may count for itself, and on Vercel Blob it is the
                          only thing that opens /review/api/request and
                          /review/api/signin. Without it, an unproven store is
                          treated as no limiter at all and those two endpoints
                          fail closed.

                          THE APPLICATION LIMITER IS PRIMARY. A Vercel WAF
                          rate-limit rule is a worthwhile coarse backstop in
                          front of it, and needs NO application variable --
                          there is nothing to set, and nothing reads one.
                          An earlier RATE_LIMIT_UPSTREAM took precedence over
                          every check and stopped all application counting
                          when set; two of the rules are keyed on the email
                          address, which no IP-keyed WAF rule can express, so
                          declaring the backstop silently deleted the stronger
                          control. That variable has been removed. Setting it
                          now does nothing at all.
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

### Accounts, requests and email sign-in

Access codes are **unchanged and still supported**: the gate, the cookie, the
token format and the one-year session are exactly as they were, and every code
issued before this existed still works. What was added is a second way in, for
people who have no code and for reviewers on a device that has never had one.

```
  /review/request        a stranger asks: name, address, one short message
  /admin                 Mike approves; the account and the books are created
  (email)                a one-time activation link, sent to that address
  /review/activate       one tap opens the account and signs that device in
  /review/signin         later, on another device: "email me a sign-in link"
  /review/signin/verify  one tap, signed in, same account, same place in the book
```

**A credential is never recoverable and never re-sent.** An activation or
sign-in token exists in plaintext for exactly as long as it takes to put it in
an email. What is stored is `HMAC(secret, purpose|token)` -- **as the pathname**
-- so a dump of the store yields nothing usable. "Send another access email"
therefore always mints a *new* credential and kills the old one; there is no
path that leaves two live at once, and Mike cannot see either.

**The credential travels in the URL fragment**, never in a query parameter:
`…/review/activate#a=<token>`. Everything after the `#` is never transmitted,
so it cannot reach a runtime log, an access log or a `Referer`. The page reads
it in the browser, strips it from the address bar, and posts it in a request
body. The email also prints the same code to paste, for a mail client that
damages links -- and for anybody with JavaScript switched off.

**Nothing is spent until a person presses a button.** Mail scanners and
link-preview bots fetch every URL in a message; they run no JavaScript and
post no forms, so they cannot consume a one-use link before the reader sees
it. That is what the confirmation page is for.

**An address becomes an authentication factor only by being proved.** Mike
typing one never sets `emailVerifiedAt`; only a credential sent there and used
does. Changing an address un-verifies it and kills every link already sent to
the old mailbox -- while the reviewer id, the entitlements and every byte of
reading data stay exactly where they are, because none of it was ever keyed on
an address. It does **not** end a session that already exists; that is what
"New code" and "Revoke" are for, and the dashboard says so.

**Emailed links are individually single-use, and they coexist.** There is no
"only the newest email works", no current-credential pointer, and nothing that
retires one credential when another is issued. Every unexpired, unused link is
single-use and stays valid until it is used, it expires, or Mike acts. So a
double-pressed button sends two working emails rather than possibly none, and a
reviewer who opens the older message is not told to go and find the newer one.
(That is a statement about *links*, not about delivery: nothing here guarantees
an email arrives, and the mail section below says so plainly.)

What ends a link early is the reviewer's **credential epoch**: an integer on the
roster entry, copied into each credential at issue and compared for *equality*
at use. It is incremented inside the same conditional roster mutation that
performs the change it protects -- a revocation, an address change, or Mike's
explicit "Invalidate links" -- so the change and the kill commit together, with
no clock and no skew involved. That last case is also what closes the
address-changed-and-changed-back window: the address label matches again, but
the epoch has moved twice.

**Spending a credential is a fence, not an authorization.** Creating the used
marker makes a credential permanently spent, and only then is the reviewer's
roster state confirmed. Where a revocation, an address change or an invalidation
commits in between, the credential stays spent, **no session is minted**, and
the attempt is recorded as `credential.refused-after-spend` -- the reviewer id,
the purpose and the reason, never an address and never a credential. The visitor
sees the same generic failure everybody else sees. Where a consumption and an
administrative security action are concurrent, the administrative action wins.

**A request's identity is its address.** A reviewer access request lives at one
object whose path is a keyed, non-reversible label of the normalised address, so
submitting is a single create-if-absent: the first caller owns the address and
every other caller reads what is there. There is no separate index to fall out
of step, no claim to acquire, and therefore no partial state a crash can strand
-- an earlier design had a permanent repair claim that, if its owner crashed,
locked one address out for good. The consequence, recorded deliberately: an
address has one request slot, so a removed request's id is reused by the next
request from that address. The audit log is timestamped and ordered, so the
timeline still reads correctly.

**Every public answer is the same answer.** The request form and the sign-in
form reply identically whether the address is new, already waiting, already a
reviewer, unverified or revoked. The two credential pages give one generic
failure for expired, used, forged, revoked, sent-to-a-changed-address and
deliberately-invalidated alike. Both mail-sending routes also fail closed before
reading anything at all when `REVIEWER_AUTH_SECRET` is unset: without it there
is no keyed pathname to write under and no credential that could ever be
issued.

**Approval is resumable, not atomic.** It touches the request, the roster, a
credential, the audit log and a mail service, and there is no transaction
across them. So the request first moves to `approving` and writes down the
reviewer id it will use; every later step is idempotent and records its own
outcome before the next begins. A failure anywhere leaves an approval the
dashboard shows as unfinished, and pressing the button again finishes it --
without a second reviewer, a second set of permissions, or a second live link.

**No shared record is ever written unconditionally.** `PrivateStore` offers
`read`, `readVersioned`, `create`, `writeIfMatch` and `removeIfMatch`, and
nothing else -- no unconditional overwrite and no unconditional removal, so the
lost-update class that produced three review rounds is a compile error rather
than a convention. Credentials and used markers are immutable and created once;
the roster, the request record and the mail-operation record are written
conditionally on the exact revision the change was derived from. Removal of a
request is conditional too, because a request's identity is its address and an
unconditional delete could take a *newer* request from that address with it.
`tests/storage-discipline.test.ts` watches a whole journey and asserts that the
store saw only those five operations, and that no authorization decision reads a
listing.

**The interleavings are enumerated, not imagined.** `tests/helpers/scheduled-store.ts`
is a store that pauses every operation until a schedule releases it, so two
flows can be stopped between a decisive read and a decisive write -- the gap all
three earlier defects lived in and the gap ordinary scheduling never opens. The
suite uses it to walk *every* ordering of each pair of flows, to drive named
schedules for each administrative boundary, and to crash the process after every
durable write in turn.

**The limiter fails closed, and in production it is this application.** The two
endpoints that cause email are throttled or they do not open.

In the application, a window holds `limit` numbered slots and a caller is
admitted if and only if it manages to *create* one. That needs atomic
create-if-absent and nothing else -- no counter to lose to a read-add-write
race, and no listing, so neither immediate list visibility nor a globally
consistent order is a property it depends on. (The previous design did depend
on both, and was wrong even where they hold: two hits in one millisecond were
ordered by a random suffix, so a later hit could take a rank already handed out.
`tests/rate-limit.test.ts` keeps that gone.)

On Vercel Blob, create-if-absent is documented but is not *demonstrated* atomic
until somebody watches the live service do it. Until then `limiterStatus()`
reports `unproven` and the two endpoints refuse rather than opening without a
brake. `npm run probe:blob -- --live` against an isolated store is that
demonstration, and `RATE_LIMIT_TRUST_STORE=1` is how the deployment records that
it passed.

**The settled production model is one primary and one backstop.**

| | |
|---|---|
| application limiter | **primary**, after the live Blob proof, with `RATE_LIMIT_TRUST_STORE=1` |
| Vercel WAF rule | a coarse IP/JA4 backstop in front of it. No application variable, because there is none to set |

Two of the rules are keyed on the **email address** -- three requests a day and
five sign-in links an hour to one mailbox -- and no IP-keyed WAF rule can express
either. So the WAF cannot substitute for this limiter, and the earlier
`RATE_LIMIT_UPSTREAM`, which let it try, has been removed rather than narrowed.
`tests/limiter-composition.test.ts` proves that the configured production mode
still counts per client and per address, and that setting the old variable
changes nothing. See `lib/rate-limit.ts` for the reasoning.

**The two credential-spending endpoints fail open instead.**
`/review/api/credential` and `/review/api/unlock` both throttle when the limiter
is available -- through one shared `allowCredentialAttempt()`, applied before any
roster read, so that a caller at or beyond the limit costs the store one read, no
writes and no roster read -- and admit when it is not. Neither sends mail, both
receive something guessing does not threaten, and refusing a legitimate code
holder because a counter is missing is the worse failure. `/review/api/unlock`,
the site's oldest public write, had no limiter at all until this pass and
performed two roster-backed reads for every invalid submission.

**Shared roster writes are conditional.** The roster is one document that
reviewer creation, activation verification, address changes, entitlements,
revocation and restoration all mutate. Both writable drivers write it back
*conditionally on the revision it was read at* -- an ETag and `ifMatch` on
Vercel Blob, a content digest inside one uninterrupted synchronous section on
the filesystem -- and `mutateRoster()` re-derives and re-applies a change that
loses, or refuses honestly. Creating the first roster is the same operation
with no revision to match. A concurrent change is therefore never silently
discarded. See `lib/reviewer-roster.ts`.

**There is no exactly-once email delivery here, and no guarantee of delivery at
all.** A refused, unconfigured or permanently uncertain operation may deliver
zero messages, which is why this is deliberately not described as at-least-once
either. The plaintext credential lives only in memory for the length of one
send, so a message whose fate is unknown cannot be re-sent -- there is nothing
left to re-send.

What *is* guaranteed is narrower and true:

- **This application makes at most two provider calls for one stable
  operation** -- the first attempt, and one re-offer of an uncertain answer with
  the same message and the same key.
- **Resend processes at most one email for one idempotency key carrying an
  identical payload, within its documented 24-hour idempotency window.** That,
  not the call count, is what makes the re-offer safe.
- **One key means one credential in one message.** The key is the credential's
  own random operation identity and nothing else. An earlier key was built from
  a generation number, and two simultaneous issues minted two different tokens
  under one generation -- two payloads sharing one key, with the operation claim
  suppressing one of them. There are no generations now, and two messages cannot
  collide.
- **Every accepted message carries a link that works.** Nothing invalidates a
  credential except an administrative act, so there is no such thing as an email
  reported as sent whose button does nothing. Earlier emails keep working until
  they expire.

Every message is a durable operation (`lib/mail-operations.ts`) written down
**before** the provider is called and settled afterwards. A retry of an
unfinished approval *resumes* that operation -- same credential, same key,
nothing sent -- and recovers the answer the provider actually gave, or reports
`uncertain` when the process died before it was recorded. "Send a new access
email" mints a new credential and leaves the earlier one working; killing the
earlier one is a separate, deliberate action ("Invalidate links"), because those
are two different intentions and conflating them is what produced the dead-link
support case in the first place.

**Resend's two 409s are told apart.** `concurrent_idempotent_requests` (same key
and payload, first request still running) is uncertain; `invalid_idempotent_request`
(same key, different payload) cannot succeed without changing one of them and is
reported as a refusal. The provider's error body is read only for a `name` field
matched against a fixed allowlist, so no recipient, credential, link, message
body or key can reach a stored record.

### Requests, from the command line

The dashboard is the real place to approve somebody. `/admin` is behind Google
sign-in, though, and a local machine has no Google client registered for its
own address, so the administrative half cannot be driven in a browser locally.
Rather than weaken that gate, the same operations are offered to somebody who
already holds the deployment's secrets:

```bash
npm run reviewer:requests -- list
npm run reviewer:requests -- approve --id <requestId> [--books a,b]
npm run reviewer:requests -- decline --id <requestId>
npm run reviewer:requests -- resend  --id <requestId>
```

It calls exactly what `/admin/api/requests` calls, writes the same audit lines,
and -- like the dashboard -- **cannot print a credential**.

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

---

## Reading records — resume, bookmarks, annotations

Four things a reader can leave behind, deliberately kept apart because they mean
four different things.

| | What it is | How many | Who else sees it |
|---|---|---|---|
| **Resume** | the automatic current position | one per reader per book | nobody |
| **Bookmark** | "come back here", no comment required | as many as you like | nobody |
| **Annotation** | a selected passage, with an optional note | as many as you like | whatever its sharing says |
| **Feedback** | a comment submitted to Mike | append-only history | Mike, always |

**Resume is not a bookmark.** Nobody asks for it, there is exactly one per book,
it is overwritten as you read, and removing it is meaningless. A bookmark is a
deliberate act with a deliberate removal. They are stored separately and neither
is derived from the other.

### Where they live

`lib/reviewer-reading.ts`, in the **same private store as reviewer feedback**,
selected by the **same** `REVIEWER_FEEDBACK_DRIVER` and using the **same**
`BLOB_READ_WRITE_TOKEN`. There is no new service, package, account or secret: a
deployment that can already keep a comment can already keep a bookmark, with
nothing to configure. `REVIEWER_READING_DIR` is an optional override for the
filesystem driver and defaults to a `reading/` directory beside the feedback
rows.

```
reading/v1/<ownerKind>/<ownerId>/<bookSlug>/position.json
reading/v1/<ownerKind>/<ownerId>/<bookSlug>/bookmarks/<createdAt>-<id>.json
reading/v1/<ownerKind>/<ownerId>/<bookSlug>/annotations/<id>.json
reading/v1/share/<token>.json
```

`ownerKind` is `reviewer` or `author`. That is what keeps Mike's own reading in a
separate namespace: an author session cannot construct a reviewer prefix, so
reading a manuscript as the author touches no reviewer record, creates no
reviewer identity, and moves no reviewer's last-opened time.

These records belong to the **person**, not the browser. What remains in
`localStorage` is the appearance settings — theme and text size, which really are
a property of the screen you are reading on — and one short-lived note described
under "The place you have not been told about yet" below, which is never a second
source of truth.

### Ordering a record several devices write to

A reading position is the one record here that a phone and a laptop both
overwrite continuously, over connections that reorder and retry. `lib/reading-order.ts`
holds the whole rule, and it is two sentences long:

- **A device can order its own writes.** Each save carries a random device
  identifier and a counter that only rises. The server keeps the highest counter
  it has accepted from each recent device and refuses anything at or below it —
  which is exactly the delayed request that arrives after a newer one.
- **Two devices cannot order each other's writes.** Their counters are unrelated
  integers, and there is no clock to fall back on: device clocks disagree, and a
  phone running a day fast would pin a reader's place forever. Across devices the
  rule stays **last arrival wins**, and no sequence is ever compared with one from
  another device.

So `A10`, then `B5`, then a delayed `A9` leaves `B5` on record. That works because
every device's high-water mark is carried forward, not only the one attached to
the position currently stored — a mark has to outlive its device losing a race.
The list is bounded (`MAX_TRACKED_DEVICES`), oldest first, and the device on
record is always the last one that can be dropped.

The decision and the write are **one conditional atomic mutation**: the store
reads `position.json` with its revision, decides against what it read, and writes
back only if that revision is still current, retrying the whole decision if it is
not. The marks live in the same object as the position they order, so there is no
interleaving where the two disagree. `put` is never used for a position by any
path, and `tests/reading-position-ordering.test.ts` proves it against both
drivers.

**The device identifier is not identity.** It is random, minted in the browser,
names nobody, and authorizes nothing. Every request carrying one has already been
authenticated by the signed cookie and re-checked against the roster; the
identifier is read afterwards, and only to decide which of two positions is newer.
Records written before any of this exists carry none of these fields, are read and
written exactly as before, and a damaged ordering field is dropped rather than
costing a reader their place.

### The place you have not been told about yet

Next's client Router Cache replays a visited route's rendered result on a back
navigation. So a reviewer who reads a chapter and presses Back can be shown the
library *as it was rendered before they read it*, with **Continue reading** naming
the chapter before last. `force-dynamic` does not change that — it governs how the
server renders, not whether the client re-asks — and turning the cache off for
dynamic routes was tried, and cost the restored scroll position of the page being
returned to.

So the card asks for the one piece of per-request state it needs (`ResumeCard`,
one small uncached request, never `router.refresh()`), and the leaving page writes
what it has just measured into `localStorage` first, because `sendBeacon` means
*queued*, not *stored*, and there is nobody left on that page to hear the outcome.

That local note is preferred over the server's record only while the server has
not confirmed it — confirmation being this device's own sequence, never another
device's — and only for a bounded number of attempts and a bounded time. Past
that, the server's record is shown and the reader is told plainly that their
newer place could not be saved. It is keyed by the reader's storage namespace and
the book, and a different reviewer signing in on the same phone removes it: a
borrowed browser must not be able to say where somebody else stopped reading.

### How a passage is identified

An anchor is (book, chapter, **stable paragraph id**, character offsets) plus the
**captured quotation** and the chapter file's **`sha256`**.

Offsets are measured against the paragraph's *reading text* — its inline
segments joined, which is exactly the run of characters the reader displays and
exactly what a browser selection measures.

**Visual line numbers are never used and could not be.** A line is a consequence
of viewport width, text size, theme and which font happened to load; the same
paragraph is four lines on a phone and two on a laptop and changes when the
device is rotated. An identity that moves when a phone is turned sideways is not
an identity.

The quotation is always copied **out of the verified manuscript on the server**,
at those offsets — never taken from the request. A stored record therefore cannot
quote text the book does not contain.

### When the manuscript changes underneath an anchor

`resolveAnchor` re-reads the paragraph and compares character for character. An
anchor is `ok` only when the paragraph still exists, the offsets still fit, and
the characters at those offsets are still exactly the quotation that was
captured. Anything else is **`needs-relocation`**: the saved quotation is shown,
the item is labelled as needing relocation, its "go to" is disabled, and it is
**never drawn over whatever text now occupies those offsets**.

The fingerprint is recorded so a later tool can tell which version an anchor was
made against. It is deliberately not the test on its own: editing one line of a
chapter must not orphan every note in it, and an unchanged fingerprint is not
accepted as proof when the exact comparison is cheap.

### Sharing

Three states, and only three (`lib/reading-access.ts`):

- **`private`** — only its creator. Not Mike, not anyone.
- **`author`** — its creator and Mike.
- **`link`** — its creator, Mike, and anyone who both holds the private link
  *and* is independently entitled to that book.

**A private link is a locator, not an authorization.** Holding the token is never
sufficient: opening `/review/shared/<token>` still requires a reviewer session
the live roster currently entitles to that book, and `/admin/shared/<token>`
still requires an administrator session. A visitor with no session, a reviewer
who is not entitled, a revoked reviewer and a token nobody ever minted all get
the same page, so a link cannot be used to learn whether a note exists.

`/review/shared/...` is the one path under `/review` besides signing in that the
request boundary lets through unauthenticated, and the reason is narrow: the
administrator cookie is scoped to `/admin` and is not sent to `/review`, so a
redirect straight to the reviewer gate would ask Mike for a reviewer access code
to read a note shared with him. The page answers for itself and offers both
doors.

Only the creator may change or delete an annotation. Mike can read what was
shared with him; he cannot edit it, retract it, or re-share it.

**Not built in this slice**, deliberately: book-club membership, notifications,
moderation, and public discussion. A later discussion layer can reference an
annotation by its stable `id` and re-use `canViewAnnotation` unchanged — a new
state on `AnnotationVisibility` and a branch in that one function, rather than a
redesign of the anchors.

### The workspaces

- **`/review/my-reading`** — every reviewer's own material, grouped by book then
  chapter: resume position, bookmarks, highlights and notes, and every comment
  they have submitted. Each location-based item links back to its exact passage.
  Submitted feedback is shown as durable history and is offered no way to be
  edited or removed.
- **`/admin/read`** — Mike's library (every manuscript actually loaded,
  **PERSISTENT included**), what reviewers shared with him, and his own reading
  in the author namespace.

### Who a loaded manuscript is for

A book's manifest declares its audience:

```json
"audience": "reviewers"     // can be granted to an advance reader
"audience": "author-only"   // Mike, and nobody else
```

**It fails closed.** A manifest that omits the field, misspells it, or sets it
to anything unrecognised yields `author-only`, so a damaged manifest hides a
manuscript rather than exposing one.

PERSISTENT is `author-only`, because Mike has not made his line-by-line pass
over it. That is enforced in three independent places, none of which depends on
another having run:

1. `lib/reviewer-authorization.ts` intersects every reviewer's live entitlements
   with `reviewerReadableBookSlugs()`, so `viewer.books` can never name it — and
   `viewer.books` is what every downstream rule consults.
2. `lib/reading-service.ts`'s `openBook` re-checks the book's own manifest and
   refuses a non-author viewer, whatever the entitlements said.
3. `assignableBookSlugs()` excludes it, so the dashboard shows no checkbox for
   it and the endpoint refuses the grant when one is posted directly.

Every refusal is the same `not-found` a missing book gets, so an author-only
manuscript cannot be told apart from one that does not exist.

**Opening it to reviewers later is one deliberate edit** — `"audience"` to
`"reviewers"` in `content/books/persistent/book.json`. Nothing about loading a
manuscript, adding a reviewer, or granting another book can cause it.

### How reading works

The reader used to explain itself only in a line at the top of a chapter, which
automatic resume scrolls straight past on every visit after the first. The same
words now live in a destination as well: `components/reader/reading-help.ts`
holds them once, and `components/reader/ReadingHelp.tsx` renders them as a
native `<details>` accordion on `/review`, `/review/my-reading` and
`/admin/read`, and inside the reader's own sheet from a button in the sticky
bar. The bar is sticky, so it is reachable at any scroll position, including
after a resume.

### Reserved route segments

`/review/<book>` is a dynamic segment and `api`, `login`, `my-reading` and
`shared` are static segments beside it. Next resolves a static segment first, so
a book slug equal to one of those would be silently unreachable. A test in
`tests/manuscript.test.ts` asserts no loaded book slug collides.
