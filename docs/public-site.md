# The public author site

`mikeramseyjr.com` is Mike Ramsey Jr's author home. It has one job: introduce
the person, present the books, and give the small number of invited advance
readers a quiet way through to the private reader at `/review`.

It is not a portfolio. The software work is represented at
[tcbyws.com](https://tcbyws.com) and is linked from the footer once.

---

## What is where

| Route | What it is |
|---|---|
| `/` | Homepage — introduction, the featured book, the shelf, a short about |
| `/books` | The whole shelf on one page |
| `/books/<slug>` | One title's public page |
| `/about` | The author page, and the contact path |
| `/review/login` | The reviewer gate. Public-facing in the sense that anyone can reach it, so it wears the public site's type and palette — but it names no title and grants nothing |
| `/review/*` | The **private** advance reader. Different area, different rules — see `docs/author-reader.md` |

Every public route is statically generated at build time. Nothing public reads
a file at request time, and no public page can address the manuscript.

| Concern | Module | Content |
|---|---|---|
| Public bookshelf | `lib/bookshelf.ts` | `content/bookshelf/*.json` |
| Private manuscript | `lib/manuscript.ts` | `content/books/<slug>/` |

**Neither module imports the other.** The public shelf can grow, and a title's
description can change, without any of it touching the prose behind `/review`.

---

## Adding the next book

Write one file: `content/bookshelf/<slug>.json`. The filename must match the
`slug` inside it. No page, component or route is edited.

```json
{
  "slug": "a-second-novel",
  "order": 2,
  "featured": false,
  "title": "A Second Novel",
  "kind": "Novel",
  "tagline": "One sentence, in Mike's voice.",
  "status": "in-progress",
  "statusLabel": "Work in progress",
  "statusNote": "One honest sentence about where this actually is.",
  "description": ["A paragraph.", "Another paragraph."],
  "details": [{ "label": "Form", "value": "Novel" }],
  "reviewerAccess": false,
  "cover": null
}
```

| Field | Notes |
|---|---|
| `order` | Lower comes first on the shelf. Ties break alphabetically. |
| `featured` | The homepage leads with the first title marked `true`. Moving the feature to the next book is moving this one boolean. |
| `status` | `in-progress`, `in-revision`, `complete`, `published`. A **stage**, never a date. `complete` means *the draft is finished* — it does not mean ready to publish, and the `statusLabel`/`statusNote` must say which. |
| `statusLabel` / `statusNote` | The badge and the sentence under it. Both are shown verbatim, so both are Mike's words. |
| `description` | The paragraphs on `/books/<slug>`. The homepage shows the first two. |
| `reviewerAccess` | `true` adds the understated advance-reader route to this title's page and to the featured band. It does **not** grant anybody anything — entitlement lives in `REVIEWER_ROSTER`. |
| `cover` | `null` until artwork is approved; then `{ src, srcSet, width, height, alt }` pointing at scaled copies under `public/covers/`. See below. |

Then:

```bash
npm test          # the shelf tests load the real content
npm run build
```

A malformed file **stops the build** and names itself. That is deliberate: a
title silently disappearing from the homepage because of one wrong comma is a
worse failure than a build that refuses.

### What must never go in

The shelf is checked by `tests/bookshelf.test.ts` for invented claims — no
retailer, no pre-order, no ISBN, no award, no "coming soon", no review quotes.
If a future title genuinely has one of those, that test has to be changed
deliberately, which is the point of it.

There is also no placeholder entry for an unwritten book. The shelf says it
grows; it never lists something that does not exist.

---

## Where an approved asset would improve the design

Mike's photograph is in place. Nothing else is: there is no cover art and no
share image, and the site does not invent either. Where a real asset would
help, the source says so with an `ASSET:` marker.

| Place | Today | With an approved asset |
|---|---|---|
| **Book cover** | **PERSISTENT: done** — its canonical front cover, scaled, on the shelf and on its page. *The Backward Becoming*: none yet; a typographic plate stands in for it, at the same size as a real cover on the shelf and larger in the featured band. | Add `"cover"` to the title's JSON (below). The art appears on the shelf, the book page and the featured band with no other change. |
| **Author photograph** | **Done.** Mike's own photograph is in place (see below). | — |
| **Social / share image** | **Done**, typographically: `app/(site)/opengraph-image.tsx` renders the name, the statement and a rule on paper at build time. | An approved photographic or illustrated card could replace it; the file is the only thing that changes. |

Nothing above is required for the site to be complete. Each would make it
better, and each needs Mike's approval before it exists.

---

## Cover art

A title with approved artwork declares it on its JSON file:

```json
"cover": {
  "src": "/covers/<slug>-640.jpg",
  "srcSet": "/covers/<slug>-320.jpg 320w, /covers/<slug>-640.jpg 640w, /covers/<slug>-1000.jpg 1000w",
  "width": 640,
  "height": 960,
  "alt": "Front cover of <Title> by <Author>: what is actually on it."
}
```

The files are **scaled copies only** — the artwork's proportion is kept, nothing
is cropped, recoloured or retyped, and the source stays where it lives, outside
this repository. `components/site/Cover.tsx` renders them through
`srcset`/`sizes`, so each placement fetches the file it actually needs. The test
suite refuses a `cover` whose files are not under `public/`.

### One frame per title on the shelf

Every shelf row is led by a cover frame of **exactly the same size**
(`components/site/ShelfCover.tsx`): `clamp(6rem, 26vw, 10rem)` wide, 2:3, and
what goes in it is either the real artwork or a compact typographic plate.

This replaced an arrangement in which only a title *with* art got a thumbnail —
capped at 4.5rem on a phone — while the title *without* art got the page's
largest visual in the featured band. The one finished cover on the site was
therefore its smallest element and the stand-in was its biggest, which read as
though the real jacket mattered less than the placeholder.

The artwork is `object-fit: contain` inside the frame, so art that is not 2:3 is
shown whole with space around it rather than trimmed. The **featured band above
the shelf keeps its own larger presentation** — that is a hierarchy between *the
current book* and *the rest of the shelf*, which is a different claim.

**PERSISTENT** uses its canonical front cover from the production folder of the
book's own project (1800×2700, 2:3), cut to 320, 640 and 1000 wide. The
alt text describes the cover as it is, including the subtitle printed on it.

---

## The photograph

Mike supplied `D:\ts\selfie.png` — 1419x1419, 2.2 MB. That file is **not** in
this repository and was not modified. Two optimised copies are:

```
public/portrait/mike-ramsey-jr-480.jpg    33 KB
public/portrait/mike-ramsey-jr-960.jpg   109 KB
```

`components/site/Portrait.tsx` serves both through `srcset`/`sizes`, so the
browser fetches the 33 KB file for the 15rem column on a desktop and the larger
one only where the layout is wide enough or the screen dense enough to need it.

The sources are **square**. The frame is cropped in CSS (`.ms-portrait`), not in
the files: a 3:2 band on a phone, a 4:5 plate beside the text from 52rem up,
with `object-position` above centre because the face sits in the upper half. One
pair of files, two crops, no art direction markup.

It appears twice — the About band on the homepage, and the About page — and
never larger than 15rem beside text. The books stay the larger thing on every
page.

To replace it: regenerate both JPEGs at the same paths and sizes. Nothing in the
components or the stylesheet needs to change.

---

## Design notes

- **Type.** One book-serif stack — Iowan Old Style, Palatino Linotype, Palatino,
  Book Antiqua, Charter, Georgia, Noto Serif — for everything that is read,
  headings included. Noto Serif is there for Android, which ships none of the
  others. It is the same stack the private reader uses, nothing is fetched,
  and a heading is the reading face at a larger size rather than a display face.
  Inter is the functional layer only: navigation, small labels, buttons, form
  fields. Heading sizes are deliberately close to the text under them.
- **Paper by default, ink when asked.** The ground follows
  `prefers-color-scheme`: warm paper unless the reader's system is dark. The
  palette is written as *semantic* tokens (`--bg`, `--fg`, `--fg-dim`,
  `--accent`, `--focus`…) so the dark scheme is one media query and no
  component knows which ground it is on.
- **One inverse band per page.** `.ms-section--inverse` remaps the same tokens
  to the opposite ground, so each page has exactly one moment of contrast and
  the book gets it. The plate inside the featured band reads the frozen
  `--page-*` tokens so it is always the opposite of the band around it.
- **The focus ring follows the ground** through the same tokens.
- **There is no motion.** No scroll reveal, no entrance animation, no grain
  film, no overlay. The only transitions are colour changes on hover, and
  `prefers-reduced-motion: reduce` removes those too. The public pages carry one
  client component, the header, which needs the pathname to mark the current
  page.
- **The plate is used once**, in the featured presentation on the homepage. The
  shelf and the book pages are set in type.
- **Rendered-page smoke tests.** `tests/pages.test.ts` serves the production
  build in-process and asserts on the HTML a visitor receives — the homepage,
  both book pages, the About page, the share image, and the reviewer gate. They
  need `npm run build` first and are *skipped visibly* without one.
- **No public prose.** The public site describes the book and never quotes it.
  The longest run of words shared between any public page and the manuscript is
  four, and those are incidental.
