/**
 * A book as an object, for the homepage's author's-study bands only.
 *
 * It wraps a face that already exists -- the typographic plate, or a real
 * cover inside its shelf frame -- and adds nothing but depth: a narrow cloth
 * spine to the left, a hairline of page edge along the top and a soft cast
 * shadow. All three are drawn by the stylesheet (`.ms-study-book`) on this
 * wrapper's own pseudo-elements, so the face inside is never redrawn, covered,
 * cropped or put in perspective. A real cover stays whole and flat.
 *
 * It carries no text and no image of its own. The plate keeps its single
 * markup, whichever size it is shown at, and the cover keeps its alt text.
 *
 * `size` only chooses which width the depth is drawn against: the featured
 * book's `--book-w` or the showcase shelf's cover width.
 */
export default function StudyBook({
  size,
  children,
}: {
  size: "featured" | "shelf";
  children: React.ReactNode;
}) {
  return <span className={`ms-study-book ms-study-book--${size}`}>{children}</span>;
}
