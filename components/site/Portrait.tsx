/**
 * Mike's photograph.
 *
 * The source Mike supplied is a 1419x1419 PNG, 2.2 MB. Two optimised JPEG
 * copies are served instead -- 480px and 960px -- and the browser picks by
 * density and by the width the layout actually gives the image. The source is
 * not in this repository and was not modified.
 *
 * The frame is cropped in CSS rather than in the files (see `.ms-portrait`), so
 * one pair of square images serves both the wide band on a phone and the taller
 * plate beside the text on a desktop.
 *
 * `width`/`height` are the intrinsic square dimensions, which is what the
 * browser needs to reserve space; the rendered shape comes from the stylesheet.
 * Loading is eager only where the image is above the fold.
 */
export default function Portrait({
  priority = false,
  className = "ms-portrait",
}: {
  priority?: boolean;
  className?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src="/portrait/mike-ramsey-jr-960.jpg"
      srcSet="/portrait/mike-ramsey-jr-480.jpg 480w, /portrait/mike-ramsey-jr-960.jpg 960w"
      sizes="(min-width: 52rem) 15rem, min(22rem, 100vw)"
      width={960}
      height={960}
      alt="Mike Ramsey Jr — a bearded man in a rust-coloured T-shirt, looking straight at the camera, in front of a softly blurred window."
      loading={priority ? "eager" : "lazy"}
      decoding="async"
    />
  );
}
