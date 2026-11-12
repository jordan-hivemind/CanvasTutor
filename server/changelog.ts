// What changed for the tutor, newest last. Conversations that started before an entry get a short
// note about it with the student's next message, so an older chat knows it can now do things it
// may earlier have said it couldn't. (New tools and the current instructions apply to every chat
// automatically; this only explains them.) Add an entry whenever the tutor's abilities change.
export const CHANGELOG: { v: number; date: string; text: string }[] = [
  {
    v: 1,
    date: '2026-11-08',
    text: 'Notes app: notes are now organised Year › Class › …, as markdown notes and canvas notes. You can look across all of the student\'s notes (list_notes, search_notes, read_note, read_folder_info) and keep a per-class Tutor memory with remember. On markdown notes you can type into the note (insert_text), fix text (replace_text) and use Google-Docs-style comments (add_comment, reply_comment).',
  },
  { v: 2, date: '2026-11-08', text: "The student's comments on markdown notes are always addressed to you: answer them in the thread with reply_comment." },
  { v: 3, date: '2026-11-08', text: 'Spoken replies (<say>) now contain almost no math: refer to equations you wrote on screen or on the board instead of reading them out.' },
  { v: 4, date: '2026-11-08', text: 'On canvases you can write outside the student\'s current view when there isn\'t room (the [Whole page] line shows where content ends); frame it with move_view, or the view follows automatically.' },
  { v: 5, date: '2026-11-08', text: 'You can read web pages (WebFetch) and search the web (WebSearch), e.g. the student\'s online textbook. Links in your replies are now clickable for the student.' },
  { v: 6, date: '2026-11-08', text: 'look_at_board can now show the whole page (area: "page") or any region (x, y, w, h), not just the student\'s view.' },
  { v: 7, date: '2026-11-08', text: 'Stricter scope: answer only what was asked. When the student asks whether their work is right so far, say whether it is (and what they did well) and stop: don\'t tell them the next step unless they ask for it.' },
  { v: 8, date: '2026-11-10', text: "read_note on a canvas now shows you an image of the whole canvas, including the student's handwriting. Use it when a question refers to other notes or canvases. New notes are named with their date (e.g. 11-10-26)." },
]

export const CURRENT_VERSION = CHANGELOG[CHANGELOG.length - 1].v

/** A note for a conversation last updated at `seen`, or '' if nothing changed since. */
export function updateNote(seen: number): string {
  const news = CHANGELOG.filter((c) => c.v > seen)
  if (!news.length) return ''
  return `[App update] Since earlier in this conversation, the app has been updated. These now apply, even if you said otherwise before:\n${news.map((c) => `- ${c.text}`).join('\n')}`
}
