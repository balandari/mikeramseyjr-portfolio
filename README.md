# Mike Ramsey Jr — Portfolio

Personal portfolio site for Mike Ramsey Jr, AI developer and creator of [TrovoPilot](https://trovopilot.com) and [PulseBoard](https://thepulseboard.io).

## Tech Stack

- **Framework:** Next.js 14 (App Router)
- **Styling:** Tailwind CSS
- **Typography:** Inter via next/font
- **Language:** TypeScript

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view it in the browser.

## Build

```bash
npm run build
npm start
```

## Deploy

This project is configured for Vercel deployment. Push to a connected GitHub repo or run:

```bash
npx vercel
```

## Structure

```
app/
  layout.tsx    — Root layout with metadata and font config
  page.tsx      — Main page with scroll animation observer
  globals.css   — Global styles, animations, and Tailwind directives
components/
  Hero.tsx      — Hero section with name, tagline, and CTAs
  Projects.tsx  — Project showcase cards with browser mockups
  About.tsx     — About section with origin story
  Contact.tsx   — Contact links and footer
```

## License

All rights reserved. &copy; 2026 Mike Ramsey Jr.
