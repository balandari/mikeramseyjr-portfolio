/**
 * The everyday interface mark: an ivory `M` whose counter is an open book in
 * brass, on a near-black tile.
 *
 * This is the small, working half of Mike's identity — the one that goes in a
 * header, a footer, a sign-in panel, a tab. The ceremonial circular medallion
 * is `AuthorLogo`, and it appears once, on the homepage. The two are not
 * interchangeable: at 28px the medallion's ring, letters and book collapse into
 * a smudge, which is exactly why the simplified mark exists.
 *
 * The tile is opaque on purpose. The glyph is ivory; on a transparent ground it
 * would disappear against a light browser tab strip or the site's own paper.
 * The dark tile is what makes it legible on both light and dark chrome, and it
 * is the same near-black the medallion's field is set in. Corner rounding is
 * left to the caller's stylesheet, so a square tab icon and a rounded interface
 * mark come from the same file.
 *
 * Derivatives are pre-built (`scripts/brand/build_brand.py`) and picked by the
 * browser from `srcset`, the same way `Cover` and `Portrait` work here — the
 * site optimises no images at request time.
 *
 * `alt` defaults to empty because the mark almost always sits next to the name
 * it stands for, and a screen reader announcing "Mike Ramsey Jr" twice is
 * worse than silence. Where it stands alone, pass one.
 */
const SRCSET = [
  "/brand/mark-32.png 32w",
  "/brand/mark-48.png 48w",
  "/brand/mark-64.png 64w",
  "/brand/mark-96.png 96w",
  "/brand/mark-192.png 192w",
].join(", ");

export default function AuthorMark({
  size,
  className,
  alt = "",
}: {
  /** Rendered edge length in CSS pixels. The stylesheet may still override it. */
  size: number;
  className?: string;
  alt?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src="/brand/mark-96.png"
      srcSet={SRCSET}
      sizes={`${size}px`}
      width={size}
      height={size}
      alt={alt}
      decoding="async"
    />
  );
}
