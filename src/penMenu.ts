// Double-tap with the pen tip opens the right-click menu (any canvas). Apple Pencil's own double-tap
// on its flat side isn't visible to web pages, so this is the stand-in.
// A first tap draws a dot (or erases); when a second tap follows, that's undone and the menu opens.
import { useEffect } from 'react'
import type { Editor } from 'tldraw'

const TAP_MS = 350 // a press shorter than this is a tap
const DOUBLE_TAP_MS = 350 // a second tap within this time and distance of the first opens the menu
const DOUBLE_TAP_PX = 10 // tight, so the dots of ":" or "÷" written quickly don't count

const onCanvas = (t: EventTarget | null) => t instanceof Element && !!t.closest('.tl-canvas') && !t.closest('.plot3d-grip')

export function usePenDoubleTapMenu(editor: Editor | null) {
  useEffect(() => {
    if (!editor) return
    const undos = () => (editor as unknown as { history: { getNumUndos(): number } }).history.getNumUndos()
    let press: { x: number; y: number; t: number; undos: number } | null = null // the pen press in progress
    let lastTap: { x: number; y: number; t: number; changed: boolean } | null = null // the previous quick tap
    let swallow: number | null = null // pen pointer whose events tldraw must not see (the second tap)

    const openMenu = (x: number, y: number) => {
      // tldraw only lets the menu open outside the Select tool for a mouse; a pen counts as touch.
      // Treat this one as a mouse, give React a frame to enable the menu, open it, then switch back.
      const wasCoarse = editor.getInstanceState().isCoarsePointer
      if (wasCoarse) editor.updateInstanceState({ isCoarsePointer: false })
      setTimeout(() => {
        const target = document.elementFromPoint(x, y)?.closest('.tl-canvas') ?? editor.getContainer().querySelector('.tl-canvas')
        target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }))
        if (wasCoarse) setTimeout(() => editor.updateInstanceState({ isCoarsePointer: true }), 50)
      }, 30)
    }

    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'pen') return
      if (!onCanvas(e.target)) {
        press = lastTap = null
        return
      }
      if (lastTap && Date.now() - lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DOUBLE_TAP_PX) {
        // second tap: keep it from tldraw, take back the first tap's dot, open the menu
        e.stopPropagation()
        e.preventDefault()
        swallow = e.pointerId
        if (lastTap.changed) editor.undo()
        lastTap = press = null
        openMenu(e.clientX, e.clientY)
        return
      }
      press = { x: e.clientX, y: e.clientY, t: Date.now(), undos: undos() }
    }

    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'pen') return
      if (e.pointerId === swallow) e.stopPropagation()
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > DOUBLE_TAP_PX) press = null // a stroke, not a tap
    }

    const up = (e: PointerEvent) => {
      if (e.pointerType !== 'pen') return
      if (e.pointerId === swallow) {
        e.stopPropagation()
        swallow = null
        return
      }
      const p = press
      press = null
      // remember a quick tap; anything else ends the chance of a double-tap. Runs after tldraw has
      // finished the tap (its pointerup comes first), so the undo count says whether it drew or erased.
      const tap = p && e.type === 'pointerup' && Date.now() - p.t < TAP_MS ? p : null
      lastTap = null
      if (tap) setTimeout(() => (lastTap = { x: tap.x, y: tap.y, t: Date.now(), changed: undos() !== tap.undos }), 0)
    }

    const opts = { capture: true, passive: false } as const
    window.addEventListener('pointerdown', down, opts)
    window.addEventListener('pointermove', move, opts)
    window.addEventListener('pointerup', up, opts)
    window.addEventListener('pointercancel', up, opts)
    return () => {
      window.removeEventListener('pointerdown', down, opts)
      window.removeEventListener('pointermove', move, opts)
      window.removeEventListener('pointerup', up, opts)
      window.removeEventListener('pointercancel', up, opts)
    }
  }, [editor])
}
