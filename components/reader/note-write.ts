/**
 * One note write, in one place.
 *
 * The reader's three revision-bound writes -- the composer's save, the one-tap
 * visibility change and Mike's one-tap status change -- all do the same five
 * things in the same order, and what matters about them is the order. Each
 * sends exactly one request, against the version the browser actually
 * rendered; a refusal is reported and the typed words are left alone; only a
 * save that succeeded is allowed to end the edit. A second attempt made from
 * here, at a revision nobody rendered, is how a note narrowed on another
 * device gets re-widened.
 *
 * Those promises used to be spread across three handlers inside a 3,483-line
 * client component, where nothing could import them and the only way to
 * examine them was to read the component's source as text and assert on the
 * shape of it. That is what `tests/note-composer.test.ts` did, and it is a
 * proof about text rather than about behaviour: it constrains the region it
 * extracts and nothing outside it.
 *
 * So the sequence lives here instead -- pure, with no React, and with its one
 * import erased at compile time -- and `tests/note-write.test.ts` drives it
 * with a fake `send` and counts what actually happens. The component keeps the
 * decisions that are genuinely its own: which transport to call, what to send
 * it, and what to do with what comes back.
 *
 * `components/reader/note-composer.ts` is the same arrangement for the same
 * reason.
 *
 * ## What this deliberately does not do
 *
 * There is no `try`, no `catch` and no `finally` here, and that is a decision
 * rather than an omission. Nothing on this path catches today: `send`
 * (`app/review/reading-client.ts:133-154`) calls `fetch` without a guard, and
 * neither `saveNote` nor `updateNoteRecord` wraps it. A transport that
 * rejects -- an offline tab, a dropped connection -- therefore rejects out of
 * this function too, with `busy` left `true`, exactly as it did before this
 * module existed. Wrapping the sequence in `try`/`finally` would read as a
 * tidy-up and would change behaviour. Whether that behaviour is right is a
 * separate question from whether it is preserved, and only the second one is
 * settled here.
 */

import type { ReadingOutcome } from '../../app/review/reading-client.ts'

/**
 * What the component wants done as the write proceeds.
 *
 * These are callbacks rather than returned state because the caller is a React
 * component and the things it has to do -- set `busy`, put a message in the
 * banner, merge the saved row into the list, close the sheet -- are setter
 * calls that belong to it. This module decides only when each one runs, and
 * whether it runs at all.
 */
export type NoteWriteEffects<T> = {
  /** `true` before the request, `false` after it resolves. Both, always. */
  busy: (value: boolean) => void

  /**
   * The failure message, verbatim from the server's answer -- or `null` to
   * clear whatever was there, which happens only when `clearReport` is set.
   */
  report: (message: string | null) => void

  /** The saved record. Runs on success only. */
  accepted: (value: T) => void

  /**
   * Everything that ends the edit: closing the composer, dropping the draft,
   * closing the sheet. Runs after `accepted`, on success only. A write that
   * failed never reaches it, which is what keeps the typed words on screen
   * when the server is the one thing that does not have them.
   */
  finished?: () => void

  /**
   * Clear the previous report before sending.
   *
   * Opt-in, and exactly one caller opts in: the composer, which has always
   * done `setBusy(true)` then `setOutcome(null)`. The two one-tap changes have
   * never cleared the banner at the start of a write, so a failure message
   * they raised survives the next tap. That is existing behaviour and it is
   * left alone -- clearing it here would be a user-visible change smuggled
   * into a refactor that promises not to make any.
   */
  clearReport?: boolean
}

/**
 * Send one note write, once, and run the effects in a fixed order.
 *
 * The transport is taken as a function plus its arguments rather than as a
 * pre-bound closure, and that is the point of the signature. A closure could
 * hide a retry, a second call or an adjusted revision inside itself, where no
 * test here could see it; taking `send` by name forces the call to be spelled
 * out at the call site, where the whole-file guards in
 * `tests/note-composer.test.ts` can count it.
 *
 * Returns `true` when the server accepted the write and `false` when it
 * refused it. The composer's caller uses that answer; the one-tap changes
 * ignore it.
 */
export async function writeNoteOnce<A extends unknown[], T>(
  send: (...args: A) => Promise<ReadingOutcome<T>>,
  args: A,
  effects: NoteWriteEffects<T>,
): Promise<boolean> {
  effects.busy(true)
  if (effects.clearReport) effects.report(null)

  // Once. Not in a loop, not again on a 409, not with a revision derived from
  // the one it was handed.
  const result = await send(...args)

  effects.busy(false)

  if (!result.ok) {
    /*
     * Reported, and nothing else. The edit is not ended, so whatever the
     * reader typed is still on screen and still theirs -- which matters most
     * for a conflict, because the words the server does not have are exactly
     * the words that would be thrown away by "resynchronising".
     */
    effects.report(result.message)
    return false
  }

  effects.accepted(result.value)
  effects.finished?.()
  return true
}
