import type { ShelfBook } from "@/lib/bookshelf";
import Cover from "./Cover";

/**
 * A title's visual in the featured presentation.
 *
 * With approved cover art, that art. Without it, a typographic plate: a set
 * title page, ruled in brass, in the same faces as the rest of the site. It
 * reads as deliberate rather than as a missing image, and it never pretends to
 * be a jacket that has not been designed.
 *
 * Adding `"cover"` to a title's file in `content/bookshelf/` switches this from
 * the plate to the artwork, here and everywhere else the title appears. No
 * other file changes.
 *
 * `sizes` is optional and only matters once a title has artwork: the homepage's
 * author's-study band draws this at its own width and says so. Leaving it out
 * keeps the original presentation's value.
 */
export default function BookPlate({
  book,
  sizes = "(min-width: 48rem) 17rem, 100vw",
}: {
  book: ShelfBook;
  sizes?: string;
}) {
  if (book.cover) {
    return (
      <Cover
        book={book}
        className="ms-cover ms-plate"
        sizes={sizes}
        priority
      />
    );
  }

  return (
    <div className="ms-plate" aria-hidden="true">
      <p className="ms-plate-top">{book.kind}</p>

      <div className="ms-plate-mid">
        <p className="ms-plate-title">{book.title}</p>
        <p className="ms-plate-by">Mike Ramsey Jr</p>
      </div>

      <p className="ms-plate-foot">{book.statusLabel}</p>
    </div>
  );
}
