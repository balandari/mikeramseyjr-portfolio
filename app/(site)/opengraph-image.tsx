import { ImageResponse } from "next/og";

/**
 * The share image -- what a link to the site shows when it is texted or posted.
 *
 * Typographic and restrained: the name, the plain statement, one short rule, on
 * the same warm paper as the site. No artwork, no photograph, no service.
 *
 * It runs on the edge runtime on purpose. The Node build of the image renderer
 * resolves its own assets through `fileURLToPath`, which throws "Invalid URL"
 * on Windows paths and breaks the production build on this machine; the edge
 * build does not. The cost is that this file cannot read `content/bookshelf/`,
 * so the titles are not listed here -- and rather than keep a second, hand-kept
 * copy of the shelf that would drift, the image says only what will stay true.
 *
 * One further honest limitation: the renderer has no access to the machine
 * fonts the site is set in, so this image uses the renderer's bundled sans.
 * A serif would mean shipping a font file in the repository, which is a licence
 * decision this work does not make.
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
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "84px 96px",
          background: PAPER,
          color: INK,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
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
          <div style={{ fontSize: 96, fontWeight: 700, marginTop: 20, letterSpacing: -1 }}>
            Mike Ramsey Jr
          </div>
          <div style={{ fontSize: 44, color: DIM, marginTop: 12 }}>I write fiction.</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ width: 72, height: 2, background: BRASS }} />
          <div style={{ fontSize: 26, color: DIM, marginTop: 22 }}>mikeramseyjr.com</div>
        </div>
      </div>
    ),
    size,
  );
}
