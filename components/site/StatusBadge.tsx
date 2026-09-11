import type { ShelfBook } from "@/lib/bookshelf";

/**
 * A title's stage, and nothing more.
 *
 * The label comes from the title's own file, so the shelf can never show a
 * release date, a retailer, a review or a pre-order that Mike has not written
 * down himself. "Work in progress" is the truth about this book today, and the
 * site says exactly that.
 */
export default function StatusBadge({ book }: { book: ShelfBook }) {
  return (
    <span className="ms-badge">
      <span className="ms-badge-dot" aria-hidden="true" />
      {book.statusLabel}
    </span>
  );
}
