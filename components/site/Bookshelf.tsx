import Link from "next/link";

import type { ShelfBook } from "@/lib/bookshelf";
import AcceptedHomeShelf from "./AcceptedHomeShelf";
import ShelfCover from "./ShelfCover";
import StatusBadge from "./StatusBadge";

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
 * `variant="showcase"` is the homepage's shelf and nothing else's: Mike's
 * accepted walnut shelf, `AcceptedHomeShelf`, with its own heading. Each title
 * stands on a shelf -- two to a shelf on a wide screen, one on a phone -- above
 * its title, its stage, its line and an "About this book" link to its page. A
 * title without approved shelf art stands there as its ordinary cover or plate.
 * It handles an empty shelf itself, so the heading stays. `/books` passes no
 * variant and keeps the rows.
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
  if (variant === "showcase") {
    return (
      <AcceptedHomeShelf books={books}>
        {books.length === 0 ? (
          <p className="ms-lede ms-shelf-note">There is nothing on the shelf yet.</p>
        ) : note ? (
          <p className="ms-meta ms-shelf-note">
            A title appears here once it exists and is far enough along to be named —
            never before.
          </p>
        ) : null}
      </AcceptedHomeShelf>
    );
  }

  if (books.length === 0) {
    return <p className="ms-lede ms-shelf-note">There is nothing on the shelf yet.</p>;
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
