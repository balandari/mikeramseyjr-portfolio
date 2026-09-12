import type { ShelfBook } from "@/lib/bookshelf";
import Cover from "./Cover";

/**
 * A title's cover on the shelf -- one frame, the same size for every title.
 *
 * ## Why this exists
 *
 * The shelf used to give a leading thumbnail only to a title that had real
 * cover art, capped at 4.5rem on a phone and 5.5rem on a laptop, while the one
 * title *without* art got the large typographic plate in the featured band
 * above. The finished cover was therefore the smallest thing on the page and
 * the stand-in was the biggest, which is precisely backwards: it read as though
 * the real jacket mattered less than the placeholder.
 *
 * So the shelf now frames every title identically. The frame is the same box at
 * a given width whatever is inside it, and what goes in it is either the real
 * artwork or a compact typographic plate. Neither can be larger than the other,
 * so neither can outrank the other by size.
 *
 * The featured band above the shelf is untouched and still gets its own larger
 * presentation -- that is a deliberate hierarchy between *the current book* and
 * *the rest of the shelf*, which is a different claim from "this cover is more
 * finished than that one".
 *
 * ## The artwork is never cropped or stretched
 *
 * The frame holds its 2:3 proportion and the image is `object-fit: contain`
 * inside it, so art that is not 2:3 is shown whole with space around it rather
 * than trimmed to fit. PERSISTENT's cover is exactly 2:3 and fills the frame
 * precisely; nothing about it is cut off, squashed or upscaled past its
 * intrinsic size.
 */
export default function ShelfCover({ book }: { book: ShelfBook }) {
  if (book.cover) {
    return (
      <span className="ms-shelf-frame" aria-hidden={false}>
        <Cover
          book={book}
          className="ms-shelf-art"
          sizes="(min-width: 64rem) 10rem, (min-width: 30rem) 26vw, 6rem"
        />
      </span>
    );
  }

  /*
   * No approved artwork. A set title page in the site's own faces, ruled in
   * brass -- the same device the featured band uses, at the shelf's size. It
   * reads as deliberate rather than as a missing image, and it never pretends
   * to be a jacket that has not been designed.
   *
   * `aria-hidden`, because every word in it -- the kind, the title, the stage --
   * is already in the row's own text beside it, and a screen reader should not
   * hear the title twice.
   */
  return (
    <span className="ms-shelf-frame ms-shelf-frame--plate" aria-hidden="true">
      <span className="ms-shelf-plate">
        <span className="ms-shelf-plate-top">{book.kind}</span>
        <span className="ms-shelf-plate-mid">
          <span className="ms-shelf-plate-title">{book.title}</span>
          <span className="ms-shelf-plate-by">Mike Ramsey Jr</span>
        </span>
        <span className="ms-shelf-plate-foot">{book.statusLabel}</span>
      </span>
    </span>
  );
}
