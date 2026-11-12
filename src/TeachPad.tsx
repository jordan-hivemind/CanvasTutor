// "Teach my handwriting": write characters so letter matching knows what yours look like.
import { useEffect, useRef, useState } from 'react'
import { addSample, removeSample, useSamples } from './prefs'

const SETS: { label: string; chars: string[] }[] = [
  { label: 'Lowercase', chars: 'abcdefghijklmnopqrstuvwxyz'.split('') },
  { label: 'Digits', chars: '0123456789'.split('') },
  { label: 'Capitals', chars: 'ABDEFGHJKLMNPQRTUY'.split('') },
  { label: 'Math', chars: ['+', '=', '÷', '(', ')', '<', '>', '√', 'π', 'θ', 'Δ', 'Σ', '∫', '∞'] },
]

type Pt = { x: number; y: number }

export function TeachPad({ onClose }: { onClose: () => void }) {
  const samples = useSamples(true)
  const [ch, setCh] = useState('a')
  const [strokes, setStrokes] = useState<Pt[][]>([])
  const [saving, setSaving] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawing = useRef<Pt[] | null>(null)
  const all = SETS.flatMap((s) => s.chars)
  const count = (c: string) => samples.filter((s) => s.ch === c && !s.basis).length

  // redraw
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const x = c.getContext('2d')!
    const r = c.getBoundingClientRect()
    c.width = r.width * devicePixelRatio
    c.height = r.height * devicePixelRatio
    x.scale(devicePixelRatio, devicePixelRatio)
    x.clearRect(0, 0, r.width, r.height)
    // writing guides: x-height and baseline
    x.strokeStyle = '#e3e0f0'
    x.lineWidth = 1
    for (const f of [0.3, 0.55, 0.8]) {
      x.beginPath()
      x.moveTo(0, r.height * f)
      x.lineTo(r.width, r.height * f)
      x.stroke()
    }
    x.strokeStyle = '#1d1d1f'
    x.lineWidth = 3
    x.lineCap = 'round'
    x.lineJoin = 'round'
    for (const st of strokes) {
      x.beginPath()
      st.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)))
      x.stroke()
    }
  }, [strokes])

  const pos = (e: React.PointerEvent): Pt => {
    const r = canvas.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const next = () => {
    const i = all.indexOf(ch)
    setCh(all[(i + 1) % all.length])
    setStrokes([])
  }
  const save = async () => {
    if (!strokes.length) return
    setSaving(true)
    try {
      await addSample(ch, strokes)
      next()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-bg dialog-bg" onClick={onClose}>
      <div className="modal dialog teach" role="dialog" aria-label="Teach my handwriting" onClick={(e) => e.stopPropagation()}>
        <h3>Teach my handwriting</h3>
        <p className="dialog-msg">
          Write <b className="teach-ch">{ch}</b> the way you normally do, then Save. A couple of samples per character helps.
        </p>
        <canvas
          ref={canvas}
          className="teach-pad"
          onPointerDown={(e) => {
            try {
              e.currentTarget.setPointerCapture(e.pointerId)
            } catch {}
            // copies, not drawing.current: React may run these updates after the pen has lifted
            const st = [pos(e)]
            drawing.current = st
            setStrokes((s) => [...s, [...st]])
          }}
          onPointerMove={(e) => {
            const st = drawing.current
            if (!st) return
            st.push(pos(e))
            const copy = [...st]
            setStrokes((s) => [...s.slice(0, -1), copy])
          }}
          onPointerUp={() => (drawing.current = null)}
          onPointerCancel={() => (drawing.current = null)}
        />
        <div className="dialog-actions">
          <button onClick={() => setStrokes([])} disabled={!strokes.length}>
            Clear
          </button>
          <button onClick={next}>Skip</button>
          <button className="primary" onClick={save} disabled={!strokes.length || saving}>
            Save
          </button>
        </div>
        <div className="teach-sets">
          {SETS.map((s) => (
            <div key={s.label}>
              <small>{s.label}</small>
              <div className="teach-chars">
                {s.chars.map((c) => (
                  <button
                    key={c}
                    className={`teach-c ${c === ch ? 'active' : ''} ${count(c) ? 'has' : ''}`}
                    title={count(c) ? `${count(c)} sample${count(c) > 1 ? 's' : ''}` : 'No samples yet'}
                    onClick={() => {
                      setCh(c)
                      setStrokes([])
                    }}
                  >
                    {c}
                    {count(c) > 0 && <sup>{count(c)}</sup>}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        {count(ch) > 0 && (
          <button className="teach-forget" onClick={() => Promise.all(samples.filter((s) => s.ch === ch && !s.basis).map((s) => removeSample(s.id)))}>
            Forget my samples of “{ch}”
          </button>
        )}
        <div className="dialog-actions">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
