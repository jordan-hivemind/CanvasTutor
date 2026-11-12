// What the tutor can do inside an open markdown note: type new content (visibly), replace text,
// and comment. Everything goes through the editor, so it syncs (Yjs) and can be undone.
import type { Editor } from '@milkdown/kit/core'
import { editorViewCtx, parserCtx } from '@milkdown/kit/core'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import * as Y from 'yjs'

export type MdOp =
  | { op: 'insert'; markdown: string; after?: string; at?: 'start' | 'end' }
  | { op: 'replace'; find: string; replace: string }
  | { op: 'comment'; quote: string; text: string }
  | { op: 'reply'; commentId: string; text: string }
export type MdOpResult = { ok: boolean; message: string }

export type Reply = { author: 'you' | 'tutor'; text: string; at: string }
export type Comment = { id: string; quote: string; text: string; author: 'you' | 'tutor'; at: string; resolved: boolean; replies: Reply[] }

// ---------------------------------------------------------------- finding text

/** Text of each textblock with a map from string index → document position. */
function blocks(doc: PMNode) {
  const out: { text: string; map: number[]; pos: number; node: PMNode }[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    let text = ''
    const map: number[] = []
    node.forEach((child, offset) => {
      const start = pos + 1 + offset
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) (text += child.text![i], map.push(start + i))
      } else {
        // inline atoms (math etc.): stand in with their source text so quotes like "$x^2$" still match
        const src = String(child.attrs.value ?? child.textContent ?? '￼')
        for (let i = 0; i < src.length; i++) (text += src[i], map.push(start))
      }
    })
    map.push(pos + node.nodeSize - 1) // end of block
    out.push({ text, map, pos, node })
    return false
  })
  return out
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/** Find a quote (exactly, else ignoring case/extra spaces) and return its document range. */
export function findText(doc: PMNode, needle: string): { from: number; to: number } | null {
  if (!needle.trim()) return null
  // the tutor sees the note as markdown; the document holds rendered text. Try the quote as given,
  // then without markdown escapes (\< \* …), then also without $ math delimiters and ** / __.
  const unescaped = needle.replace(/\\([!-/:-@[-`{-~])/g, '$1')
  const bare = unescaped.replace(/\$+/g, '').replace(/\*\*|__/g, '')
  for (const n of new Set([needle, unescaped, bare])) {
    const r = findOne(doc, n)
    if (r) return r
  }
  return null
}

function findOne(doc: PMNode, needle: string): { from: number; to: number } | null {
  if (!needle.trim()) return null
  const bs = blocks(doc)
  for (const b of bs) {
    const i = b.text.indexOf(needle)
    if (i >= 0) return { from: b.map[i], to: b.map[i + needle.length - 1] + 1 }
  }
  const n = norm(needle)
  for (const b of bs) {
    // normalised search with index mapping back to the original
    let s = ''
    const idx: number[] = []
    for (let i = 0; i < b.text.length; i++) {
      const c = b.text[i]
      if (/\s/.test(c)) {
        if (s && !s.endsWith(' ')) (s += ' ', idx.push(i))
      } else (s += c.toLowerCase(), idx.push(i))
    }
    const j = s.indexOf(n)
    if (j >= 0) {
      const a = idx[j]
      const z = idx[j + n.length - 1]
      return { from: b.map[a], to: b.map[z] + 1 }
    }
  }
  return null
}

// ---------------------------------------------------------------- highlights

const markKey = new PluginKey<{ ai: DecorationSet; comments: DecorationSet }>('tutor-marks')

/**
 * Two kinds of decorations: a fading purple highlight on what the tutor just wrote/changed, and
 * yellow underlines on text that has open comments (clicking one selects that comment).
 */
export function tutorMarks(getComments: () => Comment[], onCommentClick: (id: string) => void) {
  const commentDecos = (doc: PMNode) => {
    const decos: Decoration[] = []
    for (const c of getComments()) {
      if (c.resolved) continue
      const r = findText(doc, c.quote)
      if (r) decos.push(Decoration.inline(r.from, r.to, { class: 'comment-mark', 'data-comment': c.id }))
    }
    return DecorationSet.create(doc, decos)
  }
  return $prose(
    () =>
      new Plugin({
        key: markKey,
        state: {
          init: (_, s) => ({ ai: DecorationSet.empty, comments: commentDecos(s.doc) }),
          apply(tr, old, _o, ns) {
            const meta = tr.getMeta(markKey) as { ai?: { from: number; to: number } | null; refreshComments?: boolean } | undefined
            let ai = old.ai.map(tr.mapping, tr.doc)
            if (meta?.ai === null) ai = DecorationSet.empty
            else if (meta?.ai) ai = DecorationSet.create(tr.doc, [Decoration.inline(meta.ai.from, meta.ai.to, { class: 'ai-mark' })])
            const comments = tr.docChanged || meta?.refreshComments ? commentDecos(ns.doc) : old.comments
            return { ai, comments }
          },
        },
        props: {
          decorations(s) {
            const st = markKey.getState(s)!
            return DecorationSet.create(s.doc, [...st.comments.find(), ...st.ai.find()])
          },
          handleClick(_view, _pos, e) {
            const el = (e.target as HTMLElement).closest('.comment-mark') as HTMLElement | null
            if (el?.dataset.comment) onCommentClick(el.dataset.comment)
            return false
          },
        },
      }),
  )
}

export function refreshCommentMarks(view: EditorView) {
  view.dispatch(view.state.tr.setMeta(markKey, { refreshComments: true }))
}

function flash(view: EditorView, from: number, to: number) {
  view.dispatch(view.state.tr.setMeta(markKey, { ai: { from, to } }))
  setTimeout(() => {
    if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(markKey, { ai: null }))
  }, 4000)
}

// ---------------------------------------------------------------- operations

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const newId = () => 'c' + Math.random().toString(36).slice(2, 10)

export function commentsArray(doc: Y.Doc) {
  return doc.getArray<Comment>('comments')
}
export function listComments(doc: Y.Doc): Comment[] {
  return commentsArray(doc).toArray()
}
export function updateComment(doc: Y.Doc, id: string, change: (c: Comment) => Comment | null) {
  const arr = commentsArray(doc)
  const i = arr.toArray().findIndex((c) => c.id === id)
  if (i < 0) return false
  const next = change(arr.get(i))
  doc.transact(() => {
    arr.delete(i, 1)
    if (next) arr.insert(i, [next])
  })
  return true
}
export function addComment(doc: Y.Doc, c: Omit<Comment, 'id' | 'at' | 'resolved' | 'replies'>): Comment {
  const full: Comment = { ...c, id: newId(), at: new Date().toISOString(), resolved: false, replies: [] }
  commentsArray(doc).push([full])
  return full
}

export async function applyMdOp(editor: Editor, ydoc: Y.Doc, op: MdOp): Promise<MdOpResult> {
  const view = editor.action((ctx) => ctx.get(editorViewCtx))
  if (op.op === 'comment') {
    const r = findText(view.state.doc, op.quote)
    if (!r) return { ok: false, message: `Couldn't find "${op.quote}" in the note. Quote text exactly as it appears.` }
    const c = addComment(ydoc, { quote: op.quote, text: op.text, author: 'tutor' })
    return { ok: true, message: `Comment added (id ${c.id}).` }
  }
  if (op.op === 'reply') {
    const ok = updateComment(ydoc, op.commentId, (c) => ({ ...c, resolved: false, replies: [...c.replies, { author: 'tutor', text: op.text, at: new Date().toISOString() }] }))
    return ok ? { ok: true, message: 'Reply added.' } : { ok: false, message: `No comment with id ${op.commentId}.` }
  }
  if (op.op === 'replace') {
    const r = findText(view.state.doc, op.find)
    if (!r) return { ok: false, message: `Couldn't find "${op.find}" in the note (it must be within one paragraph).` }
    // parse the replacement as markdown so math/bold/links come out formatted
    const parsed = editor.action((ctx) => ctx.get(parserCtx)(op.replace))
    const only = parsed.childCount === 1 ? parsed.firstChild! : null
    const tr = view.state.tr
    if (!op.replace.trim()) tr.delete(r.from, r.to)
    else if (only && only.type.name === 'paragraph') tr.replaceWith(r.from, r.to, only.content)
    else tr.insertText(op.replace, r.from, r.to)
    view.dispatch(tr.scrollIntoView())
    const end = tr.mapping.map(r.to, 1)
    if (end > r.from) flash(view, r.from, end)
    return { ok: true, message: 'Replaced.' }
  }

  // insert: type it out as plain text in a new paragraph, then swap in the formatted markdown
  const doc = view.state.doc
  let at = op.at === 'start' ? 0 : doc.content.size
  if (op.after) {
    const r = findText(doc, op.after)
    if (!r) return { ok: false, message: `Couldn't find "${op.after}" in the note; nothing was inserted.` }
    at = doc.resolve(r.to).after(1)
  }
  const para = view.state.schema.nodes.paragraph.create()
  view.dispatch(view.state.tr.insert(at, para).scrollIntoView())
  const start = at + 1
  let typed = 0
  const text = op.markdown
  // time-based so it takes ~2.5s even when timers are throttled; skipped in a hidden tab
  const t0 = performance.now()
  const DURATION = Math.min(2500, 400 + text.length * 8)
  while (typed < text.length && document.visibilityState === 'visible') {
    if (view.isDestroyed) return { ok: false, message: 'The note was closed while writing.' }
    const target = Math.min(text.length, Math.max(typed + 1, Math.ceil((text.length * (performance.now() - t0)) / DURATION)))
    const chunk = text.slice(typed, target).replace(/\n/g, ' ')
    const pos = start + typed
    const tr = view.state.tr.insertText(chunk, pos)
    tr.setSelection(TextSelection.create(tr.doc, pos + chunk.length))
    view.dispatch(tr.scrollIntoView())
    typed = target
    await sleep(16)
  }
  if (view.isDestroyed) return { ok: false, message: 'The note was closed while writing.' }
  // replace the typed paragraph with the parsed markdown (headings, lists, math…)
  const parsed = editor.action((ctx) => ctx.get(parserCtx)(op.markdown))
  const paraNode = view.state.doc.nodeAt(at)
  const end = at + (paraNode?.nodeSize ?? 2)
  const tr = view.state.tr.replaceWith(at, end, parsed.content)
  view.dispatch(tr.scrollIntoView())
  flash(view, at, at + parsed.content.size)
  return { ok: true, message: 'Written into the note.' }
}
