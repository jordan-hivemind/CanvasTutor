// Apple Pencil mode (a per-device setting, canvases only): only the pencil draws; fingers move the board.
// - one finger drags the board; two fingers pinch-zoom and drag
// - a tap on something the tutor made selects it (in the Select tool, anything); dragging a selected item moves it
// - palm rejection: touches while the pencil is down or hovering, big contact patches, and a touch that's
//   down when the pencil lands are all ignored
// tldraw's own touch handling (one-finger drawing, its pinch) is blocked while this is on, so the two never fight.
import { useEffect } from 'react'
import type { Editor, TLShape, TLShapeId } from 'tldraw'

const MOVE_PX = 10 // a finger has to travel this far before it pans or moves anything (resting hands jitter)
const TAP_MS = 350
const PEN_GRACE_MS = 500 // touches this soon after the pencil was down or hovering are the writing hand
const PALM_PX = 50 // contact patches bigger than this are a palm, not a fingertip
const PINCH_MS = 300 // a second finger landing later than this, next to a finger that's resting still, is a hand, not a pinch
const ZOOM_PX = 24 // fingers must spread or close this much before a two-finger drag starts zooming

type Finger = { x: number; y: number; sx: number; sy: number; t: number }
type Mode =
  | { k: 'pending'; id: number; hit: TLShapeId | null }
  | { k: 'pan'; id: number }
  | { k: 'move'; id: number; ids: TLShapeId[] }
  | { k: 'pinch'; a: number; b: number; dist: number; z: number; page: { x: number; y: number }; zooming: boolean }
  | { k: 'none' }

// the tutor's items, and handwriting converted to text/math (so it can be tapped to correct it)
const isAi = (s: TLShape) => !!(s.meta as { ai?: string; read?: unknown })?.ai || !!(s.meta as { read?: unknown })?.read

export function usePencilMode(editor: Editor | null, on: boolean) {
  useEffect(() => {
    if (!editor || !on) return
    const fingers = new Map<number, Finger>()
    const ignored = new Set<number>()
    let mode: Mode = { k: 'none' }
    let penDown = false
    let penSeen = 0
    // the Select tool we switched to for a finger tap, and the tool to go back to
    let autoSelect: string | null = null

    const onCanvas = (t: EventTarget | null) => t instanceof Element && !!t.closest('.tl-canvas') && !t.closest('.plot3d-grip')
    const vp = (x: number, y: number) => {
      const b = editor.getViewportScreenBounds()
      return { x: x - b.x, y: y - b.y }
    }
    const zoomRange = () => {
      const steps = editor.getCameraOptions().zoomSteps
      return [Math.min(...steps), Math.max(...steps)] as const
    }

    const restoreTool = () => {
      if (!autoSelect) return
      const prev = autoSelect
      autoSelect = null
      editor.selectNone()
      editor.setCurrentTool(prev)
    }

    /** The item a finger tap would pick: the tutor's items, or anything when the Select tool is on. */
    const hitAt = (cx: number, cy: number): TLShapeId | null => {
      const p = editor.screenToPage({ x: cx, y: cy })
      const margin = 10 / editor.getZoomLevel()
      const anything = editor.getCurrentToolId() === 'select' && !autoSelect
      const shapes = editor.getCurrentPageShapesSorted()
      for (let i = shapes.length - 1; i >= 0; i--) {
        const s = shapes[i]
        if (!anything && !isAi(s)) continue
        if (editor.isShapeOrAncestorLocked(s)) continue
        if (editor.isPointInShape(s, p, { hitInside: true, margin })) return s.id
      }
      return null
    }

    const startPinch = () => {
      const [a, b] = [...fingers.keys()]
      const fa = fingers.get(a)!
      const fb = fingers.get(b)!
      const mid = { x: (fa.x + fb.x) / 2, y: (fa.y + fb.y) / 2 }
      mode = { k: 'pinch', a, b, dist: Math.max(1, Math.hypot(fa.x - fb.x, fa.y - fb.y)), z: editor.getZoomLevel(), page: editor.screenToPage(mid), zooming: false }
    }

    /** Stop all finger gestures (the pencil landed, so those touches are the writing hand). */
    const dropFingers = () => {
      for (const id of fingers.keys()) ignored.add(id)
      fingers.clear()
      mode = { k: 'none' }
    }

    const down = (e: PointerEvent) => {
      if (e.pointerType === 'pen') {
        penDown = true
        penSeen = Date.now()
        if (fingers.size) dropFingers()
        // writing again: leave the selection the finger made
        if (autoSelect && onCanvas(e.target)) restoreTool()
        return
      }
      if (e.pointerType !== 'touch' || !onCanvas(e.target)) return
      e.stopPropagation() // tldraw never sees fingers
      e.preventDefault()
      const palm = Math.max(e.width || 0, e.height || 0) > PALM_PX
      if (penDown || Date.now() - penSeen < PEN_GRACE_MS || palm || fingers.size >= 2) {
        ignored.add(e.pointerId)
        return
      }
      if (fingers.size === 1) {
        const [[firstId, first]] = [...fingers]
        const resting = Date.now() - first.t > PINCH_MS && Math.hypot(first.x - first.sx, first.y - first.sy) <= MOVE_PX
        if (resting) {
          // the earlier touch is a hand resting on the screen: this new finger drags on its own
          ignored.add(firstId)
          fingers.delete(firstId)
          mode = { k: 'none' }
        }
      }
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: Date.now() })
      if (fingers.size === 1) mode = { k: 'pending', id: e.pointerId, hit: hitAt(e.clientX, e.clientY) }
      else startPinch()
    }

    const move = (e: PointerEvent) => {
      if (e.pointerType === 'pen') {
        penSeen = Date.now() // includes hovering just above the screen
        return
      }
      if (e.pointerType !== 'touch') return
      if (ignored.has(e.pointerId)) return e.stopPropagation()
      const f = fingers.get(e.pointerId)
      if (!f) return
      e.stopPropagation()
      e.preventDefault()
      const dx = e.clientX - f.x
      const dy = e.clientY - f.y
      f.x = e.clientX
      f.y = e.clientY
      const z = editor.getZoomLevel()

      if (mode.k === 'pending' && Math.hypot(f.x - f.sx, f.y - f.sy) > MOVE_PX) {
        const selected = editor.getSelectedShapeIds()
        if (mode.hit && selected.includes(mode.hit)) {
          editor.markHistoryStoppingPoint('finger move')
          mode = { k: 'move', id: mode.id, ids: selected.filter((id) => !editor.isShapeOrAncestorLocked(id)) }
        } else mode = { k: 'pan', id: mode.id }
        // count the distance already travelled, so nothing jumps
        const tx = f.x - f.sx
        const ty = f.y - f.sy
        if (mode.k === 'pan') {
          const c = editor.getCamera()
          editor.setCamera({ x: c.x + tx / z, y: c.y + ty / z, z: c.z }, { immediate: true })
        } else editor.nudgeShapes(mode.ids, { x: tx / z, y: ty / z })
        return
      }
      if (mode.k === 'pan') {
        const c = editor.getCamera()
        editor.setCamera({ x: c.x + dx / z, y: c.y + dy / z, z: c.z }, { immediate: true })
      } else if (mode.k === 'move') {
        editor.nudgeShapes(mode.ids, { x: dx / z, y: dy / z })
      } else if (mode.k === 'pinch') {
        const fa = fingers.get(mode.a)
        const fb = fingers.get(mode.b)
        if (!fa || !fb) return
        const [minZ, maxZ] = zoomRange()
        const dist = Math.hypot(fa.x - fb.x, fa.y - fb.y)
        // two fingers moving together just drag; zoom only once they clearly spread or close
        if (!mode.zooming && Math.abs(dist - mode.dist) > ZOOM_PX) mode.zooming = true
        const nz = mode.zooming ? Math.min(maxZ, Math.max(minZ, (mode.z * dist) / mode.dist)) : mode.z
        // keep the board point that started between the fingers under the fingers' midpoint
        const mid = vp((fa.x + fb.x) / 2, (fa.y + fb.y) / 2)
        editor.setCamera({ x: mid.x / nz - mode.page.x, y: mid.y / nz - mode.page.y, z: nz }, { immediate: true })
      }
    }

    const up = (e: PointerEvent) => {
      if (e.pointerType === 'pen') {
        penDown = false
        penSeen = Date.now()
        return
      }
      if (e.pointerType !== 'touch') return
      if (ignored.delete(e.pointerId)) return e.stopPropagation()
      const f = fingers.get(e.pointerId)
      if (!f) return
      e.stopPropagation()
      fingers.delete(e.pointerId)
      if (mode.k === 'pending' && e.type === 'pointerup' && Date.now() - f.t < TAP_MS) {
        // a tap: select what's under it, or clear the selection
        if (mode.hit) {
          if (editor.getCurrentToolId() !== 'select') {
            autoSelect = editor.getCurrentToolId()
            editor.setCurrentTool('select')
          }
          editor.select(mode.hit)
        } else if (autoSelect) restoreTool()
        else editor.selectNone()
      }
      // when one finger of a pinch lifts, the other stays put rather than suddenly panning
      if (mode.k === 'pinch') dropFingers()
      if (!fingers.size) mode = { k: 'none' }
    }

    // tldraw pinches from raw touch events; block them on the board so only the code above moves it
    const touch = (e: TouchEvent) => {
      if (onCanvas(e.target)) e.stopPropagation()
      // the browser's own list of fingers on the screen: if none are left, forget any we missed the lift of,
      // so a stale one can't pair with the next finger into a pinch
      if ((e.type === 'touchend' || e.type === 'touchcancel') && ![...e.touches].some((t) => (t as Touch & { touchType?: string }).touchType !== 'stylus')) {
        // a moment later, so the matching pointerup (which may come after this) is still handled normally
        const at = Date.now()
        setTimeout(() => {
          for (const [id, f] of fingers) if (f.t <= at) fingers.delete(id)
          if (!fingers.size) {
            ignored.clear()
            mode = { k: 'none' }
          }
        }, 80)
      }
    }

    const opts = { capture: true, passive: false } as const
    window.addEventListener('pointerdown', down, opts)
    window.addEventListener('pointermove', move, opts)
    window.addEventListener('pointerup', up, opts)
    window.addEventListener('pointercancel', up, opts)
    for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) window.addEventListener(t, touch, opts)
    return () => {
      window.removeEventListener('pointerdown', down, opts)
      window.removeEventListener('pointermove', move, opts)
      window.removeEventListener('pointerup', up, opts)
      window.removeEventListener('pointercancel', up, opts)
      for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) window.removeEventListener(t, touch, opts)
      restoreTool()
    }
  }, [editor, on])
}
