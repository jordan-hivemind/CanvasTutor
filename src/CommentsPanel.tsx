// Google-Docs-style comments beside a markdown note. Every comment (and reply) goes to the tutor,
// who answers in the thread. On wide screens threads sit in the margin, lined up with the text
// they're about; on narrow screens they're a sheet you open from the note's toolbar.
import { useLayoutEffect, useRef, useState } from 'react'
import type { Comment } from './mdOps'
import { renderMarkdown } from './markdown'
import { dialog } from './dialogs'

const who = (a: 'you' | 'tutor') => (a === 'tutor' ? '✨ Tutor' : 'You')
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const GAP = 8

export type CommentsProps = {
  comments: Comment[]
  /** where each comment's text sits, in px from the top of the column (missing = text not found) */
  anchors: Record<string, number>
  active: string | null
  setActive: (id: string | null) => void
  composing: { quote: string; top: number } | null
  /** comment the tutor is answering right now */
  replying: string | null
  onCancelCompose: () => void
  onAdd: (text: string) => void
  onReply: (id: string, text: string) => void
  onResolve: (id: string, resolved: boolean) => void
  onDelete: (id: string) => void
}

/** Margin column: threads absolutely positioned next to their text, pushed down when they'd overlap. */
export function CommentsColumn(props: CommentsProps) {
  const [showResolved, setShowResolved] = useState(false)
  const els = useRef(new Map<string, HTMLDivElement>())
  const [tops, setTops] = useState<Record<string, number>>({})
  const [height, setHeight] = useState(0)

  const visible = props.comments.filter((c) => !c.resolved || showResolved)
  const items: { id: string; anchor: number }[] = visible.map((c) => ({ id: c.id, anchor: props.anchors[c.id] ?? Infinity }))
  if (props.composing) items.push({ id: '__new', anchor: props.composing.top })
  items.sort((a, b) => a.anchor - b.anchor)
  const resolvedCount = props.comments.filter((c) => c.resolved).length
  const START = resolvedCount ? 30 : 0

  // after every render: measure the cards and lay them out (only re-renders if something moved)
  useLayoutEffect(() => {
    const h = (id: string) => els.current.get(id)?.offsetHeight ?? 0
    const next: Record<string, number> = {}
    // the active thread sits exactly at its text; the others move out of its way (like Google Docs)
    const pin = items.findIndex((it) => it.id === (props.composing ? '__new' : props.active))
    let y = START
    if (pin >= 0 && Number.isFinite(items[pin].anchor)) {
      const at = Math.max(START, items[pin].anchor)
      next[items[pin].id] = at
      let bottom = at - GAP
      for (let i = pin - 1; i >= 0; i--) {
        const top = Math.min(items[i].anchor, bottom - h(items[i].id))
        next[items[i].id] = top
        bottom = top - GAP
      }
      if (bottom + GAP < START) {
        // not enough room above: fall back to stacking from the top
        for (let i = 0; i <= pin; i++) delete next[items[i].id]
      } else y = at + h(items[pin].id) + GAP
    }
    for (let i = 0; i < items.length; i++) {
      if (items[i].id in next) continue
      const anchor = Number.isFinite(items[i].anchor) ? items[i].anchor : y
      const top = Math.max(anchor, y)
      next[items[i].id] = top
      y = top + h(items[i].id) + GAP
    }
    const bottom = Math.max(0, ...items.map((it) => (next[it.id] ?? 0) + h(it.id)))
    if (JSON.stringify(next) !== JSON.stringify(tops)) setTops(next)
    if (bottom !== height) setHeight(bottom)
  })

  const ref = (id: string) => (el: HTMLDivElement | null) => {
    if (el) els.current.set(id, el)
    else els.current.delete(id)
  }
  return (
    <aside className="comments-column" style={{ minHeight: height + 40 }}>
      {resolvedCount > 0 && (
        <button className="cp-link cp-resolved-toggle" onClick={() => setShowResolved((s) => !s)}>
          {showResolved ? 'Hide' : 'Show'} resolved ({resolvedCount})
        </button>
      )}
      {props.composing && (
        <div ref={ref('__new')} className="cp-slot" style={{ top: tops.__new ?? props.composing.top }}>
          <Composer quote={props.composing.quote} onCancel={props.onCancelCompose} onSave={props.onAdd} />
        </div>
      )}
      {visible.map((c) => (
        <div key={c.id} ref={ref(c.id)} className="cp-slot" style={{ top: tops[c.id] ?? props.anchors[c.id] ?? 0 }}>
          <Thread c={c} {...props} />
        </div>
      ))}
    </aside>
  )
}

/** Narrow screens: a sheet listing the threads. */
export function CommentsSheet(props: CommentsProps & { onClose: () => void }) {
  const [showResolved, setShowResolved] = useState(false)
  const open = props.comments.filter((c) => !c.resolved)
  const resolved = props.comments.filter((c) => c.resolved)
  return (
    <aside className="comments-panel">
      <div className="cp-head">
        <strong>Comments</strong>
        <button className="card-x static" onClick={props.onClose}>
          ×
        </button>
      </div>
      {props.composing && <Composer quote={props.composing.quote} onCancel={props.onCancelCompose} onSave={props.onAdd} />}
      {!open.length && !props.composing && <p className="muted small cp-empty">Select text and choose Comment to ask the tutor about it.</p>}
      {open.map((c) => (
        <Thread key={c.id} c={c} {...props} />
      ))}
      {resolved.length > 0 && (
        <button className="cp-link" onClick={() => setShowResolved((s) => !s)}>
          {showResolved ? 'Hide' : 'Show'} resolved ({resolved.length})
        </button>
      )}
      {showResolved && resolved.map((c) => <Thread key={c.id} c={c} {...props} />)}
    </aside>
  )
}

function Composer({ quote, onCancel, onSave }: { quote: string; onCancel: () => void; onSave: (text: string) => void }) {
  const [text, setText] = useState('')
  const save = () => text.trim() && onSave(text.trim())
  return (
    <div className="cp-thread active">
      <Quote q={quote} />
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save()
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="Ask or tell the tutor about this…"
        rows={3}
      />
      <div className="cp-actions">
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={!text.trim()} onClick={save}>
          Comment
        </button>
      </div>
    </div>
  )
}

function Thread(props: CommentsProps & { c: Comment }) {
  const { c } = props
  const [reply, setReply] = useState('')
  const active = props.active === c.id
  const send = () => {
    if (!reply.trim()) return
    props.onReply(c.id, reply.trim())
    setReply('')
  }
  return (
    <div className={`cp-thread ${active ? 'active' : ''} ${c.resolved ? 'resolved' : ''}`} onClick={() => props.setActive(c.id)}>
      <Quote q={c.quote} />
      <div className="cp-msg">
        <div className="cp-meta">
          <span className={c.author === 'tutor' ? 'cp-tutor' : ''}>{who(c.author)}</span> · {when(c.at)}
        </div>
        <Text md={c.text} />
      </div>
      {c.replies.map((r, i) => (
        <div key={i} className="cp-msg reply">
          <div className="cp-meta">
            <span className={r.author === 'tutor' ? 'cp-tutor' : ''}>{who(r.author)}</span> · {when(r.at)}
          </div>
          <Text md={r.text} />
        </div>
      ))}
      {props.replying === c.id && <div className="cp-typing">✨ Tutor is replying…</div>}
      {active && !c.resolved && (
        <>
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && send()}
            placeholder="Reply…"
            rows={2}
            onClick={(e) => e.stopPropagation()}
          />
          <div className="cp-actions">
            <button onClick={(e) => (e.stopPropagation(), props.onResolve(c.id, true))}>Resolve</button>
            <button className="primary" disabled={!reply.trim()} onClick={(e) => (e.stopPropagation(), send())}>
              Reply
            </button>
          </div>
        </>
      )}
      {active && (
        <div className="cp-actions subtle">
          {c.resolved && <button onClick={(e) => (e.stopPropagation(), props.onResolve(c.id, false))}>Reopen</button>}
          <button
            className="danger"
            onClick={async (e) => {
              e.stopPropagation()
              if (await dialog.confirm('Delete this comment thread?', { ok: 'Delete', danger: true })) props.onDelete(c.id)
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  )
}

const Text = ({ md }: { md: string }) => <div className="cp-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(md) }} />
const Quote = ({ q }: { q: string }) => (
  <div className="cp-quote md" dangerouslySetInnerHTML={{ __html: renderMarkdown(q.length > 160 ? q.slice(0, 160) + '…' : q) }} />
)
