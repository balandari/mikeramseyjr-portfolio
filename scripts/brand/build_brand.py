#!/usr/bin/env python3
"""
Derive the site's identity assets from Mike's two approved source renders.

This is a one-off asset generator, not part of `npm run build`. It is committed
so the assets under `public/brand/` can be re-derived and audited rather than
taken on trust, and so the numbers in the report can be checked. It needs
Pillow and NumPy, which the site itself does not; nothing in the Next build,
the test suite or the manuscript verifiers imports it.

    python scripts/brand/build_brand.py            # write assets
    python scripts/brand/build_brand.py --check    # verify, write nothing

The two sources are read and never written:

  LOGO  the ceremonial author logo -- a circular black/brass/silver medallion,
        MR over an open book, rendered on an opaque black square.
  MARK  the everyday interface mark -- an ivory M whose counter is an open book
        in brass, on a near-black square.

Neither concept is redesigned here. Exactly three things happen:

  1. LOGO's square background is removed. The medallion is a circle inside a
     black square, and the square's corners and the medallion's interior are
     the *same* black -- so a colour key would eat the interior. The circle is
     measured instead (centre and outer radius fitted from the brass ring) and
     an analytic, supersampled alpha mask is cut at that radius. Before the cut,
     every pixel outside the ring is replaced with the ring colour at the same
     angle ("radial edge clamp"), so there is no black left to bleed into the
     feather and the rim carries brass rather than a dark halo.
  2. MARK is cropped tighter around its glyph -- and nothing else. The source
     sets the M at 64% of the frame's width, which at 16px leaves it about 10px
     wide; the crop takes it to 76%, about 12px. That is the one optical
     adjustment made for small-size recognition. No stroke is thickened, no
     colour is changed, no shape is moved.
  3. Both are resampled (Lanczos) to the sizes the site actually serves.

One production cleanup, which is not a design change: MARK's flat ground is a
render, so it carries sensor-style noise -- 85% of its pixels sit in a band of
five levels around #1b1b1a. Those pixels, and only those, are snapped to the
band's median. It is invisible (after resampling, the largest difference
anywhere in the 512px tile is 14 levels in one channel, and the mean is 0.47)
and it is the difference between a 198 KB icon and a 41 KB one, because noise
is exactly what PNG cannot compress. Nothing brighter than the band is touched,
so no edge, letterform or brass page is altered.

Formats, and why:

  the medallion  WebP. It is a photographic render -- brushed metal, a grained
                 dark field -- and needs alpha, so JPEG is out and PNG cannot
                 compress it (338 KB at 480px, against 28 KB for WebP at the
                 same size, which is the size the site's own portrait JPEG
                 already is). A quantised PNG is written as well and is what
                 the `<picture>` fallback serves.
  the mark       PNG. Flat artwork with three colours and antialiasing, which
                 is what PNG is for, and the icon slots (`.ico`, Apple touch,
                 the application icons) accept nothing else.

No SVG is produced. Both renders are raster artwork with photographic metal
texture in the medallion; an SVG of either would be a trace or a redraw, not
the approved mark, and calling it one would be a lie.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# --------------------------------------------------------------- the sources

LOGO_SRC = Path(r"D:\ts\mrjr.com\home page logo\ChatGPT Image Sep 11, 2026, 07_51_14 PM.png")
MARK_SRC = Path(r"D:\ts\mrjr.com\favicon\ChatGPT Image Sep 11, 2026, 07_52_00 PM.png")

# Pinned so the generator cannot quietly be pointed at a different render that
# happens to sit at the same path.
LOGO_SHA = "ce600b889c07f599c481522444502d152d96ea31cdd95d04d99a0b1796f4667a"
MARK_SHA = "a7159c6136a35fa65d9482255f836a3bcddf13b56a4a5f7ef90092a5b5328435"

REPO = Path(__file__).resolve().parents[2]
PUBLIC = REPO / "public"
BRAND = PUBLIC / "brand"

RING_FEATHER = 2.0  # px at source resolution -- the alpha mask's soft edge
MARK_WIDTH_FILL = 0.76  # the glyph's share of the cropped tile's width
MARK_GROUND_BAND = 8  # levels above the ground median that count as ground noise

# The hero draws the medallion between 140px and 240px, so 480 covers every
# density a phone or a laptop will ask for. The PNG is the `<picture>` fallback.
LOGO_WEBP_SIZES = (240, 480)
LOGO_PNG_FALLBACK = 320
LOGO_WEBP_QUALITY = 85

# The medallion the share image embeds, at the size the share image draws it.
OG_LOGO_SIZE = 300
OG_MODULE = REPO / "app" / "(site)" / "og-medallion.ts"

MARK_PNG_SIZES = (16, 32, 48, 64, 96, 180, 192, 512)
MARK_PALETTE = 128
ICO_SIZES = (16, 32, 48)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ------------------------------------------------------------------ geometry


def fit_medallion(rgb: np.ndarray) -> tuple[float, float, float]:
    """Centre and outer radius of the medallion, fitted from the brass ring.

    The ring is the only bright thing near the frame's edge, so: take the
    bright pixels, keep the ones far from a first-guess centre, and let the
    extremes of that annulus define the centre and the radius. Iterated, so a
    bad first guess cannot bias the answer.
    """
    lum = rgb.max(axis=2)
    h, w = lum.shape
    ys, xs = np.mgrid[0:h, 0:w]
    bright = lum > 45

    y, x = np.where(bright)
    cx, cy = (x.min() + x.max()) / 2.0, (y.min() + y.max()) / 2.0
    for _ in range(8):
        r = np.hypot(xs - cx, ys - cy)
        y, x = np.where(bright & (r > 0.38 * w))
        cx, cy = (x.min() + x.max()) / 2.0, (y.min() + y.max()) / 2.0

    r = np.hypot(xs - cx, ys - cy)
    radius = float(r[bright & (r > 0.38 * w)].max())
    return cx, cy, radius


def radial_edge_clamp(rgb: np.ndarray, cx: float, cy: float, edge: float) -> np.ndarray:
    """Replace everything beyond `edge` with the colour at `edge`, same angle.

    Nearest neighbour along the ray is enough: this colour is only ever seen
    under a feathered or fully transparent pixel, and its whole job is to stop
    pure black leaking into the rim when the image is resampled.
    """
    h, w, _ = rgb.shape
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float64)
    dx, dy = xs - cx, ys - cy
    r = np.hypot(dx, dy)
    outside = r > edge

    scale = np.ones_like(r)
    scale[outside] = edge / np.maximum(r[outside], 1e-6)
    sx = np.clip(np.rint(cx + dx * scale), 0, w - 1).astype(np.int32)
    sy = np.clip(np.rint(cy + dy * scale), 0, h - 1).astype(np.int32)

    out = rgb.copy()
    out[outside] = rgb[sy[outside], sx[outside]]
    return out


def disc_alpha(size: int, cx: float, cy: float, radius: float, ss: int = 4) -> np.ndarray:
    """Coverage of a disc on a size x size grid, supersampled ss x ss.

    Computed analytically at the *output* size rather than by shrinking a large
    binary mask, so the circle's edge is as clean at 240px as at 1254px.
    """
    n = size * ss
    coords = (np.arange(n) + 0.5) / ss  # sample centres, in output-pixel units
    dy = coords[:, None] - cy
    dx = coords[None, :] - cx
    inside = (dx * dx + dy * dy) <= radius * radius
    return inside.reshape(size, ss, size, ss).mean(axis=(1, 3))


def medallion_rgba(px: int) -> Image.Image:
    """The medallion at px square, transparent outside the brass ring."""
    src = Image.open(LOGO_SRC).convert("RGB")
    rgb = np.asarray(src).astype(np.float64)
    cx, cy, radius = fit_medallion(rgb)

    clamped = radial_edge_clamp(rgb, cx, cy, radius - 1.0)
    colour = Image.fromarray(clamped.round().clip(0, 255).astype(np.uint8), "RGB")
    colour = colour.resize((px, px), Image.LANCZOS)

    # The feather is expressed in source pixels and scaled, so the softness is
    # the same relative amount at every size.
    s = px / src.width
    inner = disc_alpha(px, cx * s, cy * s, (radius - RING_FEATHER) * s)
    outer = disc_alpha(px, cx * s, cy * s, radius * s)
    alpha = (inner + outer) / 2.0

    rgba = np.dstack(
        [np.asarray(colour), (alpha * 255.0).round().clip(0, 255).astype(np.uint8)]
    )
    return Image.fromarray(rgba, "RGBA")


def mark_source() -> tuple[Image.Image, int, np.ndarray]:
    """The mark render with its ground noise snapped flat; see the module note.

    Returns the cleaned image, the ground level it was measured at, and the
    exact ground colour, so the run can report both.
    """
    src = Image.open(MARK_SRC).convert("RGB")
    a = np.asarray(src).astype(np.int16)
    lum = a.max(axis=2)

    ground = int(np.median(lum[:8, :]))
    is_ground = lum <= ground + MARK_GROUND_BAND
    colour = np.median(a[is_ground].reshape(-1, 3), axis=0).astype(np.int16)

    cleaned = a.copy()
    cleaned[is_ground] = colour
    return Image.fromarray(cleaned.astype(np.uint8), "RGB"), ground, colour


def mark_geometry() -> tuple[Image.Image, tuple[float, float, float, float], float]:
    """The cleaned source, the crop box, and the glyph's share of its width."""
    src, ground, _ = mark_source()
    lum = np.asarray(src).max(axis=2)

    y, x = np.where(lum > ground + 40)
    gx0, gx1, gy0, gy1 = int(x.min()), int(x.max()), int(y.min()), int(y.max())
    gcx, gcy = (gx0 + gx1) / 2.0, (gy0 + gy1) / 2.0
    side = (gx1 - gx0 + 1) / MARK_WIDTH_FILL

    left, top = gcx - side / 2.0, gcy - side / 2.0
    box = (left, top, left + side, top + side)
    if left < 0 or top < 0 or box[2] > src.width or box[3] > src.height:
        raise SystemExit(f"the crop falls outside the source render: {box}")
    return src, box, (gx1 - gx0 + 1) / side


def mark_tile(px: int) -> Image.Image:
    """The interface mark at px square: opaque tile, glyph cropped tighter.

    The tile stays opaque on purpose. The glyph is ivory; on a transparent
    ground it would vanish against a light browser tab strip. The dark tile is
    the thing that makes it legible on both light and dark chrome.
    """
    src, box, _ = mark_geometry()
    return src.resize((px, px), Image.LANCZOS, box=box).convert("RGB")


# ---------------------------------------------------------------------- .ico


def _dib_entry(im: Image.Image) -> bytes:
    """One ICO entry as a 32-bit BGRA DIB, with the AND mask readers expect."""
    w, h = im.size
    rgba = np.asarray(im.convert("RGBA"))
    bgra = np.ascontiguousarray(rgba[:, :, [2, 1, 0, 3]][::-1])  # BGRA, bottom-up
    header = struct.pack(
        "<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, bgra.nbytes, 0, 0, 0, 0
    )
    row = ((w + 31) // 32) * 4  # a fully opaque 1-bit AND mask, rows 4-byte padded
    return header + bgra.tobytes() + b"\x00" * (row * h)


def _png_entry(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def write_ico(images: list[Image.Image]) -> bytes:
    """A multi-size ICO: uncompressed DIB below 256px, PNG at 256 and above."""
    payloads = [(_png_entry(im) if im.width >= 256 else _dib_entry(im)) for im in images]
    out = bytearray(struct.pack("<HHH", 0, 1, len(images)))
    offset = 6 + 16 * len(images)
    for im, data in zip(images, payloads):
        w = 0 if im.width >= 256 else im.width
        h = 0 if im.height >= 256 else im.height
        out += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    for data in payloads:
        out += data
    return bytes(out)


# --------------------------------------------------------------------- write


def encode(im: Image.Image, fmt: str, **kw) -> bytes:
    buf = io.BytesIO()
    im.save(buf, fmt, **kw)
    return buf.getvalue()


def flat_png(im: Image.Image) -> tuple[bytes, float, float]:
    """PNG bytes for flat artwork, plus the palette's worst and mean error.

    Palettising is a win at every size that matters and a small loss at 16px,
    where the palette chunk costs more than it saves -- so the smaller of the
    two encodings is taken. Deterministic either way: both are a pure function
    of the tile.
    """
    plain = encode(im, "PNG", optimize=True)
    quant = im.quantize(colors=MARK_PALETTE, method=Image.MEDIANCUT, dither=Image.Dither.NONE)
    packed = encode(quant, "PNG", optimize=True)
    if len(packed) >= len(plain):
        return plain, 0.0, 0.0

    a = np.asarray(im.convert("RGB")).astype(np.int16)
    b = np.asarray(quant.convert("RGB")).astype(np.int16)
    d = np.abs(a - b)
    return packed, float(d.max()), float(d.mean())


def build() -> tuple[dict[Path, bytes], list[str]]:
    out: dict[Path, bytes] = {}
    notes: list[str] = []

    for px in LOGO_WEBP_SIZES:
        out[BRAND / f"logo-{px}.webp"] = encode(
            medallion_rgba(px), "WEBP", quality=LOGO_WEBP_QUALITY, method=6
        )

    fallback = medallion_rgba(LOGO_PNG_FALLBACK).quantize(
        colors=256, method=Image.FASTOCTREE, dither=Image.Dither.NONE
    )
    out[BRAND / f"logo-{LOGO_PNG_FALLBACK}.png"] = encode(fallback, "PNG", optimize=True)

    tiles = {px: mark_tile(px) for px in sorted(set(MARK_PNG_SIZES) | set(ICO_SIZES))}
    worst = 0.0
    for px in MARK_PNG_SIZES:
        data, hi, mean = flat_png(tiles[px])
        out[BRAND / f"mark-{px}.png"] = data
        worst = max(worst, hi)
        if px == 512:
            notes.append(f"mark palette error at 512px: max {hi:.0f}/255, mean {mean:.2f}")
    notes.append(f"mark palette error across all sizes: max {worst:.0f}/255")

    # `app/favicon.ico` is Next's own metadata-file convention and is where
    # this site has always kept it; a second copy in `public/` would collide.
    out[REPO / "app" / "favicon.ico"] = write_ico([tiles[px] for px in ICO_SIZES])

    # The three metadata icons keep the filenames the site already declares.
    out[PUBLIC / "apple-touch-icon.png"] = out[BRAND / "mark-180.png"]
    out[PUBLIC / "icon-192.png"] = out[BRAND / "mark-192.png"]
    out[PUBLIC / "icon-512.png"] = out[BRAND / "mark-512.png"]

    out[OG_MODULE] = og_module(medallion_rgba(OG_LOGO_SIZE))

    return out, notes


def og_module(medallion: Image.Image) -> bytes:
    """The share image's medallion, as a data URI in a TypeScript module.

    `app/(site)/opengraph-image.tsx` runs on the edge runtime -- see its own
    note for why it cannot run on Node on this machine -- so it has no
    filesystem and nothing to fetch from at build time. A data URI is the one
    way to put a real image in it, and keeping the string in its own module
    keeps the share image itself readable.

    Quantised to 256 colours because this is the one asset whose bytes are
    pasted into source; it is drawn at its native size in a 1200x630 canvas
    that social clients rescale anyway.
    """
    quant = medallion.quantize(colors=256, method=Image.FASTOCTREE, dither=Image.Dither.NONE)
    import base64

    uri = "data:image/png;base64," + base64.b64encode(encode(quant, "PNG", optimize=True)).decode()
    text = (
        "/*\n"
        " * The author medallion, as a data URI -- generated, not hand-written.\n"
        " *\n"
        " * `opengraph-image.tsx` runs on the edge runtime, so it has no\n"
        " * filesystem and no origin to fetch from while the site is being\n"
        " * built. This is the only way to put the real mark in the share\n"
        " * image. Regenerate with `python scripts/brand/build_brand.py`;\n"
        " * do not edit by hand.\n"
        " *\n"
        f" * Source: the approved circular logo, masked to its ring, {OG_LOGO_SIZE}px,\n"
        " * PNG quantised to 256 colours.\n"
        " */\n"
        f"export const OG_MEDALLION = '{uri}'\n"
    )
    return text.encode("utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="compare with what is on disk")
    args = ap.parse_args()

    for src, pin in ((LOGO_SRC, LOGO_SHA), (MARK_SRC, MARK_SHA)):
        if not src.is_file():
            raise SystemExit(f"missing source render: {src}")
        got = sha256(src)
        if got != pin:
            raise SystemExit(f"{src.name} is not the approved render\n  want {pin}\n  got  {got}")
    print("both source renders match their pinned SHA-256")

    rgb = np.asarray(Image.open(LOGO_SRC).convert("RGB")).astype(np.float64)
    cx, cy, radius = fit_medallion(rgb)
    print(
        f"medallion fitted: centre ({cx:.2f}, {cy:.2f}), outer radius {radius:.2f}px "
        f"in a {rgb.shape[1]}px render"
    )
    _, ground, colour = mark_source()
    print(
        f"mark ground snapped: levels <= {ground + MARK_GROUND_BAND} set to "
        f"rgb({colour[0]}, {colour[1]}, {colour[2]})"
    )
    _, box, fill = mark_geometry()
    print(
        f"mark cropped to {box[2] - box[0]:.1f}px square at "
        f"({box[0]:.1f}, {box[1]:.1f}); glyph fills {fill * 100:.1f}% of its width"
    )

    files, notes = build()
    for note in notes:
        print(note)

    if args.check:
        bad = [p for p, data in files.items() if (p.read_bytes() if p.is_file() else None) != data]
        for path in bad:
            print(f"  DIFFERS  {path.relative_to(REPO)}")
        print(f"{len(files) - len(bad)}/{len(files)} files match the generator")
        return 1 if bad else 0

    BRAND.mkdir(parents=True, exist_ok=True)
    for path, data in files.items():
        path.write_bytes(data)
    print(f"wrote {len(files)} files")
    for path in sorted(files, key=lambda p: str(p)):
        print(f"  {str(path.relative_to(REPO)):34s} {len(files[path]):8,d} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
