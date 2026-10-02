import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import type { ShelfBook } from "@/lib/bookshelf";
import ShelfCover from "./ShelfCover";
import styles from "./AcceptedHomeShelf.module.css";

/*
 * The slug pattern `lib/bookshelf.ts` already enforces. Checked again here so a
 * link can only ever be `/books/<one of the shelf's own slugs>`.
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * How one approved shelf image sits on the shelf.
 *
 * This is image metadata, not catalog data: the title, stage, line and order
 * all still come from `content/bookshelf/`. Each image is shown whole, at its
 * own pixels -- never cropped, repainted or given a new shadow -- and placed
 * by its measured material, not by its canvas:
 *
 *   - `canvas` is the PNG's own width and height;
 *   - `material` is the opaque book's box in that canvas, `[left, top, right,
 *     bottom]`, right and bottom exclusive;
 *   - `baseY` is the canvas row the book stands on.
 *
 * Every book is drawn at the same material height (`--book-h`), centred on its
 * material and standing on the same line (`--base`), whatever padding or
 * baked shadow its canvas carries.
 */
type ShelfArt = {
  src: string;
  alt: string;
  canvas: readonly [number, number];
  material: readonly [number, number, number, number];
  baseY: number;
};

/*
 * The two approved images, keyed by the real slugs. Measured in the accepted
 * local proof (reusable-reference-shelf-proof-r2, `data/books-two.json`) and
 * copied unchanged. A title missing here has no approved shelf image, and
 * stands on the shelf as its ordinary cover or typographic plate instead.
 */
const SHELF_ART: Readonly<Record<string, ShelfArt>> = {
  "the-backward-becoming": {
    src: "/accepted-shelf-r2/tbb-selected.png",
    alt: "The Backward Becoming by Mike Ramsey Jr, pictured as a black book with its title in gold",
    canvas: [1181, 1332],
    material: [274, 108, 1061, 1261],
    baseY: 1260,
  },
  persistent: {
    src: "/accepted-shelf-r2/persistent-selected.png",
    alt: "PERSISTENT by Mike Ramsey, pictured as a book with a dark illustrated cover",
    canvas: [1122, 1402],
    material: [195, 86, 959, 1302],
    baseY: 1301,
  },
};

/* A cover frame is 2:3, so its "material" is two thirds as wide as it is tall. */
const FRAME_RATIO = 2 / 3;

function placement(art: ShelfArt): CSSProperties {
  const [left, top, right, bottom] = art.material;
  const height = bottom - top;
  return {
    "--image-ratio": art.canvas[0] / height,
    "--material-ratio": (right - left) / height,
    "--material-center": (left + right) / 2 / height,
    "--base-ratio": art.baseY / height,
  } as CSSProperties;
}

/* The decorative wall, wooden top and caption face behind one shelf. */
function Scene({ className }: { className: string }) {
  return (
    <div className={className} aria-hidden="true">
      <div className={styles.wall} />
      <div className={styles.surface} />
      <div className={styles.face} />
    </div>
  );
}

function ShelfItem({ book }: { book: ShelfBook }) {
  const art = SHELF_ART[book.slug];
  const titleId = `shelf-book-${book.slug}`;
  const linkable = SLUG_PATTERN.test(book.slug);

  return (
    <article
      className={styles.item}
      aria-labelledby={titleId}
      style={art ? placement(art) : ({ "--material-ratio": FRAME_RATIO } as CSSProperties)}
    >
      <Scene className={styles.itemScene} />

      <div className={styles.stage}>
        {art ? (
          // The approved PNG itself, byte for byte: no optimiser, no derivative.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className={styles.image}
            src={art.src}
            alt={art.alt}
            width={art.canvas[0]}
            height={art.canvas[1]}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className={styles.fallback}>
            <ShelfCover book={book} sizes="184px" />
          </div>
        )}
      </div>

      <div className={styles.caption}>
        <h3 id={titleId} className={styles.title}>
          {book.title}
        </h3>
        <p className={styles.status}>{book.statusLabel}</p>
        <p className={styles.tagline}>{book.tagline}</p>
        {linkable ? (
          <Link className={styles.about} href={`/books/${book.slug}`} aria-describedby={titleId}>
            About this book
            <span className={styles.arrow} aria-hidden="true">
              &rarr;
            </span>
          </Link>
        ) : null}
      </div>
    </article>
  );
}

/**
 * The homepage bookshelf: Mike's accepted reusable shelf (R2).
 *
 * A heading on the room's wall, then one shelf per row -- two books to a shelf
 * on a wide screen, one on a phone -- each standing on a wooden top above its
 * own quiet caption. It renders whatever `loadShelf()` returns, in that order,
 * so a further title is one more record and never a code change; an odd last
 * title keeps the left place on its shelf.
 *
 * Phone rows need no script. Each shelf of two carries one scene behind it, and
 * each title carries its own, shown only below 40rem where the titles stack:
 * the same three decorative layers either way, `aria-hidden`, so no title, link
 * or word is ever rendered twice.
 *
 * A title with an approved shelf image is that image. A title without one
 * stands on the shelf as `ShelfCover` draws it everywhere else -- its real
 * cover, or the typographic plate -- never as another book's art or a stand-in.
 */
export default function AcceptedHomeShelf({
  books,
  children,
}: {
  books: ShelfBook[];
  children?: ReactNode;
}) {
  const rows: ShelfBook[][] = [];
  for (let start = 0; start < books.length; start += 2) rows.push(books.slice(start, start + 2));

  return (
    <div className={styles.shelf}>
      <header className={styles.heading}>
        <p className={styles.eyebrow}>Bookshelf</p>
        <h2 id="shelf-title" className={styles.headline}>
          <span>Everything with a</span> <span>name on it</span>
        </h2>
      </header>

      <div className={styles.rows}>
        {rows.map((row) => (
          <div key={row[0].slug} className={styles.row}>
            <Scene className={styles.rowScene} />
            <div className={styles.grid}>
              {row.map((book) => (
                <ShelfItem key={book.slug} book={book} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {children ? <div className={styles.after}>{children}</div> : null}
    </div>
  );
}
