import { ImageResponse } from "next/og";

import { OG_MEDALLION } from "./og-medallion";

/**
 * The share image -- what a link to the site shows when it is texted or posted.
 *
 * The author medallion and the name, on the same warm paper as the site, with
 * one brass rule and the domain. It is a calling card, not an advertisement:
 * no cover, no book title, no invitation, no call to action, nothing that will
 * stop being true. The medallion is the only ornament and it is smaller than
 * the name, which is the hierarchy the homepage uses too.
 *
 * It runs on the edge runtime on purpose. The Node build of the image renderer
 * resolves its own assets through `fileURLToPath`, which throws "Invalid URL"
 * on Windows paths and breaks the production build on this machine; the edge
 * build does not. The cost is that this file cannot read from disk and has no
 * origin to fetch from while the site is being built -- so the medallion is a
 * data URI in `og-medallion.ts`, generated from the same source render as every
 * other asset, and that is the only way a real image can be in this file.
 *
 * The same limitation applies to type: the renderer has no access to the
 * machine fonts the site is set in, so this image uses the renderer's bundled
 * sans. A serif would mean shipping a font file in the repository, which is a
 * licence decision this work does not make.
 */
export const runtime = "edge";
export const alt = "Mike Ramsey Jr — I write fiction.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PAPER = "#f3ecdf";
const INK = "#1a1611";
const DIM = "#4f4639";
const BRASS = "#6f5626";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          gap: 56,
          padding: "84px 96px",
          background: PAPER,
          color: INK,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
          <div
            style={{
              fontSize: 22,
              letterSpacing: 4,
              textTransform: "uppercase",
              color: BRASS,
            }}
          >
            Fiction
          </div>
          <div style={{ fontSize: 76, fontWeight: 700, marginTop: 18, letterSpacing: -1 }}>
            Mike Ramsey Jr
          </div>
          <div style={{ fontSize: 38, color: DIM, marginTop: 12 }}>I write fiction.</div>

          <div style={{ display: "flex", width: 72, height: 2, background: BRASS, marginTop: 36 }} />
          <div style={{ fontSize: 26, color: DIM, marginTop: 22 }}>mikeramseyjr.com</div>
        </div>

        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={OG_MEDALLION} width={280} height={280} alt="" />
      </div>
    ),
    size,
  );
}
