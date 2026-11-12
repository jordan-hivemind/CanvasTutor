// tldraw's colour / brush-size panel, tucked away by default. A small tab on the right edge slides
// it out; swipe it to the right (or tap ›) to put it away. Remembered on each device.
import { useRef, useState } from 'react'
import { DefaultStylePanel, type TLUiStylePanelProps } from 'tldraw'

const KEY = 'ct-style-panel-open'

export function CollapsibleStylePanel(props: TLUiStylePanelProps) {
  const [open, setOpenState] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1'
    } catch {
      return false
    }
  })
  const setOpen = (o: boolean) => {
    setOpenState(o)
    try {
      localStorage.setItem(KEY, o ? '1' : '0')
    } catch {}
  }
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null)

  if (!open)
    return (
      <button className="style-tab" title="Colours and brush size" onClick={() => setOpen(true)} onPointerDown={(e) => e.stopPropagation()}>
        ‹
      </button>
    )
  return (
    <div
      className="style-drawer"
      // swipe right to put it away (a mostly-horizontal drag of 40px or more)
      onPointerDownCapture={(e) => (swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId })}
      onPointerUpCapture={(e) => {
        const s = swipe.current
        swipe.current = null
        if (!s || s.id !== e.pointerId) return
        const dx = e.clientX - s.x
        const dy = Math.abs(e.clientY - s.y)
        if (dx > 40 && dx > dy * 1.5) setOpen(false)
      }}
    >
      <button className="style-hide" title="Hide" onClick={() => setOpen(false)}>
        ›
      </button>
      <DefaultStylePanel {...props} />
    </div>
  )
}
