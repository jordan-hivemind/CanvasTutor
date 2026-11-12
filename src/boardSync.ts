// Live board sync: send this device's record changes to the server, apply other devices' changes
// as they arrive (server-sent events), and fully resync after reconnecting.
import { useEffect } from 'react'
import { getSnapshot, loadSnapshot, type Editor, type TLRecord } from 'tldraw'
import { AuthError } from './api'
import { loadNote, rememberNote } from './noteCache'

type Change = { version: number; from: string; put: TLRecord[]; remove: TLRecord['id'][] }

const FLUSH_MS = 120

async function post(noteId: string, body: unknown) {
  const r = await fetch(`/api/canvas/${noteId}/changes`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (r.status === 401) throw new AuthError('Not logged in')
  if (!r.ok) throw new Error(`Saving the board failed (${r.status})`)
  return (await r.json()) as { version: number }
}

export function useBoardSync(editor: Editor | null, noteId: string | null, onError: (e: unknown) => void) {
  useEffect(() => {
    if (!editor || !noteId) return
    const clientId = Math.random().toString(36).slice(2)
    let disposed = false
    let loaded = false
    const pendingPut = new Map<string, TLRecord>()
    const pendingRemove = new Set<string>()
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    let inflight: Promise<void> | null = null
    let es: EventSource | null = null

    const applyRemote = (put: TLRecord[], remove: TLRecord['id'][]) =>
      editor.store.mergeRemoteChanges(() => {
        if (put.length) editor.store.put(put)
        const existing = remove.filter((id) => editor.store.has(id))
        if (existing.length) editor.store.remove(existing)
      })

    const flush = async () => {
      flushTimer = null
      if (inflight) await inflight
      if (!pendingPut.size && !pendingRemove.size) return
      const put = [...pendingPut.values()]
      const remove = [...pendingRemove]
      pendingPut.clear()
      pendingRemove.clear()
      inflight = post(noteId, { clientId, put, remove })
        .then(() => undefined)
        .catch((e) => {
          // keep the changes (unless newer ones replaced them) and retry shortly
          for (const r of put) if (!pendingPut.has(r.id) && !pendingRemove.has(r.id)) pendingPut.set(r.id, r)
          for (const id of remove) if (!pendingPut.has(id)) pendingRemove.add(id)
          if (e instanceof AuthError) onError(e)
          else if (!disposed) flushTimer = setTimeout(flush, 3000)
        })
        .finally(() => {
          inflight = null
        })
      await inflight
    }
    const scheduleFlush = () => {
      if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS)
    }

    /** Make this device match the server (first load, or after reconnecting). */
    const resync = async () => {
      await flush()
      type Doc = { version: number; document: { store: Record<string, TLRecord>; schema: unknown } | null }
      let b: Doc
      if (!loaded) b = (await loadNote<Doc>('canvas', noteId)).data // cached copy if we have one; the first 'hello' resyncs it
      else {
        const r = await fetch(`/api/canvas/${noteId}`, { credentials: 'same-origin' })
        if (r.status === 401) throw new AuthError('Not logged in')
        b = (await r.json()) as Doc
      }
      if (disposed) return
      if (!loaded) {
        loaded = true
        if (b.document) {
          editor.store.mergeRemoteChanges(() => loadSnapshot(editor.store, { document: b.document as never }))
          // Loading the saved board must not be undoable, or the first Undo wipes the board.
          editor.clearHistory()
          editor.setCurrentTool('draw')
        } else {
          // empty server board: this device's initial state becomes the board
          const doc = getSnapshot(editor.store).document
          await post(noteId, { clientId, put: Object.values(doc.store), remove: [], schema: doc.schema })
        }
        return
      }
      if (!b.document) return
      const server = b.document.store
      const local = editor.store.allRecords().filter((rec) => editor.store.scopedTypes.document.has(rec.typeName))
      applyRemote(
        Object.values(server),
        local.filter((rec) => !(rec.id in server)).map((rec) => rec.id),
      )
    }

    const connect = () => {
      es?.close()
      es = new EventSource(`/api/canvas/${noteId}/events?clientId=${clientId}`)
      let first = true
      es.addEventListener('hello', () => {
        // the very first hello comes right after the initial load; later ones mean we reconnected
        if (first && loaded) resync().catch(onError)
        first = false
      })
      es.onmessage = (ev) => {
        const c = JSON.parse(ev.data) as Change
        if (c.from === clientId || !loaded) return
        applyRemote(c.put, c.remove)
      }
    }

    const unlisten = editor.store.listen(
      ({ changes }) => {
        if (!loaded) return
        for (const r of Object.values(changes.added)) {
          pendingRemove.delete(r.id)
          pendingPut.set(r.id, r)
        }
        for (const [, to] of Object.values(changes.updated)) {
          pendingRemove.delete(to.id)
          pendingPut.set(to.id, to)
        }
        for (const r of Object.values(changes.removed)) {
          pendingPut.delete(r.id)
          pendingRemove.add(r.id)
        }
        scheduleFlush()
      },
      { scope: 'document', source: 'user' },
    )

    if (import.meta.env.DEV)
      (window as unknown as { __sync: unknown }).__sync = {
        clientId,
        get loaded() {
          return loaded
        },
        get disposed() {
          return disposed
        },
        pendingPut,
      }

    resync()
      .then(() => {
        if (!disposed) connect()
      })
      .catch(onError)

    const onVis = () => {
      if (document.visibilityState === 'hidden') void flush()
      // iPad Safari drops the live connection in the background
      else if (loaded && (!es || es.readyState === EventSource.CLOSED)) {
        connect()
        resync().catch(onError)
      }
    }
    const onUnload = () => {
      if (!pendingPut.size && !pendingRemove.size) return
      navigator.sendBeacon?.(`/api/canvas/${noteId}/changes`, new Blob([JSON.stringify({ clientId, put: [...pendingPut.values()], remove: [...pendingRemove] })], { type: 'application/json' }))
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', onUnload)
    return () => {
      disposed = true
      try {
        if (loaded) rememberNote(noteId, { version: 0, document: getSnapshot(editor.store).document })
      } catch {}
      unlisten()
      es?.close()
      if (flushTimer) clearTimeout(flushTimer)
      void flush()
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pagehide', onUnload)
    }
  }, [editor, noteId, onError])
}
