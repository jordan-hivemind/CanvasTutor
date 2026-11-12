// Hold Shift or Ctrl and drag up/down on the board to zoom in/out around where the drag started.
import { useEffect } from 'react'
import type { Editor } from 'tldraw'

const SENSITIVITY = 0.006 // zoom factor per pixel dragged (exponential, so it feels even at any zoom)

export function useShiftZoom(editor: Editor | null) {
  useEffect(() => {
    if (!editor) return
    const container = editor.getContainer()
    let drag: { id: number; startY: number; startZoom: number; origin: { x: number; y: number }; page: { x: number; y: number } } | null = null

    const onCanvas = (t: EventTarget | null) => t instanceof Element && !!t.closest('.tl-canvas')

    const down = (e: PointerEvent) => {
      if (!(e.shiftKey || e.ctrlKey) || !onCanvas(e.target) || e.button !== 0) return
      e.preventDefault()
      e.stopPropagation() // keep tldraw from starting a stroke
      const vsb = editor.getViewportScreenBounds()
      const origin = { x: e.clientX - vsb.x, y: e.clientY - vsb.y }
      drag = { id: e.pointerId, startY: e.clientY, startZoom: editor.getCamera().z, origin, page: editor.screenToPage({ x: e.clientX, y: e.clientY }) }
      container.classList.add('shift-zooming')
    }
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return
      e.preventDefault()
      e.stopPropagation()
      const steps = editor.getCameraOptions().zoomSteps
      const minZ = Math.min(...steps)
      const maxZ = Math.max(...steps)
      const z = Math.min(maxZ, Math.max(minZ, drag.startZoom * Math.exp((drag.startY - e.clientY) * SENSITIVITY)))
      // keep the page point under the drag origin fixed: screen = (page + camera) * z
      editor.setCamera({ x: drag.origin.x / z - drag.page.x, y: drag.origin.y / z - drag.page.y, z })
    }
    const up = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return
      e.preventDefault()
      e.stopPropagation()
      drag = null
      container.classList.remove('shift-zooming')
    }
    const key = (e: KeyboardEvent) => container.classList.toggle('shift-held', e.shiftKey || e.ctrlKey)
    const blur = () => container.classList.remove('shift-held', 'shift-zooming')

    window.addEventListener('pointerdown', down, { capture: true })
    window.addEventListener('pointermove', move, { capture: true })
    window.addEventListener('pointerup', up, { capture: true })
    window.addEventListener('pointercancel', up, { capture: true })
    window.addEventListener('keydown', key, { capture: true })
    window.addEventListener('keyup', key, { capture: true })
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('pointerdown', down, { capture: true })
      window.removeEventListener('pointermove', move, { capture: true })
      window.removeEventListener('pointerup', up, { capture: true })
      window.removeEventListener('pointercancel', up, { capture: true })
      window.removeEventListener('keydown', key, { capture: true })
      window.removeEventListener('keyup', key, { capture: true })
      window.removeEventListener('blur', blur)
    }
  }, [editor])
}
