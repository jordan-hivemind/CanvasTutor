// Lets the student drag the mic and the ask box to wherever suits that device.
// Positions are stored per device (localStorage) as fractions of the screen, so they
// survive rotation and window resizes.
import { useEffect, useRef, useState } from 'react'

export type ControlId = 'mic' | 'ask'
type Spot = { fx: number; fy: number }
type Layout = Partial<Record<ControlId, Spot>>

const KEY = 'canvas-tutor-layout'

function load(): Layout {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function useControlLayout() {
  const [layout, setLayout] = useState<Layout>(load)
  const [, setSize] = useState({ w: innerWidth, h: innerHeight })
  useEffect(() => {
    const f = () => setSize({ w: innerWidth, h: innerHeight })
    addEventListener('resize', f)
    return () => removeEventListener('resize', f)
  }, [])
  const save = (next: Layout) => {
    setLayout(next)
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {}
  }
  return {
    layout,
    place: (id: ControlId, spot: Spot) => save({ ...layout, [id]: spot }),
    reset: () => save({}),
  }
}

/**
 * Wraps a control. Normally it sits at its saved spot (or its default CSS spot);
 * in placing mode it can be dragged and doesn't respond to taps.
 */
export function Placeable({
  id,
  className,
  spot,
  placing,
  onPlace,
  children,
}: {
  id: ControlId
  className: string
  spot: Spot | undefined
  placing: boolean
  onPlace: (id: ControlId, spot: Spot) => void
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ dx: number; dy: number; id: number } | null>(null)
  const [live, setLive] = useState<{ x: number; y: number } | null>(null)

  // the ask box grows with its text; position it by its one-line size so growing doesn't move it
  const baseH = id === 'ask' ? 44 : (ref.current?.offsetHeight ?? 60)
  // keep the control fully on screen
  const clamp = (x: number, y: number) => {
    const el = ref.current
    const w = el?.offsetWidth ?? 60
    const h = baseH
    return { x: Math.max(4, Math.min(innerWidth - w - 4, x)), y: Math.max(4, Math.min(innerHeight - h - 4, y)) }
  }
  const pos = live ?? (spot ? clamp(spot.fx * innerWidth, spot.fy * innerHeight) : null)
  // in the lower half of the screen, anchor by the bottom edge so a growing control (the ask box
  // with several lines) grows upward instead of off the screen
  const style: React.CSSProperties = !pos
    ? {}
    : !live && pos.y > innerHeight / 2
      ? { left: pos.x, bottom: innerHeight - pos.y - baseH, top: 'auto', right: 'auto' }
      : { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }

  return (
    <div
      ref={ref}
      className={`${className}${placing ? ' placing' : ''}`}
      style={style}
      onPointerDownCapture={(e) => {
        if (!placing) return
        e.preventDefault()
        e.stopPropagation()
        const r = ref.current!.getBoundingClientRect()
        drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId }
        try {
          ref.current!.setPointerCapture(e.pointerId)
        } catch {}
        setLive({ x: r.left, y: r.top })
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!placing || !d || d.id !== e.pointerId) return
        setLive(clamp(e.clientX - d.dx, e.clientY - d.dy))
      }}
      onPointerUp={() => {
        if (!placing || !drag.current || !live) return
        drag.current = null
        onPlace(id, { fx: live.x / innerWidth, fy: live.y / innerHeight })
        setLive(null)
      }}
      onClickCapture={(e) => {
        if (placing) {
          e.preventDefault()
          e.stopPropagation()
        }
      }}
    >
      {children}
    </div>
  )
}
