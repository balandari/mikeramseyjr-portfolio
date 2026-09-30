import Link from "next/link";

import type { ShelfBook } from "@/lib/bookshelf";
import ShelfCover from "./ShelfCover";
import StatusBadge from "./StatusBadge";
import StudyBook from "./StudyBook";

/*
 * The width the showcase gives every cover frame, written the way the stylesheet
 * writes `--showcase-cover` in `.ms-shelf--showcase`: phones up to 9.5rem, and
 * from 52rem up to 16rem.
 */
const SHOWCASE_SIZES = "(min-width: 70rem) 18rem, (min-width: 48rem) 25vw, 32vw";

/**
 * The shelf: one row a title, each row led by a cover of exactly the same size.
 *
 * A list the way the "also by" page at the front of a book is a list -- title,
 * what it is, one line, its stage -- but every row now carries a cover frame,
 * and every frame is the same box. A title with finished artwork shows the
 * artwork; a title without shows a compact typographic plate (see
 * `ShelfCover`). Neither outranks the other, because neither is bigger.
 *
 * That is a change from the earlier shelf, where only a title with art got a
 * small thumbnail and the title *without* art got the page's largest visual in
 * the featured band -- which left the one finished cover on the site looking
 * like the least important thing on it.
 *
 * It renders whatever is in `content/bookshelf/`, in that content's own order,
 * and a further title is one more row. There is no "coming soon" row and no
 * placeholder for an unnamed book.
 *
 * ## The homepage showcase
 *
 * `variant="showcase"` is the homepage's author's-study shelf and nothing
 * else's: each title becomes a book standing on a ledge -- the same frame and
 * the same typographic plate, larger, with depth added around them by
 * `StudyBook` -- followed by its title, its stage and its line, side by side
 * on a wide screen and one under another on a phone. Every frame is still the
 * same box, so the real cover and the stand-in keep equal standing. The whole
 * showcase is still one link to the title's page, as a row is. `/books` passes
 * no variant and keeps the rows.
 */
export default function Bookshelf({
  books,
  note = true,
  variant = "rows",
}: {
  books: ShelfBook[];
  note?: boolean;
  variant?: "rows" | "showcase";
}) {
  if (books.length === 0) {
    return <p className="ms-lede ms-shelf-note">There is nothing on the shelf yet.</p>;
  }

  if (variant === "showcase") {
    return (
      <>
        <ul className="ms-shelf ms-shelf--showcase">
          {books.map((book) => (
            <li key={book.slug}>
              <Link href={`/books/${book.slug}`} className="ms-shelf-item">
                <div className="ms-shelf-plinth">
                  <StudyBook size="shelf" title={book.title}>
                    <ShelfCover book={book} sizes={SHOWCASE_SIZES} />
                  </StudyBook>
                </div>
                <div className="ms-shelf-words">
                  <p className="ms-shelf-kind">{book.kind}</p>
                  <h3 className="ms-shelf-title">
                    {book.title}
                    <span className="ms-arrow" aria-hidden="true">
                      &rarr;
                    </span>
                  </h3>
                  <p className="ms-shelf-stage">
                    <StatusBadge book={book} />
                  </p>
                  <p className="ms-shelf-tagline">{book.tagline}</p>
                  <span className="ms-shelf-more">About this book <span aria-hidden="true">&rarr;</span></span>
                </div>
              </Link>
            </li>
          ))}
        </ul>

        {note ? (
          <p className="ms-meta ms-shelf-note">
            A title appears here once it exists and is far enough along to be named —
            never before.
          </p>
        ) : null}
      </>
    );
  }

  return (
    <>
      <ul className="ms-shelf">
        {books.map((book) => (
          <li key={book.slug}>
            <Link href={`/books/${book.slug}`} className="ms-shelf-item">
              <ShelfCover book={book} />
              <p className="ms-shelf-kind">{book.kind}</p>
              <h3 className="ms-shelf-title">{book.title}</h3>
              <p className="ms-shelf-tagline">{book.tagline}</p>
              <p className="ms-shelf-stage">
                <StatusBadge book={book} />
              </p>
            </Link>
          </li>
        ))}
      </ul>

      {note ? (
        <p className="ms-meta ms-shelf-note">
          A title appears here once it exists and is far enough along to be named —
          never before.
        </p>
      ) : null}
    </>
  );
}
