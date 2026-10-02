import Link from "next/link";

import type { ShelfBook } from "@/lib/bookshelf";
import CoverSettle from "@/components/motion/CoverSettle";
import BookPlate from "./BookPlate";
import StatusBadge from "./StatusBadge";
import StudyBook from "./StudyBook";
import styles from "./FeaturedBook.module.css";

/*
 * Mike's approved photographic book for The Backward Becoming: the same file
 * the homepage shelf stands it as, served directly, byte for byte. Its canvas
 * is 1181 x 1332 and its measured material (the opaque book) is [274, 108,
 * 1061, 1261]; the soft shadow Mike chose is baked into the transparent
 * padding left of that material. `FeaturedBook.module.css` sizes and places
 * the image by those numbers.
 *
 * Image metadata only, for this one slug. Any other title keeps the plate, and
 * the catalog's `cover: null` for this one is unchanged -- this is not a cover.
 */
const TBB_ART = {
  slug: "the-backward-becoming",
  src: "/accepted-shelf-r2/tbb-selected.png",
  alt: "The Backward Becoming by Mike Ramsey Jr, pictured as a black book with its title in gold",
  width: 1181,
  height: 1332,
} as const;

/**
 * The homepage's presentation of the current book.
 *
 * This band is **tan**, and the introduction above it is **ink** -- a fixed
 * pair, not the relative "one band on the opposite ground" the rest of the
 * site uses. It was that relative band until now, which meant it was ink by
 * day and paper by night; the hierarchy the homepage is meant to state is
 * black introduction, then the book on warm paper, and that has to hold in
 * both schemes rather than trading places at night. `.ms-section--paper` and
 * `.ms-section--ink` are the two fixed grounds, in `app/globals.css`.
 *
 * `/about` and a book page still use `.ms-section--inverse`, which follows the
 * reader. Those bands should.
 *
 * Everything in here reads the semantic tokens the ground remaps, so the
 * eyebrow, the status badge, the detail rules, the button and the quiet
 * reviewer link all resolve against tan without a single override of their
 * own. The one thing that does not follow the band is the book's temporary
 * cover, which is ink wherever it appears -- see `.ms-plate`.
 *
 * It takes whichever title is marked `featured`, so promoting the next book is
 * moving one boolean between two content files.
 *
 * The plate is wrapped in the site's one piece of motion -- a single settle the
 * first time it comes into view. Everything else in this band, including all of
 * the type beside it, is untouched and never moves. See
 * `components/motion/motion.ts` for why that is the only thing here that does.
 *
 * ## The author's-study variant
 *
 * `variant="study"` is the homepage's own presentation and is opted into there
 * only. The words, the status, the details and both actions are exactly the
 * default's; what changes is the arrangement and the object. The same plate is
 * drawn larger, as a book (`StudyBook`), on the same fixed tan ground with a
 * barely visible paper texture of its own (`.ms-study-current`). On a phone the
 * eyebrow and title come first, then the book, then everything else; from
 * 48rem the book stands to the left of the whole column. The one settle is
 * unchanged and still moves only the wrapper around the book.
 *
 * For The Backward Becoming the object is no longer the drawn plate: it is
 * Mike's approved photographic book (`TBB_ART`), larger, with its own baked
 * shadow on the tan ground, and the column is sized to it
 * (`FeaturedBook.module.css`). Another title in this band keeps the plate,
 * the `StudyBook` around it and the column `app/globals.css` gives them.
 */
export default function FeaturedBook({
  book,
  variant = "default",
}: {
  book: ShelfBook;
  variant?: "default" | "study";
}) {
  if (variant === "study") {
    const art = book.slug === TBB_ART.slug ? TBB_ART : null;

    return (
      <section
        className="ms-section ms-section--paper ms-study-current"
        aria-labelledby="featured-title"
      >
        <div className="ms-shell">
          <div
            className={
              art ? `ms-featured ms-featured--study ${styles.artGrid}` : "ms-featured ms-featured--study"
            }
          >
            <div className="ms-featured-head">
              <p className="ms-eyebrow">The current book</p>

              <h2 id="featured-title" className="ms-h2">
                {book.title}
              </h2>
            </div>

            <div className={art ? `ms-featured-book ${styles.artBook}` : "ms-featured-book"}>
              <CoverSettle>
                {art ? (
                  // The approved PNG itself, byte for byte: no optimiser, no derivative.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className={styles.art}
                    src={art.src}
                    alt={art.alt}
                    width={art.width}
                    height={art.height}
                    decoding="async"
                  />
                ) : (
                  <StudyBook size="featured">
                    <BookPlate book={book} sizes="(min-width: 48rem) 20rem, 9.5rem" />
                  </StudyBook>
                )}
              </CoverSettle>
            </div>

            <div className="ms-featured-body">
              <p className="ms-sub">{book.tagline}</p>

              <div className="ms-featured-status">
                <StatusBadge book={book} />
                <p className="ms-meta">{book.statusNote}</p>
              </div>

              <div className="ms-prose ms-featured-prose">
                {book.description.slice(0, 2).map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>

              <dl className="ms-detail-list">
                {book.details.map((detail) => (
                  <div className="ms-detail" key={detail.label}>
                    <dt>{detail.label}</dt>
                    <dd>{detail.value}</dd>
                  </div>
                ))}
              </dl>

              <div className="ms-featured-actions">
                <Link href={`/books/${book.slug}`} className="ms-btn">
                  About this book
                </Link>
                {book.reviewerAccess ? (
                  <Link href="/review/login" className="ms-quiet" rel="nofollow">
                    Enter reviewer code
                    <span className="ms-arrow" aria-hidden="true">
                      &rarr;
                    </span>
                  </Link>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="ms-section ms-section--paper" aria-labelledby="featured-title">
      <div className="ms-shell">
        <div className="ms-featured">
          <CoverSettle>
            <BookPlate book={book} />
          </CoverSettle>

          <div>
            <p className="ms-eyebrow">The current book</p>

            <h2 id="featured-title" className="ms-h2" style={{ marginTop: "0.75rem" }}>
              {book.title}
            </h2>

            <p className="ms-sub">{book.tagline}</p>

            <div style={{ marginTop: "1.5rem" }}>
              <StatusBadge book={book} />
              <p className="ms-meta" style={{ marginTop: "0.75rem", maxWidth: "30rem" }}>
                {book.statusNote}
              </p>
            </div>

            <div className="ms-prose" style={{ marginTop: "1.75rem" }}>
              {book.description.slice(0, 2).map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>

            <dl className="ms-detail-list">
              {book.details.map((detail) => (
                <div className="ms-detail" key={detail.label}>
                  <dt>{detail.label}</dt>
                  <dd>{detail.value}</dd>
                </div>
              ))}
            </dl>

            <div
              style={{
                marginTop: "2rem",
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "0.75rem 1.75rem",
              }}
            >
              <Link href={`/books/${book.slug}`} className="ms-btn">
                About this book
              </Link>
              {/*
                * "Reviewer access" named the destination; this names the act.
                * Beside "About this book" the reader is choosing between two
                * things they might do, and "Enter reviewer code" is the only
                * one of the two that tells somebody holding a code that it is
                * for them. It stays `.ms-quiet` -- the book is still the offer
                * of this band, and this must not compete with it.
                */}
              {book.reviewerAccess ? (
                <Link href="/review/login" className="ms-quiet" rel="nofollow">
                  Enter reviewer code
                  <span className="ms-arrow" aria-hidden="true">
                    &rarr;
                  </span>
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
