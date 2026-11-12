// Markdown note: Milkdown Crepe (live preview: headings, lists, tables, KaTeX math, images…)
// bound to a Yjs document that syncs live across devices through the server. A readable
// markdown copy is saved to the note's .md file as you type.
import { useEffect, useRef, useState } from 'react'
import { Crepe } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import { collab, collabServiceCtx } from '@milkdown/plugin-collab'
import { $prose } from '@milkdown/kit/utils'
import { AllSelection, Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { AuthError } from './api'
import { notesApi } from './notesApi'
import { loadNote, rememberNote } from './noteCache'
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core'
import { toggleEmphasisCommand, toggleInlineCodeCommand, toggleStrongCommand } from '@milkdown/kit/preset/commonmark'
import { toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm'
import { toggleLinkCommand } from '@milkdown/kit/component/link-tooltip'
import { addComment, applyMdOp, commentsArray, findText, listComments, refreshCommentMarks, tutorMarks, updateComment, type Comment, type MdOp, type MdOpResult } from './mdOps'
import { CommentsColumn, CommentsSheet, type CommentsProps } from './CommentsPanel'
import { ContextMenu, type MenuItem } from './NotesUI'
import { dialog } from './dialogs'

export type MdApi = { applyOp: (op: MdOp) => Promise<MdOpResult>; comments: () => Comment[] }

const b64 = {
  enc: (u: Uint8Array) => {
    let s = ''
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
    return btoa(s)
  },
  dec: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
}

/** The markdown writer escapes "[[" (it isn't standard markdown); keep wikilinks readable in the .md file. */
const cleanMarkdown = (md: string) => md.replace(/\\\[\\\[([^\]\n]+?)\\?\]\\?\]/g, '[[$1]]')

async function uploadImage(file: File): Promise<string> {
  const r = await fetch('/api/attachments', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type }, body: file })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error ?? 'Upload failed')
  return body.url
}

/** [[Note name]] links: styled and clickable (opens the note with that name). */
function wikiLinks(open: (name: string) => void) {
  const key = new PluginKey('wikilinks')
  const RE = /\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g
  const build = (doc: import('@milkdown/kit/prose/model').Node) => {
    const decos: Decoration[] = []
    doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return
      for (const m of node.text.matchAll(RE)) decos.push(Decoration.inline(pos + m.index!, pos + m.index! + m[0].length, { class: 'wikilink', 'data-target': m[1].trim() }))
    })
    return DecorationSet.create(doc, decos)
  }
  return $prose(
    () =>
      new Plugin({
        key,
        state: { init: (_, s) => build(s.doc), apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old) },
        props: {
          decorations: (s) => key.getState(s),
          handleClick: (_view, _pos, e) => {
            const el = (e.target as HTMLElement).closest('.wikilink') as HTMLElement | null
            if (!el) return false
            open(el.dataset.target ?? '')
            return true
          },
        },
      }),
  )
}

export function MarkdownNote({
  id,
  onText,
  onError,
  onOpenLink,
  apiRef,
  onAskTutor,
  replying,
}: {
  id: string
  onText: (text: string) => void
  onError: (e: unknown) => void
  onOpenLink: (name: string) => void
  /** filled in once the editor is ready, so the tutor can edit and comment */
  apiRef: React.MutableRefObject<MdApi | null>
  /** a new comment or reply: the tutor answers it in the thread */
  onAskTutor: (c: Comment) => void
  /** comment the tutor is answering right now */
  replying: string | null
}) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'offline'>('loading')
  const [saved, setSaved] = useState(true)
  // keep the latest callbacks without rebuilding the editor when they change
  const openLink = useRef(onOpenLink)
  openLink.current = onOpenLink
  const textCb = useRef(onText)
  textCb.current = onText
  const errorCb = useRef(onError)
  errorCb.current = onError
  const ydocRef = useRef<Y.Doc | null>(null)
  const crepeRef = useRef<Crepe | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [activeComment, setActiveComment] = useState<string | null>(null)

  useEffect(() => {
    const root = host.current
    if (!root) return
    let disposed = false
    const clientId = Math.random().toString(36).slice(2)
    const doc = new Y.Doc()
    let crepe: Crepe | null = null
    let es: EventSource | null = null
    let pending: Uint8Array[] = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    let textTimer: ReturnType<typeof setTimeout> | null = null
    let localEdits = false
    let startedFromCache = false

    // ---- outgoing: batch local Yjs updates ----
    const flush = async () => {
      flushTimer = null
      if (!pending.length) return
      const update = Y.mergeUpdates(pending)
      pending = []
      try {
        const r = await fetch(`/api/md/${id}/update`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId, update: b64.enc(update) }),
        })
        if (r.status === 401) throw new AuthError('Not logged in')
        if (!r.ok) throw new Error(`Saving failed (${r.status})`)
        setState('ready')
      } catch (e) {
        pending.unshift(update) // retry later
        setState('offline')
        if (e instanceof AuthError) errorCb.current(e)
        else if (!disposed) flushTimer = setTimeout(flush, 3000)
      }
    }
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return
      localEdits = true
      pending.push(update)
      if (!flushTimer) flushTimer = setTimeout(flush, 120)
    })

    // ---- readable .md copy (only from the device doing the typing) ----
    const saveText = () => {
      textTimer = null
      if (!crepe) return
      notesApi
        .saveText(id, cleanMarkdown(crepe.getMarkdown()))
        .then(() => setSaved(true))
        .catch((e) => errorCb.current(e))
    }

    // ---- incoming: other devices' edits ----
    const resync = async () => {
      const r = await fetch(`/api/md/${id}`, { credentials: 'same-origin' })
      if (r.status === 401) throw new AuthError('Not logged in')
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'Could not open the note')
      return (await r.json()) as { state: string; empty: boolean; text: string }
    }
    const connect = () => {
      es?.close()
      es = new EventSource(`/api/md/${id}/events?clientId=${clientId}`)
      let first = true
      es.addEventListener('hello', () => {
        // reconnected, or we started from a cached copy: catch up with the server
        if (!first || startedFromCache) resync().then((r) => Y.applyUpdate(doc, b64.dec(r.state), 'remote')).catch(() => {})
        first = false
      })
      es.onmessage = (ev) => {
        const m = JSON.parse(ev.data) as { from: string; update: string }
        if (m.from !== clientId) Y.applyUpdate(doc, b64.dec(m.update), 'remote')
      }
    }

    ;(async () => {
      try {
        let { data: r, cached } = await loadNote<{ state: string; empty: boolean; text: string }>('md', id)
        // "never opened" decides whether we fill the note from its .md file: only trust a fresh
        // answer, or the file's text could be inserted twice
        if (r.empty && cached) (r = await resync()), (cached = false)
        startedFromCache = cached
        if (disposed) return
        Y.applyUpdate(doc, b64.dec(r.state), 'remote')
        crepe = new Crepe({
          root,
          defaultValue: '',
          features: { [Crepe.Feature.TopBar]: false, [Crepe.Feature.Toolbar]: false }, // formatting lives in the right-click menu
          featureConfigs: {
            [Crepe.Feature.Placeholder]: { text: 'Start writing… (type / for headings, lists, math, tables)', mode: 'doc' },
            [Crepe.Feature.ImageBlock]: { onUpload: uploadImage, inlineOnUpload: uploadImage, blockOnUpload: uploadImage },
          },
        })
        crepe.editor
          .use(collab)
          .use(wikiLinks((name) => openLink.current(name)))
          .use(tutorMarks(() => listComments(doc), (cid) => setActiveComment(cid)))
        await crepe.create()
        if (disposed) return void crepe.destroy()
        crepe.editor.action((ctx) => {
          const svc = ctx.get(collabServiceCtx)
          svc.bindDoc(doc).setAwareness(new Awareness(doc))
          // first time this note is opened in the editor: start from its .md file
          if (r.empty && r.text.trim()) svc.applyTemplate(r.text)
          svc.connect()
        })
        crepe.on((l) =>
          l.markdownUpdated((_ctx, md) => {
            textCb.current(cleanMarkdown(md))
            if (!localEdits) return
            localEdits = false
            setSaved(false)
            if (textTimer) clearTimeout(textTimer)
            textTimer = setTimeout(saveText, 1200)
          }),
        )
        textCb.current(cleanMarkdown(crepe.getMarkdown()))
        connect()
        ydocRef.current = doc
        crepeRef.current = crepe
        const ed = crepe.editor
        // comments live in the note's Yjs doc, so they sync too
        const syncComments = () => {
          setComments(listComments(doc))
          const v = ed.action((ctx) => ctx.get(editorViewCtx))
          if (!v.isDestroyed) refreshCommentMarks(v)
        }
        commentsArray(doc).observe(syncComments)
        syncComments()
        apiRef.current = {
          applyOp: (op) => applyMdOp(ed, doc, op),
          comments: () => listComments(doc),
        }
        setState('ready')
      } catch (e) {
        errorCb.current(e)
        setState('offline')
      }
    })()

    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        void flush()
        if (textTimer) (clearTimeout(textTimer), saveText())
      } else if (es && es.readyState === EventSource.CLOSED) {
        connect()
        resync()
          .then((r) => Y.applyUpdate(doc, b64.dec(r.state), 'remote'))
          .catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      disposed = true
      if (crepe) rememberNote(id, { state: b64.enc(Y.encodeStateAsUpdate(doc)), empty: false, text: '' })
      apiRef.current = null
      ydocRef.current = null
      crepeRef.current = null
      document.removeEventListener('visibilitychange', onVis)
      if (flushTimer) clearTimeout(flushTimer)
      void flush()
      if (textTimer) (clearTimeout(textTimer), saveText())
      es?.close()
      const c = crepe
      crepe = null
      setTimeout(() => {
        c?.destroy()
        doc.destroy()
      }, 0)
    }
  }, [id])

  const [composing, setComposing] = useState<{ quote: string; from: number } | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; comment: string | null } | null>(null)
  const [touchChip, setTouchChip] = useState<{ x: number; y: number } | null>(null)
  const [anchors, setAnchors] = useState<Record<string, number>>({})
  const [composeTop, setComposeTop] = useState(0)
  const [wide, setWide] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)
  const noteRef = useRef<HTMLDivElement>(null)
  const openCount = comments.filter((c) => !c.resolved).length

  const view = () => {
    const ed = crepeRef.current?.editor
    if (!ed) return null
    const v = ed.action((ctx) => ctx.get(editorViewCtx))
    return v.isDestroyed ? null : v
  }

  // ---- where each comment's text is, so its thread can sit beside it ----
  const measureRef = useRef<() => void>(() => {})
  measureRef.current = () => {
    const v = view()
    const body = bodyRef.current
    if (!v || !body) return
    const top0 = body.getBoundingClientRect().top
    const next: Record<string, number> = {}
    for (const c of comments) {
      const r = findText(v.state.doc, c.quote)
      if (r) next[c.id] = Math.round(v.coordsAtPos(r.from).top - top0)
    }
    setAnchors((old) => (JSON.stringify(next) === JSON.stringify(old) ? old : next))
    if (composing) setComposeTop(Math.round(v.coordsAtPos(Math.min(composing.from, v.state.doc.content.size)).top - top0))
  }
  useEffect(() => {
    let raf = 0
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => measureRef.current())
    }
    schedule()
    const ro = new ResizeObserver(() => {
      schedule()
      setWide((noteRef.current?.clientWidth ?? 1000) >= 760)
    })
    if (host.current) ro.observe(host.current)
    if (noteRef.current) ro.observe(noteRef.current)
    // text moves when anyone (you, the tutor, another device) edits; re-measure regularly and on typing
    const root = host.current
    root?.addEventListener('input', schedule)
    const t = setInterval(schedule, 1000)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      root?.removeEventListener('input', schedule)
      clearInterval(t)
    }
  }, [comments, composing, state])

  // clicking highlighted text on a narrow screen opens the sheet
  useEffect(() => {
    if (activeComment && !wide) setSheetOpen(true)
  }, [activeComment, wide])

  const startComment = () => {
    const v = view()
    if (!v) return
    const { from, to } = v.state.selection
    const quote = v.state.doc.textBetween(from, to, ' ', (leaf) => String(leaf.attrs.value ?? '')).trim()
    if (!quote) return void dialog.alert('Select some text first', 'Highlight the words you want to ask about, then choose Comment.')
    setComposing({ quote, from })
    setActiveComment(null)
    setTouchChip(null)
    if (!wide) setSheetOpen(true)
  }
  const withDoc = (f: (d: Y.Doc) => void) => ydocRef.current && f(ydocRef.current)

  // ---- right-click menu ----
  const onContextMenu = (e: React.MouseEvent) => {
    const v = view()
    const target = e.target as HTMLElement
    if (!v || !target.closest('.ProseMirror') || target.closest('.cm-editor')) return // code/math editors keep their own menu
    e.preventDefault()
    const comment = (target.closest('.comment-mark') as HTMLElement | null)?.dataset.comment ?? null
    const hit = v.posAtCoords({ left: e.clientX, top: e.clientY })
    const sel = v.state.selection
    if (hit && (sel.empty || hit.pos < sel.from || hit.pos > sel.to)) {
      // right-clicked outside the selection: select the word under the pointer (like Google Docs)
      const $p = v.state.doc.resolve(hit.pos)
      if ($p.parent.isTextblock) {
        const text = $p.parent.textBetween(0, $p.parent.content.size, undefined, '￼')
        let a = $p.parentOffset
        let b = a
        const isWord = (ch: string) => /[\p{L}\p{N}_'’-]/u.test(ch)
        while (a > 0 && isWord(text[a - 1])) a--
        while (b < text.length && isWord(text[b])) b++
        const start = $p.start()
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, start + a, start + b)))
      }
    }
    v.focus()
    setMenu({ x: e.clientX, y: e.clientY, comment })
  }
  const selectedText = () => {
    const v = view()
    if (!v) return ''
    const { from, to } = v.state.selection
    return v.state.doc.textBetween(from, to, '\n\n', (leaf) => String(leaf.attrs.value ?? ''))
  }
  const menuItems = (): MenuItem[] => {
    const v = view()
    const has = !!v && !v.state.selection.empty
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'
    const items: MenuItem[] = [{ label: '💬 Comment', run: startComment, disabled: !has }]
    const cid = menu?.comment
    if (cid) items.push({ label: 'Open comment', run: () => setActiveComment(cid) })
    // formatting (replaces the floating toolbar that used to appear over selections)
    const fmt = (label: string, key: unknown, hint?: string): MenuItem => ({
      label,
      hint,
      disabled: !has,
      run: () => {
        view()?.focus()
        crepeRef.current?.editor.action((ctx) => ctx.get(commandsCtx).call(key as never))
      },
    })
    if (has)
      items.push(
        '-',
        fmt('Bold', toggleStrongCommand.key, mod + 'B'),
        fmt('Italic', toggleEmphasisCommand.key, mod + 'I'),
        fmt('Strikethrough', toggleStrikethroughCommand.key),
        fmt('Code', toggleInlineCodeCommand.key),
        fmt('Math', 'ToggleLatex'),
        fmt('Link', toggleLinkCommand.key),
      )
    items.push(
      '-',
      {
        label: 'Cut',
        hint: mod + 'X',
        disabled: !has,
        run: () => {
          void navigator.clipboard.writeText(selectedText())
          const v2 = view()
          v2?.dispatch(v2.state.tr.deleteSelection())
        },
      },
      { label: 'Copy', hint: mod + 'C', disabled: !has, run: () => void navigator.clipboard.writeText(selectedText()) },
      {
        label: 'Paste',
        hint: mod + 'V',
        run: () =>
          void navigator.clipboard
            .readText()
            .then((t) => {
              const v2 = view()
              v2?.focus()
              v2?.pasteText(t)
            })
            .catch(() => dialog.alert("Couldn't paste", `Your browser blocked reading the clipboard. Use ${mod}V instead.`)),
      },
      {
        label: 'Select all',
        hint: mod + 'A',
        run: () => {
          const v2 = view()
          if (!v2) return
          v2.focus()
          v2.dispatch(v2.state.tr.setSelection(new AllSelection(v2.state.doc)))
        },
      },
    )
    return items
  }

  // ---- touch screens (no right-click): a Comment chip appears above the selection ----
  useEffect(() => {
    if (!matchMedia('(pointer: coarse)').matches) return
    const onSel = () => {
      const v = view()
      if (!v || !v.hasFocus() || v.state.selection.empty) return setTouchChip(null)
      const c = v.coordsAtPos(v.state.selection.from)
      setTouchChip({ x: c.left, y: c.top })
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [])

  const commentProps: CommentsProps = {
    comments,
    anchors,
    active: activeComment,
    setActive: setActiveComment,
    composing: composing && { quote: composing.quote, top: composeTop },
    replying,
    onCancelCompose: () => setComposing(null),
    onAdd: (text) =>
      withDoc((d) => {
        const c = addComment(d, { quote: composing!.quote, text, author: 'you' })
        setComposing(null)
        setActiveComment(c.id)
        onAskTutor(c)
      }),
    onReply: (cid, text) =>
      withDoc((d) => {
        let updated: Comment | null = null
        updateComment(d, cid, (c) => (updated = { ...c, replies: [...c.replies, { author: 'you' as const, text, at: new Date().toISOString() }] }))
        if (updated) onAskTutor(updated)
      }),
    onResolve: (cid, resolved) => withDoc((d) => updateComment(d, cid, (c) => ({ ...c, resolved }))),
    onDelete: (cid) => withDoc((d) => updateComment(d, cid, () => null)),
  }

  return (
    <div className={`md-note ${wide ? 'wide' : 'narrow'}`} ref={noteRef}>
      <div className="md-status">
        <span>{state === 'loading' ? 'Opening…' : state === 'offline' ? 'Offline: changes will sync when you reconnect' : saved ? '' : 'Saving…'}</span>
        {!wide && (
          <span className="md-status-actions">
            <button className={`md-comment-btn ${sheetOpen ? 'on' : ''}`} onClick={() => setSheetOpen((o) => !o)} title="Comments">
              {openCount ? `💬 ${openCount}` : '💬'}
            </button>
          </span>
        )}
      </div>
      <div className="md-body" ref={bodyRef}>
        <div className="md-editor" ref={host} onContextMenu={onContextMenu} />
        {wide && <CommentsColumn {...commentProps} />}
      </div>
      {!wide && sheetOpen && <CommentsSheet {...commentProps} onClose={() => (setSheetOpen(false), setActiveComment(null))} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}
      {touchChip && !composing && (
        <button className="md-touch-chip" style={{ left: touchChip.x, top: touchChip.y - 44 }} onPointerDown={(e) => e.preventDefault()} onClick={startComment}>
          💬 Comment
        </button>
      )}
    </div>
  )
}
