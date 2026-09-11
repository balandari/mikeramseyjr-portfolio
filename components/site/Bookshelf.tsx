import Link from "next/link";

import type { ShelfBook } from "@/lib/bookshelf";
import BookPlate from "./BookPlate";
import StatusBadge from "./StatusBadge";

/**
 * The shelf.
 *
 * It renders whatever is in `content/bookshelf/`, in that content's own order,
 * with no count baked into the markup or the grid: one title lays out as one
 * title, and the second appears the moment its file exists. There is no
 * "coming soon" card and no placeholder for an unnamed book, because a shelf
 * that lists something which does not exist is lying about the work.
 *
 * The closing note is the honest version of that promise: it says the shelf
 * grows, without naming anything that is not written.
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
              <BookPlate book={book} small />
              <div className="ms-shelf-body">
                <h3 className="ms-shelf-title">{book.title}</h3>
                <p className="ms-shelf-tagline">{book.tagline}</p>
                <div className="ms-shelf-status">
                  <StatusBadge book={book} />
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>

      {note ? (
        <p className="ms-meta ms-shelf-note">
          The shelf grows as the work does. A title appears here once it exists and
          is far enough along to be named — never before.
        </p>
      ) : null}
    </>
  );
}
