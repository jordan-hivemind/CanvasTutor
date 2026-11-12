// Converts handwriting into typed text and typeset math as the student writes, using Claude vision
// on the server. When the pen pauses, the strokes written since the last pause are read and replaced
// by a text shape (words) or a typeset image (math), placed where the ink was. The ink is kept in
// the new shape's meta, so a reading can be corrected (pick another reading, edit it, or go back to
// the ink) at any time, and undo restores the ink too.
import { useEffect, useRef, useState } from 'react'
import { AssetRecordType, b64Vecs, Box, createShapeId, toRichText, useValue, type Editor, type TLDrawShape, type TLShape, type TLShapeId } from 'tldraw'

type P = { x: number; y: number }
export type Option = { kind: 'math' | 'text'; value: string; svg?: string; w?: number; h?: number }
type Read = { kind: 'math' | 'text'; value: string; alternatives: string[]; at: number; fixed?: boolean; box: { x: number; y: number; w: number; h: number } }
type ReadMeta = { read: Read; ink: TLDrawShape[]; label: string }

const PAUSE_MS = 900 // pen up this long = done writing this bit
const JOIN_MS = 3 * 60_000 // writing next to something converted this recently re-reads them together
const STROKE: Record<string, number> = { s: 2, m: 3.5, l: 5, xl: 10 }

export const readOf = (s: TLShape | undefined) => (s?.meta as Partial<ReadMeta> | undefined)?.read ? (s!.meta as unknown as ReadMeta) : null

function strokesOf(s: TLDrawShape): P[][] {
  const sx = s.props.scaleX ?? 1
  const sy = s.props.scaleY ?? 1
  return s.props.segments.map((seg) => (b64Vecs.decodePoints(seg.path, seg.dim) as P[]).map((p) => ({ x: s.x + p.x * sx, y: s.y + p.y * sy })))
}

function boxOf(shapes: TLDrawShape[]): Box {
  const pts = shapes.flatMap(strokesOf).flat()
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return new Box(minX, minY, Math.max(1, Math.max(...xs) - minX), Math.max(1, Math.max(...ys) - minY))
}

/** The ink as a PNG, dark on white, big enough to read. */
function inkImage(shapes: TLDrawShape[]): { data: string; mediaType: 'image/png' } {
  const box = boxOf(shapes)
  const pad = Math.max(12, box.h * 0.2)
  const scale = Math.min(4, 1400 / (box.w + 2 * pad), 700 / (box.h + 2 * pad))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round((box.w + 2 * pad) * scale)
  canvas.height = Math.round((box.h + 2 * pad) * scale)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = ctx.fillStyle = '#111'
  ctx.lineCap = ctx.lineJoin = 'round'
  const at = (p: P) => [(p.x - box.x + pad) * scale, (p.y - box.y + pad) * scale] as const
  for (const s of shapes) {
    ctx.lineWidth = Math.max(2, (STROKE[s.props.size] ?? 3.5) * (s.props.scale ?? 1) * scale)
    for (const st of strokesOf(s)) {
      ctx.beginPath()
      ctx.moveTo(...at(st[0]))
      if (st.length === 1) ctx.lineTo(at(st[0])[0] + 0.1, at(st[0])[1])
      for (const p of st.slice(1)) ctx.lineTo(...at(p))
      ctx.stroke()
    }
  }
  return { data: canvas.toDataURL('image/png').split(',')[1], mediaType: 'image/png' }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`)
  return j as T
}

export const renderLatex = (latex: string) => post<{ svg: string; w: number; h: number }>('/api/render-latex', { latex })

/** Put a reading on the board where its ink was. Returns the new shape's id. */
function place(editor: Editor, opt: Option, alternatives: string[], ink: TLDrawShape[], box: Read['box'], fixed = false): TLShapeId {
  const id = createShapeId()
  const meta: ReadMeta = {
    read: { kind: opt.kind, value: opt.value, alternatives: alternatives.filter((a) => a !== opt.value), at: Date.now(), box, ...(fixed && { fixed }) },
    ink,
    label: `${opt.kind === 'math' ? 'math' : 'text'} (from handwriting): ${opt.value.slice(0, 60)}`,
  }
  if (opt.kind === 'math' && opt.svg && opt.w && opt.h) {
    const s = Math.min(box.h / opt.h, (box.w * 1.4) / opt.w)
    const w = opt.w * s
    const h = opt.h * s
    const assetId = AssetRecordType.createId()
    editor.createAssets([
      {
        id: assetId,
        type: 'image',
        typeName: 'asset',
        props: { name: 'math.svg', src: 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(opt.svg))), w: opt.w, h: opt.h, mimeType: 'image/svg+xml', isAnimated: false },
        meta: {},
      },
    ])
    editor.createShape({ id, type: 'image', x: box.x, y: box.y + (box.h - h) / 2, meta: meta as never, props: { assetId, w, h } })
  } else {
    const lines = opt.value.split('\n').length
    const lineH = 24 * 1.35 // tldraw's "m" text
    const scale = Math.max(0.3, box.h / lines / lineH)
    editor.createShape({
      id,
      type: 'text',
      x: box.x,
      y: box.y + (box.h - lineH * lines * scale) / 2,
      meta: meta as never,
      props: { richText: toRichText(opt.value), color: 'black', size: 'm', font: 'sans', autoSize: true, scale },
    })
  }
  return id
}

/** Replace a converted item with another reading (keeps its ink). */
export async function replaceReading(editor: Editor, id: TLShapeId, kind: 'math' | 'text', value: string): Promise<TLShapeId> {
  const m = readOf(editor.getShape(id))
  if (!m) throw new Error('That item is gone')
  const opt: Option = kind === 'math' ? { kind, value, ...(await renderLatex(value)) } : { kind, value }
  const others = [m.read.value, ...m.read.alternatives]
  let next = id
  editor.markHistoryStoppingPoint('fix reading')
  editor.run(() => {
    editor.deleteShapes([id])
    next = place(editor, opt, others, m.ink, m.read.box, true)
  })
  return next
}

/** Undo a conversion: the original strokes come back. */
export function backToInk(editor: Editor, id: TLShapeId) {
  const m = readOf(editor.getShape(id))
  if (!m) return
  editor.markHistoryStoppingPoint('back to ink')
  editor.run(() => {
    editor.deleteShapes([id])
    editor.createShapes(m.ink)
  })
}

/** Watches the pen and converts what's written after each pause. Calls onConverted with the new item. */
export function useInkConversion(editor: Editor | null, on: boolean, noteId: string, onConverted: (id: TLShapeId | null) => void, onError: (e: unknown) => void) {
  const cb = useRef({ onConverted, onError, noteId })
  cb.current = { onConverted, onError, noteId }
  useEffect(() => {
    if (!editor || !on) return
    post('/api/read-ink', { warm: true }).catch(() => {})
    let pending: TLShapeId[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    let busy = false
    let alive = true
    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void flush(), PAUSE_MS)
    }
    const drawn = (ids: TLShapeId[]) => ids.map((id) => editor.getShape(id)).filter((s): s is TLDrawShape => s?.type === 'draw')
    // how far around a group of ink counts as "written next to it": generous along the line, tight between lines
    const reach = (b: Box) => new Box(b.x - b.h, b.y - b.h * 0.35, b.w + 2 * b.h, b.h * 1.7)

    const flush = async () => {
      if (busy) return schedule()
      const shapes = drawn(pending)
      pending = []
      if (!shapes.length) return
      const box = boxOf(shapes)
      const area = reach(box)
      // finishing something converted a moment ago (limits under a lim, the rest of a line): read it all together
      const near = editor.getCurrentPageShapes().filter((s) => {
        const m = readOf(s)
        const b = editor.getShapePageBounds(s.id)
        return m && b && Date.now() - m.read.at < JOIN_MS && b.collides(area)
      })
      busy = true
      try {
        const { options } = await post<{ options: Option[] }>('/api/read-ink', {
          image: inkImage([...near.flatMap((s) => readOf(s)!.ink), ...shapes]),
          noteId: cb.current.noteId,
          // what the student already corrected stays as they said
          confirmed: near.map((s) => readOf(s)!.read).filter((r) => r.fixed).map((r) => r.value),
        })
        if (!alive) return
        // erased or changed while it was being read: leave it alone
        if (drawn(shapes.map((s) => s.id)).length !== shapes.length || near.some((s) => !editor.getShape(s.id))) return
        // kept writing right next to it while it was being read: read everything together instead
        const more = drawn(pending)
        if (more.length && boxOf(more).collides(area)) {
          pending = [...shapes.map((s) => s.id), ...pending]
          return
        }
        if (!options.length) return // a drawing: stays ink
        const all = Box.Common([box, ...near.map((s) => Box.From(readOf(s)!.read.box))])
        const fresh = shapes.map((s) => editor.getShape<TLDrawShape>(s.id)!)
        let id: TLShapeId | null = null
        editor.markHistoryStoppingPoint('convert handwriting')
        editor.run(() => {
          editor.deleteShapes([...near.map((s) => s.id), ...shapes.map((s) => s.id)])
          id = place(editor, options[0], options.slice(1).map((o) => o.value), [...near.flatMap((s) => readOf(s)!.ink), ...fresh], { x: all.x, y: all.y, w: all.w, h: all.h })
        })
        cb.current.onConverted(id)
      } catch (e) {
        cb.current.onError(e)
      } finally {
        busy = false
        if (pending.length && alive) schedule()
      }
    }

    const onCanvas = (e: PointerEvent) => e.target instanceof Element && !!e.target.closest('.tl-canvas')
    const onDown = (e: PointerEvent) => {
      if (!onCanvas(e)) return
      clearTimeout(timer) // writing again: wait for the next pause
      if (e.pointerType !== 'touch') cb.current.onConverted(null)
    }
    const onUp = () => pending.length && schedule()
    window.addEventListener('pointerdown', onDown, { capture: true })
    window.addEventListener('pointerup', onUp, { capture: true })
    const stop = editor.sideEffects.registerAfterChangeHandler('shape', (prev, next, source) => {
      if (source !== 'user' || next.type !== 'draw') return
      if ((prev as TLDrawShape).props.isComplete || !(next as TLDrawShape).props.isComplete) return
      if ((next.meta as { ai?: string })?.ai) return
      pending.push(next.id)
      schedule()
    })
    return () => {
      alive = false
      stop()
      clearTimeout(timer)
      window.removeEventListener('pointerdown', onDown, { capture: true })
      window.removeEventListener('pointerup', onUp, { capture: true })
    }
  }, [editor, on])
}

/** Correction panel under a converted item: the selected one, or the one just converted. */
export function InkFix({ editor, recent, onRecent, onError }: { editor: Editor; recent: TLShapeId | null; onRecent: (id: TLShapeId | null) => void; onError: (e: unknown) => void }) {
  const selected = useValue(
    'converted selection',
    () => {
      const s = editor.getOnlySelectedShape()
      return s && readOf(s) ? s.id : null
    },
    [editor],
  )
  const id = selected ?? recent
  const shape = useValue('converted shape', () => (id ? editor.getShape(id) : undefined), [editor, id])
  const m = readOf(shape)
  const pos = useValue(
    'converted pos',
    () => {
      const b = id && editor.getShapePageBounds(id)
      if (!b) return null
      const p = editor.pageToViewport({ x: b.minX, y: b.maxY })
      return { x: p.x, y: p.y + 8 }
    },
    [editor, id],
  )
  const [draft, setDraft] = useState('')
  const [kind, setKind] = useState<'math' | 'text'>('math')
  const [editing, setEditing] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    setDraft(m?.read.value ?? '')
    setKind(m?.read.kind ?? 'math')
    setEditing(false)
    setErr('')
  }, [id, m?.read.value, m?.read.kind])
  if (!id || !m || !pos) return null

  const swap = async (k: 'math' | 'text', value: string) => {
    try {
      const next = await replaceReading(editor, id, k, value)
      if (selected) editor.select(next)
      onRecent(selected ? null : next)
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('LaTeX')) setErr(e.message)
      else onError(e)
    }
  }
  const close = () => {
    onRecent(null)
    if (selected) editor.selectNone()
  }

  return (
    <div className="ink-fix" style={{ left: Math.max(8, Math.min(pos.x, window.innerWidth - 340)), top: Math.min(pos.y, window.innerHeight - 200) }} onPointerDown={(e) => e.stopPropagation()}>
      {editing ? (
        <>
          <div className="ink-fix-row">
            <select value={kind} onChange={(e) => setKind(e.target.value as 'math' | 'text')}>
              <option value="math">Math (LaTeX)</option>
              <option value="text">Text</option>
            </select>
            <button className="primary" onClick={() => void swap(kind, draft.trim())} disabled={!draft.trim()}>
              Apply
            </button>
            <button onClick={() => setEditing(false)}>Cancel</button>
          </div>
          <textarea
            value={draft}
            autoFocus
            rows={Math.min(6, draft.split('\n').length + 1)}
            spellCheck={kind === 'text'}
            onChange={(e) => {
              setDraft(e.target.value)
              setErr('')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void swap(kind, draft.trim())
              if (e.key === 'Escape') setEditing(false)
            }}
          />
          {err && <div className="ink-fix-err">{err}</div>}
        </>
      ) : (
        <>
          <code className="ink-fix-value">{m.read.value}</code>
          {m.read.alternatives.length > 0 && (
            <div className="ink-fix-alts">
              <span className="muted small">Or:</span>
              {m.read.alternatives.map((a) => (
                <button key={a} onClick={() => void swap(m.read.kind, a)} title="Use this reading">
                  {a}
                </button>
              ))}
            </div>
          )}
          <div className="ink-fix-row">
            <button onClick={() => setEditing(true)}>✏️ Edit</button>
            <button
              onClick={() => {
                backToInk(editor, id)
                onRecent(null)
              }}
            >
              ↩ Back to ink
            </button>
            <button onClick={close} title="Close">
              ✕
            </button>
          </div>
        </>
      )}
    </div>
  )
}
