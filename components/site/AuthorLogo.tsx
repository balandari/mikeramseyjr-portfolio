/**
 * The ceremonial author logo: the circular medallion, `MR` over an open book,
 * in black, brass and silver.
 *
 * This standalone version is retained for places that need the isolated mark.
 * The homepage now uses a wider photographic scene that already contains the
 * medallion, so rendering this component there as well would duplicate it. The
 * small `AuthorMark` continues to do the everyday header and footer jobs.
 *
 * The square black background of Mike's render is removed, not keyed out: the
 * corners and the medallion's own field are the same black, so the circle is
 * measured and cut geometrically. See `scripts/brand/build_brand.py`.
 *
 * WebP, with a PNG fallback, and the reason is the artwork. This is a
 * photographic render — brushed metal, a grained field — that also needs an
 * alpha channel, so JPEG cannot carry it and PNG cannot compress it: 338 KB at
 * 480px against 31 KB for the WebP. Every browser that can render this site's
 * stylesheet supports WebP, but `<picture>` costs four lines and removes the
 * question, and the fallback is the only thing the PNG is ever fetched for.
 */
export default function AuthorLogo({
  className,
  sizes,
  priority = false,
  alt = "Mike Ramsey Jr's author mark: the letters M and R in silver and brass over an open book, inside a brass ring.",
}: {
  className?: string;
  /** What width the layout will actually give the image, for `srcset` picking. */
  sizes: string;
  priority?: boolean;
  alt?: string;
}) {
  /*
   * `className` goes on the `<picture>`, not on the `<img>`, and that is not a
   * detail. The `<picture>` is what a layout actually sees -- it is the flex or
   * grid item, and it is what `order`, `align-self` and a width cap have to be
   * applied to. Putting the class on the image instead leaves the picture an
   * unstyled inline box and every one of those rules silently does nothing.
   * The image fills whatever the picture is given.
   */
  return (
    <picture className={className}>
      <source
        type="image/webp"
        srcSet="/brand/logo-240.webp 240w, /brand/logo-480.webp 480w"
        sizes={sizes}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="ms-logo-img"
        src="/brand/logo-320.png"
        width={480}
        height={480}
        alt={alt}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
      />
    </picture>
  );
}
