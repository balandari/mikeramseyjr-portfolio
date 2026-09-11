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
 */
export default function BookPlate({ book }: { book: ShelfBook }) {
  if (book.cover) {
    return (
      <Cover
        book={book}
        className="ms-cover ms-plate"
        sizes="(min-width: 48rem) 17rem, 100vw"
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
