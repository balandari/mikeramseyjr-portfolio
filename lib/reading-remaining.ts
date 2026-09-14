/**
 * "About 9 min left" — the one line of reassurance a scrolling chapter owes a
 * reader who cannot see how much paper is left in their hand.
 *
 * This is arithmetic on two numbers the reader has already been shown, and
 * nothing more:
 *
 *   - `minutes`  the chapter's existing estimated reading time, the same figure
 *                printed under the chapter title ("about 22 min") and on the
 *                contents sheet. It comes from the manuscript, not from anyone's
 *                behaviour.
 *   - `progress` how far down the chapter the reader has scrolled, 0 to 1.
 *
 * **It is not measured reading.** Nobody is timed, no reading speed is
 * inferred, nothing about a reviewer's pace is recorded or sent anywhere. A
 * reader who scrolls to the bottom without reading a word is told they are
 * almost finished, because scroll position is the only thing this knows. That
 * is the honest limit of the estimate and is why every string says "About".
 *
 * Whole minutes only, and never a second — a countdown that ticks is a clock,
 * and a clock over a novel is the opposite of what this is for.
 */

/**
 * The label for a chapter, or `null` when there is nothing honest to say.
 *
 * `null` — rendered as nothing at all — is returned when the chapter carries no
 * usable estimate. A chapter with no reading time is not given a made-up one.
 *
 * `atEnd` is the one thing here that is not arithmetic: it is the page
 * reporting that it cannot scroll any further. It exists because the estimate
 * and the end of the chapter are different facts and were being conflated.
 * `Math.ceil` reaches zero a little before the last line — the reader still has
 * the tail of a minute and the whole of the dock and the end-of-chapter links
 * below them — so "the estimate has run out" was being printed as if it meant
 * "you have finished", and at the actual bottom it went on saying *Almost
 * finished* with nothing left to be almost finished with.
 *
 * So the two are now said separately. The estimate keeps its own last word,
 * *Almost finished*, for the stretch where a little is left; **`Chapter
 * complete` is only ever the page's own report that there is no more of it**,
 * and is never inferred from a rounded number.
 */
export function remainingReadingLabel(
  minutes: number,
  progress: number,
  /** True only when the page genuinely cannot scroll any further. */
  atEnd = false,
): string | null {
  if (!Number.isFinite(minutes) || minutes <= 0) return null
  if (!Number.isFinite(progress)) return null

  if (atEnd) return 'Chapter complete'

  const done = progress < 0 ? 0 : progress > 1 ? 1 : progress
  /*
   * `ceil`, not `round`: a reader with fractionally more than eight minutes to
   * go should be told nine and find it took less, never told eight and find it
   * took longer. The estimate may be generous; it may not be optimistic.
   */
  const left = Math.ceil(minutes * (1 - done))

  // The end of the scroll. "0 min left" is not something a person says.
  if (left <= 0) return 'Almost finished'
  if (left === 1) return 'About 1 min left'
  return `About ${left} min left`
}
