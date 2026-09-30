# Homepage reference draft

This branch implements the supplied desktop and mobile author-site reference
as responsive HTML/CSS using the existing Next.js application. It is a draft
for visual review, not a replacement application or a flattened screenshot.

## Presentation

- `app/(site)/home.css` scopes the updated layout to `.ms-home`, its header,
  and its footer. Public book pages, admin routes, and the private reader keep
  their existing presentation and access logic.
- The existing desktop/phone hero assets, portrait, favicon, and PERSISTENT
  cover are reused. The hero shade is lighter to keep the medallion visible.
- The black-and-gold Backward Becoming cover remains selectable HTML type.
  Both books receive a labelled decorative spine and slight perspective.
- `public/study/library-shelf.webp` is an AI-generated empty library scene
  made for this implementation from the supplied visual reference, exported
  to WebP (approximately 149 KB). Covers, titles, and links are real elements.
- Desktop displays two books on one shelf; phones display cover/text pairs.
  Small phones reserve space below the introduction for the complete logo.
- The homepage mobile menu uses native `details`/`summary`, supports Escape,
  and closes after a destination is selected.
- The featured introduction uses the shorter copy from the supplied design.
  The complete book descriptions remain on their existing book pages.

## Review

Run `npm ci`, `npm run build`, and `npm start`, then check `/` at widths
390, 768, and 1440, including the mobile menu, both book links, About, and
Reviewer access. No production configuration or domain changes are required
to preview this branch. Merge only after visual approval.

The original homepage tests were updated for the new decorative spine markup,
responsive cover sizes, and shorter About link label. Their manuscript-leak,
book-link, cover, and route-isolation assertions remain in place.
