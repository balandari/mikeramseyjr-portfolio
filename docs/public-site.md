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
| `cover` | `null` until artwork is approved. See below. |

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
| **Book cover** — `components/site/BookPlate.tsx` | A set title page ruled in brass: the title, the author, the stage. Clearly a plate, not a mock jacket. | Add `"cover": { "src": "/covers/<slug>.jpg", "alt": "…" }` to the title's JSON. The plate is replaced everywhere it appears — homepage, shelf, book page — with no other change. |
| **Author photograph** | **Done.** Mike's own photograph is in place (see below). | — |
| **Social / share image** | `openGraph` carries title and description only, so a shared link shows the platform's default card. | One approved 1200×630 image and an `openGraph.images` entry in `app/layout.tsx`. |

Nothing above is required for the site to be complete. Each would make it
better, and each needs Mike's approval before it exists.

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
  Book Antiqua, Charter, Georgia — for everything that is read, headings
  included. It is the same stack the private reader uses, nothing is fetched,
  and a heading is the reading face at a larger size rather than a display face.
  Inter is the functional layer only: navigation, small labels, buttons, form
  fields. Heading sizes are deliberately close to the text under them.
- **Two grounds.** Ink is the default; `.ms-section--paper` is the warm page.
  Every token defaults to its ink value and the paper band overrides it —
  writing it the other way round produces near-black text on near-black ink in
  any block that is not itself a `.ms-section`.
- **The focus ring follows the ground.** `--focus` is brass on ink and dark on
  paper, because brass on paper is 1.8:1.
- **Motion is in two layers.** Above the fold is a CSS animation (`.ms-rise`)
  that needs no JavaScript; below the fold is a single observer
  (`RevealOnScroll`) over `.ms-reveal`. Reveal styles apply only under
  `html.js`, so with scripting off nothing is ever hidden. Both layers are
  cancelled by `prefers-reduced-motion: reduce`.
- **No public prose.** The public site describes the book and never quotes it.
  The longest run of words shared between any public page and the manuscript is
  four, and those are incidental.
