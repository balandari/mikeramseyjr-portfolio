import type { ShelfBook } from "@/lib/bookshelf";

/**
 * A title's visual stand-in.
 *
 * No cover art exists for anything on this shelf, and a mocked-up jacket would
 * be a picture of a book that has never been designed. So a plate is exactly
 * what it looks like: a set title page, ruled in brass, in the same faces as
 * the rest of the site. It reads as deliberate rather than as a missing image.
 *
 * ASSET: when Mike has approved cover artwork for a title, add
 * `"cover": { "src": "/covers/<slug>.jpg", "alt": "..." }` to that title's file
 * in `content/bookshelf/` and it is used here instead. No other file changes.
 */
export default function BookPlate({
  book,
  small = false,
}: {
  book: ShelfBook;
  small?: boolean;
}) {
  if (book.cover) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className={small ? "ms-plate ms-plate--sm" : "ms-plate"}
        src={book.cover.src}
        alt={book.cover.alt}
      />
    );
  }

  return (
    <div className={small ? "ms-plate ms-plate--sm" : "ms-plate"} aria-hidden="true">
      <p className="ms-plate-top">{book.kind}</p>

      <div className="ms-plate-mid">
        <p className="ms-plate-title">{book.title}</p>
        <p className="ms-plate-by">Mike Ramsey Jr</p>
      </div>

      <p className="ms-plate-foot">{book.statusLabel}</p>
    </div>
  );
}
