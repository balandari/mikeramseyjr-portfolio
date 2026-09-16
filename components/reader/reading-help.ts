/**
 * "How reading works" -- the one place its words are written.
 *
 * ## Why this exists
 *
 * The reader used to explain itself in a single line at the top of a chapter:
 * *"Select any words to highlight them or add a note. Tap a paragraph to
 * bookmark it."* That line is fine the first time somebody opens chapter one,
 * and after that it is almost never seen -- because the reader resumes. Coming
 * back on the third evening drops you at the paragraph you stopped at, four
 * screens down, and the instruction is above you where you will never scroll.
 * An explanation a feature's own success hides is not an explanation.
 *
 * So the same words live in a destination instead: small, always reachable from
 * the reader's own bar, from the reviewer's library, from "My reading", and
 * from Mike's author reader. The chapter-top line stays where it is -- it is
 * still right for a first chapter -- and this is what it can no longer be the
 * only copy of.
 *
 * ## Why it is not an FAQ page
 *
 * It is a sheet on the reader and a short accordion everywhere else, because
 * the honest size of this subject is seven sentences. A full page would have to
 * be padded to look like a page, and padding is how an explanation stops being
 * read.
 *
 * ## Two voices
 *
 * The same seven points, worded for whoever is reading them. Most are identical
 * for both; two are not, and pretending otherwise would put a sentence about
 * "what Mike can see" in front of Mike.
 */

export type ReadingHelpVoice = 'reviewer' | 'author'

export type ReadingHelpItem = {
  /** Stable key. Used for React keys and for the accordion's element ids. */
  id: string
  question: string
  answer: string
}

export function readingHelp(voice: ReadingHelpVoice): ReadingHelpItem[] {
  const author = voice === 'author'

  return [
    {
      id: 'resume',
      question: 'Do I have to remember where I stopped?',
      answer:
        'No. Your place is saved automatically, one place per book, and follows you to any device where you sign in. The reader saves periodically while you scroll and again when you leave a chapter, so it is usually accurate to within a paragraph. If you leave immediately after scrolling, Continue reading may briefly show the previous saved spot; wait a moment or refresh the page. Use a bookmark when you want to mark an exact passage.',
    },
    {
      id: 'bookmark',
      question: 'How do I bookmark a passage?',
      answer:
        'Tap a paragraph. A bookmark appears against it, and a mark in the margin shows it is there. Tap the same paragraph again to remove it. A bookmark is a deliberate thing you put somewhere; it is separate from the place that is saved for you automatically, and removing one never moves your place.',
    },
    {
      id: 'highlight',
      question: 'How do I highlight words or write a note?',
      answer:
        'Select the words. A small row appears offering Highlight, which marks them and is always private, and Note, which opens the composer. A note can be about the words you selected, the whole paragraph, or the whole chapter — you choose in the composer, and there is one Save. Tapping a paragraph offers a note about that paragraph without selecting anything.',
    },
    {
      id: 'many',
      question: 'Is there a limit?',
      answer:
        'No. Keep as many bookmarks, highlights and notes as you like, anywhere in any chapter. They do not replace one another, and they do not replace the place that is saved for you.',
    },
    {
      id: 'my-reading',
      question: 'Where does all of it go?',
      answer: author
        ? 'Into “My reading”, which lists your saved place, every bookmark, and every highlight and note, grouped by book and chapter, each one linking back to its exact passage. What reviewers have shared with you is listed separately on this page, above your own reading.'
        : 'Into “My reading”, which lists your saved place, every bookmark, every highlight, every note, and any earlier submitted comments — grouped by book and chapter, each one linking back to its exact passage.',
    },
    {
      id: 'change',
      question: 'Can I change my mind about something I wrote?',
      answer: author
        ? 'Yes. Open the note from the bookmarks-and-notes panel: you can edit what you wrote, mark it resolved when you have dealt with it, reopen it, or delete it. What it is about does not change — a note stays attached to the passage it was written about.'
        : 'Yes. Open the note from the bookmarks-and-notes panel: you can edit what you wrote, switch it between “Share with Mike” and “Only me”, or delete it entirely. Comments submitted before notes existed are the exception — those were fixed the moment they were sent, which is why they were replaced.',
    },
    {
      id: 'links',
      question: 'What happens if I share a link to a note?',
      answer:
        'Nothing is opened up by the link itself. A private link says which note is meant; it never grants access to the book. Whoever opens it still needs their own sign-in and their own access to that manuscript, so a link that is forwarded, copied or lost shows a stranger nothing at all.',
    },
    {
      id: 'privacy',
      question: 'Who can see what I write?',
      answer: author
        ? 'Your own highlights and notes are yours: they are kept in your own records, separately from every reviewer’s, and no reviewer can see them. There is no control anywhere that shares one, because there is no state in which a reviewer can read it. From a reviewer you see only what they chose to share, plus any comment they submitted under the earlier model. A note they kept private stays private, and this reader has no way to open one.'
        : 'Your place, your bookmarks and your highlights are yours alone — Mike does not see them. Every note says who can see it, on the note itself: “Share with Mike”, or “Only me”. You can change that afterwards, edit what you wrote, or delete it. Nothing you write is public, and no other reviewer sees any of it.',
    },
  ]
}

export const READING_HELP_TITLE = 'How reading works'

export const READING_HELP_BLURB =
  'Eight short answers. Your place is kept for you; everything you mark is yours.'
