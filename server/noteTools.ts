// Tools for working with the student's notes:
//  - every note: look around the notes tree (other classes included), read folder About/memory,
//    and keep the class's Tutor memory up to date
//  - markdown notes: edit the open note and comment on it. These are carried out by the student's
//    editor (so they type out live, sync to other devices and can be undone) and report back.
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

export type NotesAccess = {
  notePath: () => string
  list: (folder: string) => string
  read: (path: string) => string
  /** The note's id if the path is a canvas, else null. */
  canvasId: (path: string) => string | null
  search: (query: string) => string
  folderInfo: (path: string) => string
  remember: (folder: string | undefined, text: string, mode: 'add' | 'replace') => string
}

export type MdOp =
  | { op: 'insert'; markdown: string; after?: string; at?: 'start' | 'end' }
  | { op: 'replace'; find: string; replace: string }
  | { op: 'comment'; quote: string; text: string }
  | { op: 'reply'; commentId: string; text: string }
export type MdOpResult = { ok: boolean; message: string }

type Ctx = {
  status: (s: string) => void
  mdOp: (op: MdOp) => Promise<MdOpResult>
  access: NotesAccess
  snapshot: (region?: { note: string }) => Promise<{ image?: { data: string; mediaType: string }; context: string }>
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) })
const safe = async (f: () => string | Promise<string>) => {
  try {
    return text(await f())
  } catch (e) {
    return text(e instanceof Error ? e.message : String(e), true)
  }
}

export function notesTools(getCtx: () => Ctx | null) {
  const ctx = () => {
    const c = getCtx()
    if (!c) throw new Error('No active request')
    return c
  }
  const ro = { annotations: { readOnlyHint: true } }
  return [
    tool(
      'list_notes',
      "List the folders and notes inside a folder of the student's notes (folders are Year › Class › …). Pass \"\" for the whole tree. Use it to find related notes, e.g. a Math lecture that covers vectors when helping in Physics.",
      { folder: z.string().describe('Folder path like "2026-2027/Math", or "" for everything') },
      async (a) => {
        ctx().status('Looking through your notes')
        return safe(() => ctx().access.list(a.folder))
      },
      ro,
    ),
    tool(
      'search_notes',
      "Full-text search across all of the student's notes (every year and class). Returns matching notes with a snippet.",
      { query: z.string() },
      async (a) => {
        ctx().status('Searching your notes')
        return safe(() => ctx().access.search(a.query))
      },
      ro,
    ),
    tool(
      'read_note',
      "Read another note by its path (as shown by list_notes/search_notes). Markdown notes return their text. Canvas notes return an image of the whole canvas (so you can read the student's handwriting) plus any typed text on it. If a note and a canvas share a name, add .md or .tldr to the path to pick one.",
      { path: z.string() },
      async (a) => {
        ctx().status('Reading a note')
        const read = await safe(() => ctx().access.read(a.path))
        if (read.isError) return read
        let id: string | null = null
        try {
          id = ctx().access.canvasId(a.path)
        } catch {}
        if (!id) return read
        ctx().status('Looking at another canvas')
        try {
          const v = await ctx().snapshot({ note: id })
          return {
            content: [
              ...(v.image ? [{ type: 'image' as const, data: v.image.data, mimeType: v.image.mediaType }] : []),
              { type: 'text' as const, text: `${v.context}\n\n${read.content[0].text}` },
            ],
          }
        } catch (e) {
          return text(`${read.content[0].text}\n\n(Couldn't get an image of the canvas: ${e instanceof Error ? e.message : e})`)
        }
      },
      ro,
    ),
    tool(
      'read_folder_info',
      "Read a folder's About text and Tutor memory (e.g. another class's). The current note's folders are already in your context.",
      { folder: z.string() },
      async (a) => safe(() => ctx().access.folderInfo(a.folder)),
      ro,
    ),
    tool(
      'remember',
      "Save something to Tutor memory so future sessions know it: lasting facts about the student or the class (recurring mistakes, what they've mastered, the teacher's conventions, upcoming tests). Defaults to the current class's folder. mode 'add' appends a dated line; 'replace' rewrites the whole memory (use it to tidy up or remove outdated lines). Keep entries short; don't save things that only matter for this conversation.",
      {
        text: z.string(),
        folder: z.string().optional().describe('Folder whose memory to update; default: the current class'),
        mode: z.enum(['add', 'replace']).optional(),
      },
      async (a) => {
        ctx().status('Updating tutor memory')
        return safe(() => ctx().access.remember(a.folder, a.text, a.mode ?? 'add'))
      },
    ),
  ]
}

export function markdownTools(getCtx: () => Ctx | null) {
  const ctx = () => {
    const c = getCtx()
    if (!c) throw new Error('No active request')
    return c
  }
  const run = async (status: string, op: MdOp) => {
    ctx().status(status)
    try {
      const r = await ctx().mdOp(op)
      return text(r.message, !r.ok)
    } catch (e) {
      return text(e instanceof Error ? e.message : String(e), true)
    }
  }
  return [
    tool(
      'insert_text',
      'Write new content into the open markdown note (the student watches it being typed). Content is markdown: headings, lists, tables, $inline$ and $$display$$ math. Insert after the paragraph containing the exact text `after`, or at the start/end of the note.',
      {
        markdown: z.string(),
        after: z.string().optional().describe('Exact text from the note; the new content goes after the block containing it'),
        at: z.enum(['start', 'end']).optional().describe('Used when `after` is not given; default end'),
      },
      async (a) => run('Writing in your note', { op: 'insert', markdown: a.markdown, after: a.after, at: a.at }),
    ),
    tool(
      'replace_text',
      "Replace an exact piece of text in the open note (within one paragraph/line) with new text, e.g. fixing a step or a typo. Only edit the student's own writing when they ask you to.",
      { find: z.string().describe('Exact text currently in the note'), replace: z.string() },
      async (a) => run('Editing your note', { op: 'replace', find: a.find, replace: a.replace }),
    ),
    tool(
      'add_comment',
      'Leave a comment in the margin of the open note, attached to an exact piece of its text, like a teacher\'s feedback in Google Docs. Prefer this over editing when giving feedback on the student\'s work.',
      { quote: z.string().describe('Exact text in the note the comment refers to (keep it short)'), text: z.string() },
      async (a) => run('Commenting', { op: 'comment', quote: a.quote, text: a.text }),
    ),
    tool(
      'reply_comment',
      'Reply in an existing comment thread (use the comment id given in the context).',
      { comment_id: z.string(), text: z.string() },
      async (a) => run('Replying to a comment', { op: 'reply', commentId: a.comment_id, text: a.text }),
    ),
  ]
}

export const NOTE_TOOL_STATUS: Record<string, string> = {
  list_notes: 'Looking through your notes',
  search_notes: 'Searching your notes',
  read_note: 'Reading a note',
  read_folder_info: 'Reading class info',
  remember: 'Updating tutor memory',
  insert_text: 'Writing in your note',
  replace_text: 'Editing your note',
  add_comment: 'Commenting',
  reply_comment: 'Replying to a comment',
}
