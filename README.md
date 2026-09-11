# mikeramseyjr.com

The author home of **Mike Ramsey Jr**.

> Ordinary lives, with the small parts left in.

**[View the live site →](https://mikeramseyjr.com)**

---

## What's Here

A public author site — an introduction, a growing bookshelf, and a page for each
title — and, behind an access code, a private advance-reading area where invited
readers can read unpublished chapters and leave feedback.

### The current book

- **The Backward Becoming** — a novel, in progress. Not yet published. Early
  chapters are with a small private circle of advance readers.

### Elsewhere

Software and other projects live at **[tcbyws.com](https://tcbyws.com)**.

## Tech Stack

Next.js 14 (App Router) · Tailwind CSS · TypeScript · GSAP (lazy-loaded, for a
deliberately small motion layer) · Vercel Blob (private, production only —
reviewer feedback and the reviewer roster) · Google OAuth for `/admin` ·
Deployed on Vercel

## Development

```bash
npm ci
npm run dev              # localhost:3000
npm test                 # unit tests
npm run typecheck        # tsc --noEmit, strict
npm run verify:manuscript
npm run build            # production build
```

## Documentation

- [`docs/public-site.md`](docs/public-site.md) — the public site: adding a book
  to the shelf, and where approved artwork would go.
- [`docs/author-reader.md`](docs/author-reader.md) — the private `/review` area
  and the `/admin` dashboard: issuing and revoking reviewer codes, releasing
  chapters, reading feedback.
- [`docs/motion.md`](docs/motion.md) — what moves on this site (very little),
  what will never move, and the seam reserved for future passage artwork.

---

© 2026 Mike Ramsey Jr. All rights reserved.
