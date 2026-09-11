import Link from "next/link";

import type { ShelfBook } from "@/lib/bookshelf";
import Cover from "./Cover";
import StatusBadge from "./StatusBadge";

/**
 * The shelf, set in type.
 *
 * A list the way the "also by" page at the front of a book is a list: title,
 * what it is, one line, and its stage. Where a title has real cover art, a
 * small copy of it leads the row; where it does not, the row is type alone --
 * the typographic plate is reserved for the featured presentation and is
 * never used here to stand in for artwork that does not exist.
 *
 * It renders whatever is in `content/bookshelf/`, in that content's own order,
 * and a further title is one more row. There is no "coming soon" row and no
 * placeholder for an unnamed book.
 */
export default function Bookshelf({
  books,
  note = true,
}: {
  books: ShelfBook[];
  note?: boolean;
}) {
  if (books.length === 0) {
    return <p className="ms-lede ms-shelf-note">There is nothing on the shelf yet.</p>;
  }

  return (
    <>
      <ul className="ms-shelf">
        {books.map((book) => (
          <li key={book.slug}>
            <Link
              href={`/books/${book.slug}`}
              className={book.cover ? "ms-shelf-item ms-shelf-item--cover" : "ms-shelf-item"}
            >
              {book.cover ? (
                <Cover
                  book={book}
                  className="ms-cover ms-shelf-cover"
                  sizes="(min-width: 44rem) 5.5rem, 4.5rem"
                />
              ) : null}
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
