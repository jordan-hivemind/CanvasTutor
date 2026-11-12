// Close a panel when you press anywhere outside it (mouse, finger or pen). A press on the board
// only closes the panel, so it doesn't also draw; a press in the sidebar closes it and still
// does what you pressed.
import { useEffect, useRef } from 'react'

export function useDismiss(ref: React.RefObject<HTMLElement | null>, onClose: () => void, ignoreSelector?: string) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element | null
      if (!t || ref.current?.contains(t)) return
      // dialogs and menus opened from inside the panel, and the panel's own toggle button
      if (t.closest('.dialog-bg, .ctx-bg, .modal-bg')) return
      if (ignoreSelector && t.closest(ignoreSelector)) return
      if (t.closest('.app')) {
        e.preventDefault()
        e.stopPropagation()
      }
      close.current()
    }
    window.addEventListener('pointerdown', down, { capture: true })
    return () => window.removeEventListener('pointerdown', down, { capture: true })
  }, [ref, ignoreSelector])
}
