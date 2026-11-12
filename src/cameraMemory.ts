// Each canvas reopens at the zoom and position you left it at (remembered on this device).
import { useEffect } from 'react'
import type { Editor } from 'tldraw'

const KEY = 'ct-cameras'
const MAX = 200 // notes remembered

type Cam = { x: number; y: number; z: number; at: number }

function all(): Record<string, Cam> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function useCameraMemory(editor: Editor | null, noteId: string | null) {
  useEffect(() => {
    if (!editor || !noteId) return
    const saved = all()[noteId]
    if (saved && [saved.x, saved.y, saved.z].every(Number.isFinite)) editor.setCamera({ x: saved.x, y: saved.y, z: saved.z })

    let timer: ReturnType<typeof setTimeout> | null = null
    const save = () => {
      timer = null
      const c = editor.getCamera()
      const cams = all()
      cams[noteId] = { x: c.x, y: c.y, z: c.z, at: Date.now() }
      // keep only the most recent notes
      const ids = Object.keys(cams)
      if (ids.length > MAX) ids.sort((a, b) => cams[a].at - cams[b].at).slice(0, ids.length - MAX).forEach((id) => delete cams[id])
      try {
        localStorage.setItem(KEY, JSON.stringify(cams))
      } catch {}
    }
    // camera moves are session changes in tldraw's store
    const stop = editor.store.listen(
      () => {
        if (!timer) timer = setTimeout(save, 400)
      },
      { scope: 'session' },
    )
    const onHide = () => document.visibilityState === 'hidden' && timer && (clearTimeout(timer), save())
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', save)
    return () => {
      stop()
      if (timer) (clearTimeout(timer), save())
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', save)
    }
  }, [editor, noteId])
}
