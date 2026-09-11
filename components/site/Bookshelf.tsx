import Link from "next/link";

import type { ShelfBook } from "@/lib/bookshelf";
import StatusBadge from "./StatusBadge";

/**
 * The shelf, set in type.
 *
 * A list the way the "also by" page at the front of a book is a list: title,
 * what it is, one line, and its stage. No plates and no cards -- the plate is
 * reserved for the one featured presentation on the homepage.
 *
 * It renders whatever is in `content/bookshelf/`, in that content's own order,
 * and a further title is one more row. There is no "coming soon" row and no
 * placeholder for an unnamed book; a shelf that lists something which does not
 * exist is lying about the work.
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
            <Link href={`/books/${book.slug}`} className="ms-shelf-item">
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
