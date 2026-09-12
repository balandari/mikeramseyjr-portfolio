import {
  READING_HELP_BLURB,
  READING_HELP_TITLE,
  readingHelp,
  type ReadingHelpVoice,
} from './reading-help'

/**
 * "How reading works", as a compact accordion.
 *
 * Built on native `<details>`/`<summary>`, which is deliberate rather than
 * lazy: it opens and closes with no JavaScript, it is reachable and operable
 * from the keyboard with nothing written here to make it so, it announces its
 * own expanded state to a screen reader, and a browser's find-in-page can open
 * a closed section to show a match. A hand-built accordion would have to
 * re-earn every one of those, and usually earns about half.
 *
 * This is the whole-page form -- the reviewer's library, "My reading", and
 * Mike's author reader. Inside a chapter the same words are shown in the
 * reader's own sheet (`ChapterReader`), because the reader already has one
 * grammar for "something opened over the page" and a second would be noise.
 *
 * `defaultOpen` opens the first question. Used where the component is the
 * reason somebody arrived, so the page does not read as a row of closed boxes.
 *
 * `heading={false}` drops the title, for the reader's sheet -- the sheet has
 * already said what it is across the top, and saying it twice in four lines
 * reads as a mistake rather than as emphasis.
 */
export default function ReadingHelp({
  voice = 'reviewer',
  defaultOpen = false,
  heading = true,
  id = 'how-reading-works',
}: {
  voice?: ReadingHelpVoice
  defaultOpen?: boolean
  heading?: boolean
  id?: string
}) {
  const items = readingHelp(voice)

  return (
    <section
      className="rv-help"
      id={id}
      aria-labelledby={heading ? `${id}-title` : undefined}
      aria-label={heading ? undefined : READING_HELP_TITLE}
    >
      {heading ? (
        <h2 className="rv-help-title" id={`${id}-title`}>
          {READING_HELP_TITLE}
        </h2>
      ) : null}
      <p className="rv-help-blurb">{READING_HELP_BLURB}</p>

      <div className="rv-help-list">
        {items.map((item, index) => (
          <details
            key={item.id}
            className="rv-help-item"
            open={defaultOpen && index === 0}
          >
            <summary className="rv-help-q">
              <span>{item.question}</span>
              <span className="rv-help-chev" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </span>
            </summary>
            <p className="rv-help-a">{item.answer}</p>
          </details>
        ))}
      </div>
    </section>
  )
}

/**
 * The link that leads to it, for pages that put the accordion further down.
 *
 * A full-width control rather than a line of text: it is 44px tall wherever it
 * lands, and it says what it is rather than "Help", which is a word that could
 * mean anything from a manual to a support queue.
 */
export function ReadingHelpLink({
  href = '#how-reading-works',
  className = 'rv-help-link',
}: {
  href?: string
  className?: string
}) {
  return (
    <a href={href} className={className}>
      <span className="rv-help-link-k">{READING_HELP_TITLE}</span>
      <span className="rv-help-link-v">{READING_HELP_BLURB}</span>
    </a>
  )
}
