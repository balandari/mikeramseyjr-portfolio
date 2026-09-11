import type { ShelfBook } from "@/lib/bookshelf";

/**
 * A title's real cover, where one exists.
 *
 * Renders the derivatives declared on the title's JSON through `srcset`, and
 * lets each placement say how wide the image will actually be (`sizes`), so
 * the shelf's small thumbnail fetches the small file and the book page fetches
 * the larger one. `width`/`height` are the intrinsic size of the default file,
 * so the layout reserves the right box before the bytes arrive; the rendered
 * width comes from the stylesheet, and `height: auto` keeps the artwork's own
 * proportion -- a cover is never cropped or stretched here.
 *
 * The source artwork is not in this repository and is not touched. Only scaled
 * copies are, and nothing in them -- artwork, author name, subtitle, type -- is
 * altered.
 */
export default function Cover({
  book,
  sizes,
  className = "ms-cover",
  priority = false,
}: {
  book: ShelfBook;
  sizes: string;
  className?: string;
  priority?: boolean;
}) {
  const cover = book.cover;
  if (!cover) return null;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src={cover.src}
      srcSet={cover.srcSet}
      sizes={sizes}
      width={cover.width}
      height={cover.height}
      alt={cover.alt}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
    />
  );
}
