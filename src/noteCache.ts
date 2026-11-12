// Makes opening things feel instant: the server is ~150 ms away, so we fetch notes before they're
// clicked (hover / press / recents) and keep the last copy of everything opened. A cached copy is
// shown right away and then brought up to date (the editors always resync with the server after
// connecting, so a slightly old copy is safe).
import type { FolderInfo } from './notesApi'
import { AuthError } from './api'

type Entry<T> = { at: number; value: Promise<T> }
const docs = new Map<string, Entry<unknown>>()
const folders = new Map<string, Entry<FolderInfo>>()
const FRESH_MS = 15_000

const url = (kind: 'md' | 'canvas', id: string) => (kind === 'md' ? `/api/md/${id}` : `/api/canvas/${id}`)

async function getJson<T>(u: string): Promise<T> {
  const r = await fetch(u, { credentials: 'same-origin' })
  if (r.status === 401) throw new AuthError('Not logged in')
  if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).error ?? `Request failed (${r.status})`), { status: r.status })
  return r.json() as Promise<T>
}

/** Start loading a note in the background (no-op if a recent copy exists). */
export function prefetchNote(kind: 'md' | 'canvas', id: string) {
  const e = docs.get(id)
  if (e && Date.now() - e.at < FRESH_MS) return
  const value = getJson(url(kind, id))
  value.catch(() => docs.get(id)?.value === value && docs.delete(id))
  docs.set(id, { at: Date.now(), value })
}

/** The note's data: a cached copy if there is one (then `cached` is true), otherwise a fresh fetch. */
export async function loadNote<T>(kind: 'md' | 'canvas', id: string): Promise<{ data: T; cached: boolean }> {
  const e = docs.get(id)
  if (e) {
    try {
      return { data: (await e.value) as T, cached: true }
    } catch {
      /* fall through to a fresh fetch */
    }
  }
  const value = getJson<T>(url(kind, id))
  docs.set(id, { at: Date.now(), value })
  return { data: await value, cached: false }
}

/** Remember the latest state of a note when leaving it, so coming back is instant. */
export function rememberNote(id: string, data: unknown) {
  docs.set(id, { at: Date.now(), value: Promise.resolve(data) })
}

export function forgetNote(id: string) {
  docs.delete(id)
}

// ---- folder About / Tutor memory ----

export function prefetchFolder(path: string, force = false) {
  const e = folders.get(path)
  if (!force && e && Date.now() - e.at < FRESH_MS) return
  const value = getJson<FolderInfo>(`/api/folder-info?path=${encodeURIComponent(path)}`)
  value.catch(() => folders.get(path)?.value === value && folders.delete(path))
  folders.set(path, { at: Date.now(), value })
}

/** Cached value right now, if any (for showing instantly). */
export function peekFolder(path: string): Promise<FolderInfo> | null {
  return folders.get(path)?.value ?? null
}

export function setFolderCache(path: string, info: FolderInfo) {
  folders.set(path, { at: Date.now(), value: Promise.resolve(info) })
}
