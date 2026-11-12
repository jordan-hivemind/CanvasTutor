// Client side of the notes tree API.
import { AuthError } from './api'

export type NoteKind = 'md' | 'canvas'
export type TreeNode =
  | { type: 'folder'; name: string; path: string; children: TreeNode[]; hasInfo: boolean }
  | { type: 'note'; id: string; name: string; path: string; kind: NoteKind; updated: string }
export type TrashEntry = { id: string; name: string; from: string; at: string; kind: 'folder' | NoteKind }
export type NoteMeta = { id: string; path: string; kind: NoteKind; updated: string; trashed: boolean; text?: string }
export type SearchResult = { id: string; name: string; path: string; kind: NoteKind; snippet: string; updated: string }
export type FolderInfo = { about: string; memory: string }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
  if (r.status === 401) throw new AuthError('Not logged in')
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`)
  return body as T
}
const post = <T>(path: string, body: unknown) => call<T>(path, { method: 'POST', body: JSON.stringify(body) })

export const notesApi = {
  tree: () => call<{ tree: TreeNode[]; trash: TrashEntry[] }>('/api/tree'),
  note: (id: string) => call<NoteMeta>(`/api/note?id=${encodeURIComponent(id)}`),
  saveText: (id: string, text: string) => call<{ updated: string }>('/api/note/text', { method: 'PUT', body: JSON.stringify({ id, text }) }),
  createNote: (folder: string, name: string, kind: NoteKind) => post<{ id: string; path: string }>('/api/notes', { folder, name, kind }),
  createFolder: (parent: string, name: string) => post<{ path: string }>('/api/folders', { parent, name }),
  rename: (path: string, name: string) => post<{ path: string }>('/api/rename', { path, name }),
  move: (path: string, to: string) => post<{ path: string }>('/api/move', { path, to }),
  duplicate: (id: string) => post<{ id: string; path: string }>('/api/duplicate', { id }),
  trash: (path: string) => post<{ id: string }>('/api/trash', { path }),
  restore: (id: string) => post<{ path: string }>('/api/restore', { id }),
  purge: (id: string) => post('/api/purge', { id }),
  folderInfo: (path: string) => call<FolderInfo>(`/api/folder-info?path=${encodeURIComponent(path)}`),
  setFolderInfo: (path: string, patch: Partial<FolderInfo>) => post<FolderInfo>('/api/folder-info', { path, ...patch }),
  search: (q: string) => call<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q)}`),
}

export const YEAR = /^\d{4}(-\d{4})?$/
export const noteName = (path: string) => (path.split('/').pop() ?? path).replace(/\.(md|tldr)$/, '')
export const folderOf = (path: string) => path.split('/').slice(0, -1).join('/')

export function flatNotes(tree: TreeNode[]): Extract<TreeNode, { type: 'note' }>[] {
  const out: Extract<TreeNode, { type: 'note' }>[] = []
  const walk = (ns: TreeNode[]) => ns.forEach((n) => (n.type === 'note' ? out.push(n) : walk(n.children)))
  walk(tree)
  return out
}
export function flatFolders(tree: TreeNode[]): string[] {
  const out: string[] = []
  const walk = (ns: TreeNode[]) => ns.forEach((n) => n.type === 'folder' && (out.push(n.path), walk(n.children)))
  walk(tree)
  return out
}
