// The notes system: a real folder tree on disk (Year › Class › … › notes).
//   *.md    markdown notes
//   *.tldr  canvas notes (tldraw's file format)
//   .folder.json  per-folder {about, memory}: hidden, edited from the folder menu
// Every note has a stable id in notes-index.json so renames/moves keep its conversation.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join, posix } from 'node:path'

export type NoteKind = 'md' | 'canvas'
export type Exchange = { at: string; question: string; reply: string }
export type NoteEntry = {
  id: string
  path: string // posix, relative to the notes root, e.g. "2026-2027/Math/Lecture 3.md"
  kind: NoteKind
  created: string
  updated: string
  sessionId: string | null
  history: Exchange[]
  /** last app-update version this note's conversation was told about (see changelog.ts) */
  seenVersion?: number
}
type TrashEntry = { id: string; name: string; from: string; at: string; trashPath: string; kind: 'folder' | NoteKind }
type Index = { notes: Record<string, NoteEntry>; trash: TrashEntry[] }

export type TreeNode =
  | { type: 'folder'; name: string; path: string; children: TreeNode[]; hasInfo: boolean }
  | { type: 'note'; id: string; name: string; path: string; kind: NoteKind; updated: string }

export type FolderInfo = { about: string; memory: string }

const EXT: Record<NoteKind, string> = { md: '.md', canvas: '.tldr' }
const kindOf = (file: string): NoteKind | null => (file.endsWith('.md') ? 'md' : file.endsWith('.tldr') ? 'canvas' : null)
const baseName = (p: string) => posix.basename(p).replace(/\.(md|tldr)$/, '')
const newId = () => 'n' + randomBytes(8).toString('hex')

/** A default (date) name like "11-10-26", or "11-10-26 2" for the second one that day: its sort key, else null. */
function dateKey(name: string): number | null {
  const m = name.match(/^(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})(?: (\d+))?$/)
  if (!m) return null
  const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]
  return ((y * 100 + +m[1]) * 100 + +m[2]) * 1000 + (m[4] ? +m[4] : 1)
}

/**
 * Sidebar order: folders first (by name); then notes with their default date name, newest first;
 * then renamed ones by name. Notes come before canvases only when the names are identical.
 */
function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
  const byName = (x: string, y: string) => x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' })
  if (a.type === 'folder' || b.type === 'folder') return byName(a.name, b.name)
  const da = dateKey(a.name)
  const db = dateKey(b.name)
  const c = da !== null && db !== null ? db - da : da !== null ? -1 : db !== null ? 1 : byName(a.name, b.name)
  if (c) return c
  return a.kind === b.kind ? 0 : a.kind === 'md' ? -1 : 1
}

/** Rejects names that could escape the notes root or clash with our hidden files. */
export function cleanName(name: string): string {
  const n = name.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!n || n === '.' || n === '..' || n.startsWith('.')) throw new Error('That name isn’t allowed')
  return n
}
export function cleanPath(p: string): string {
  const parts = p
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.')
  if (parts.some((s) => s === '..' || s.startsWith('.'))) throw new Error('That path isn’t allowed')
  return parts.join('/')
}

export class Notes {
  readonly root: string
  private indexPath: string
  index: Index
  private listeners = new Set<ServerResponse>()
  private saveTimer: NodeJS.Timeout | null = null

  constructor(dataDir: string) {
    this.root = join(dataDir, 'notes')
    this.indexPath = join(dataDir, 'notes-index.json')
    mkdirSync(join(this.root, '.trash'), { recursive: true })
    this.index = existsSync(this.indexPath) ? JSON.parse(readFileSync(this.indexPath, 'utf8')) : { notes: {}, trash: [] }
    this.index.trash ??= []
    this.reconcile()
    setInterval(() => {
      for (const res of this.listeners) if (!res.writableEnded) res.write(': ping\n\n')
    }, 20_000).unref()
  }

  abs(rel: string) {
    return join(this.root, ...rel.split('/').filter(Boolean))
  }

  // ---------- index ----------
  private saveIndex(now = false) {
    const write = () => {
      this.saveTimer = null
      writeFileSync(this.indexPath + '.tmp', JSON.stringify(this.index))
      renameSync(this.indexPath + '.tmp', this.indexPath)
    }
    if (now) {
      if (this.saveTimer) clearTimeout(this.saveTimer)
      return write()
    }
    if (!this.saveTimer) this.saveTimer = setTimeout(write, 500)
  }
  flush() {
    this.saveIndex(true)
  }

  /** Make the index match the files on disk (new files get ids; vanished files are dropped). */
  private reconcile() {
    const seen = new Set<string>()
    const byPath = new Map(Object.values(this.index.notes).map((n) => [n.path, n]))
    const walk = (rel: string) => {
      for (const e of readdirSync(this.abs(rel), { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue
        const child = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) walk(child)
        else {
          const kind = kindOf(e.name)
          if (!kind) continue
          let entry = byPath.get(child)
          if (!entry) {
            const t = statSync(this.abs(child)).mtime.toISOString()
            entry = { id: newId(), path: child, kind, created: t, updated: t, sessionId: null, history: [] }
            this.index.notes[entry.id] = entry
          }
          seen.add(entry.id)
        }
      }
    }
    walk('')
    for (const id of Object.keys(this.index.notes)) if (!seen.has(id)) delete this.index.notes[id]
    this.saveIndex(true)
  }

  note(id: string): NoteEntry {
    const n = this.index.notes[id]
    if (!n) throw new Error('That note no longer exists')
    return n
  }
  touch(id: string) {
    const n = this.index.notes[id]
    if (!n) return
    n.updated = new Date().toISOString()
    this.saveIndex()
  }
  saveNoteMeta() {
    this.saveIndex()
  }

  // ---------- live tree events ----------
  subscribe(res: ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    res.write('event: hello\ndata: {}\n\n')
    this.listeners.add(res)
    res.on('close', () => this.listeners.delete(res))
  }
  private changed(extra: Record<string, unknown> = {}) {
    const msg = `data: ${JSON.stringify({ type: 'tree', ...extra })}\n\n`
    for (const res of this.listeners) if (!res.writableEnded) res.write(msg)
  }

  // ---------- tree ----------
  tree(): TreeNode[] {
    const byPath = new Map(Object.values(this.index.notes).map((n) => [n.path, n]))
    const walk = (rel: string): TreeNode[] => {
      const out: TreeNode[] = []
      for (const e of readdirSync(this.abs(rel), { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue
        const child = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) out.push({ type: 'folder', name: e.name, path: child, children: walk(child), hasInfo: this.hasInfo(child) })
        else {
          const n = byPath.get(child)
          if (n) out.push({ type: 'note', id: n.id, name: baseName(child), path: child, kind: n.kind, updated: n.updated })
        }
      }
      return out.sort(compareNodes)
    }
    return walk('')
  }

  private uniquePath(folder: string, name: string, ext: string): string {
    let candidate = posix.join(folder, name + ext)
    for (let i = 2; existsSync(this.abs(candidate)); i++) candidate = posix.join(folder, `${name} ${i}${ext}`)
    return candidate
  }

  createFolder(parent: string, name: string): string {
    const p = posix.join(cleanPath(parent), cleanName(name))
    if (existsSync(this.abs(p))) throw new Error('A folder with that name already exists')
    mkdirSync(this.abs(p), { recursive: true })
    this.changed()
    return p
  }

  createNote(folder: string, name: string, kind: NoteKind, content?: string): NoteEntry {
    const dir = cleanPath(folder)
    mkdirSync(this.abs(dir), { recursive: true })
    const path = this.uniquePath(dir, cleanName(name), EXT[kind])
    writeFileSync(this.abs(path), kind === 'md' ? (content ?? '') : (content ?? '{"tldrawFileFormatVersion":1,"schema":null,"records":[]}'))
    const now = new Date().toISOString()
    const entry: NoteEntry = { id: newId(), path, kind, created: now, updated: now, sessionId: null, history: [] }
    this.index.notes[entry.id] = entry
    this.saveIndex(true)
    this.changed()
    return entry
  }

  /** Rename or move a note or folder. `to` is the new full path (without extension for notes). */
  private relocate(from: string, toNoExt: string) {
    const src = cleanPath(from)
    if (!existsSync(this.abs(src))) throw new Error('That item no longer exists')
    const isDir = statSync(this.abs(src)).isDirectory()
    const ext = isDir ? '' : (src.match(/\.(md|tldr)$/)?.[0] ?? '')
    const dest = cleanPath(toNoExt) + ext
    if (dest === src) return dest
    if (isDir && (dest + '/').startsWith(src + '/')) throw new Error('Can’t move a folder into itself')
    if (existsSync(this.abs(dest))) throw new Error('Something with that name is already there')
    mkdirSync(this.abs(posix.dirname(dest) || '.'), { recursive: true })
    renameSync(this.abs(src), this.abs(dest))
    for (const n of Object.values(this.index.notes)) {
      if (n.path === src) n.path = dest
      else if (isDir && n.path.startsWith(src + '/')) n.path = dest + n.path.slice(src.length)
    }
    this.saveIndex(true)
    this.changed()
    return dest
  }

  rename(path: string, newName: string) {
    const src = cleanPath(path)
    return this.relocate(src, posix.join(posix.dirname(src) === '.' ? '' : posix.dirname(src), cleanName(newName)))
  }

  move(path: string, toFolder: string) {
    const src = cleanPath(path)
    return this.relocate(src, posix.join(cleanPath(toFolder), posix.basename(src).replace(/\.(md|tldr)$/, '')))
  }

  duplicate(id: string): NoteEntry {
    const n = this.note(id)
    const folder = posix.dirname(n.path) === '.' ? '' : posix.dirname(n.path)
    return this.createNote(folder, `${baseName(n.path)} copy`, n.kind, readFileSync(this.abs(n.path), 'utf8'))
  }

  /** Move to .trash (restorable). */
  trash(path: string): string {
    const src = cleanPath(path)
    if (!src || !existsSync(this.abs(src))) throw new Error('That item no longer exists')
    const isDir = statSync(this.abs(src)).isDirectory()
    const tid = randomBytes(6).toString('hex')
    const trashPath = `.trash/${tid}`
    mkdirSync(this.abs(trashPath), { recursive: true })
    renameSync(this.abs(src), this.abs(`${trashPath}/${posix.basename(src)}`))
    const kind: TrashEntry['kind'] = isDir ? 'folder' : (kindOf(src) ?? 'md')
    this.index.trash.unshift({ id: tid, name: posix.basename(src).replace(/\.(md|tldr)$/, ''), from: src, at: new Date().toISOString(), trashPath, kind })
    // keep index entries (conversation history) but point them into the trash
    for (const n of Object.values(this.index.notes)) {
      if (n.path === src || n.path.startsWith(src + '/')) n.path = `${trashPath}/${posix.basename(src)}${n.path.slice(src.length)}`
    }
    this.saveIndex(true)
    this.changed()
    return tid
  }

  restore(trashId: string): string {
    const t = this.index.trash.find((x) => x.id === trashId)
    if (!t) throw new Error('Not in the trash')
    const inTrash = `${t.trashPath}/${posix.basename(t.from)}`
    let dest = t.from
    const ext = t.kind === 'folder' ? '' : EXT[t.kind]
    const stem = dest.replace(/\.(md|tldr)$/, '')
    for (let i = 2; existsSync(this.abs(dest)); i++) dest = `${stem} (restored${i > 2 ? ' ' + (i - 1) : ''})${ext}`
    mkdirSync(this.abs(posix.dirname(dest) === '.' ? '' : posix.dirname(dest)), { recursive: true })
    renameSync(this.abs(inTrash), this.abs(dest))
    for (const n of Object.values(this.index.notes)) {
      if (n.path === inTrash || n.path.startsWith(inTrash + '/')) n.path = dest + n.path.slice(inTrash.length)
    }
    rmSync(this.abs(t.trashPath), { recursive: true, force: true })
    this.index.trash = this.index.trash.filter((x) => x !== t)
    this.saveIndex(true)
    this.changed()
    return dest
  }

  /** Permanently delete one trash item. */
  purge(trashId: string) {
    const t = this.index.trash.find((x) => x.id === trashId)
    if (!t) return
    rmSync(this.abs(t.trashPath), { recursive: true, force: true })
    for (const [id, n] of Object.entries(this.index.notes)) if (n.path.startsWith(t.trashPath + '/')) delete this.index.notes[id]
    this.index.trash = this.index.trash.filter((x) => x !== t)
    this.saveIndex(true)
    this.changed()
  }

  /** Permanently delete trash older than `days`. Returns how many items were removed. */
  purgeOlderThan(days: number): number {
    const cutoff = Date.now() - days * 24 * 3600 * 1000
    const old = this.index.trash.filter((t) => Date.parse(t.at) < cutoff)
    for (const t of old) this.purge(t.id)
    return old.length
  }

  isTrashed(id: string) {
    return this.index.notes[id]?.path.startsWith('.trash/') ?? true
  }

  // ---------- content ----------
  readText(id: string): string {
    return readFileSync(this.abs(this.note(id).path), 'utf8')
  }
  writeText(id: string, text: string) {
    const n = this.note(id)
    writeFileSync(this.abs(n.path) + '.tmp', text)
    renameSync(this.abs(n.path) + '.tmp', this.abs(n.path))
    this.touch(id)
  }

  // ---------- attachments (images in markdown notes) ----------
  saveAttachment(data: Buffer, ext: string): string {
    const dir = join(this.root, '.attachments')
    mkdirSync(dir, { recursive: true })
    const name = `${randomBytes(10).toString('hex')}.${ext}`
    writeFileSync(join(dir, name), data)
    return name
  }
  attachmentPath(name: string) {
    return join(this.root, '.attachments', name)
  }

  // ---------- folder About / Tutor memory ----------
  private infoPath(folder: string) {
    return this.abs(posix.join(cleanPath(folder), '.folder.json'))
  }
  private hasInfo(folder: string) {
    const i = this.folderInfo(folder)
    return !!(i.about.trim() || i.memory.trim())
  }
  folderInfo(folder: string): FolderInfo {
    try {
      const j = JSON.parse(readFileSync(this.infoPath(folder), 'utf8'))
      return { about: String(j.about ?? ''), memory: String(j.memory ?? '') }
    } catch {
      return { about: '', memory: '' }
    }
  }
  setFolderInfo(folder: string, patch: Partial<FolderInfo>) {
    const f = cleanPath(folder)
    if (!existsSync(this.abs(f)) || !statSync(this.abs(f)).isDirectory()) throw new Error('That folder no longer exists')
    const next = { ...this.folderInfo(f), ...patch }
    writeFileSync(this.infoPath(f), JSON.stringify(next, null, 2))
    this.changed()
    return next
  }

  /** About + memory of every folder from the top of the tree down to the note's folder. */
  inheritedFor(notePath: string): { folder: string; about: string; memory: string }[] {
    const parts = notePath.split('/').slice(0, -1)
    const out: { folder: string; about: string; memory: string }[] = []
    for (let i = 1; i <= parts.length; i++) {
      const folder = parts.slice(0, i).join('/')
      const info = this.folderInfo(folder)
      if (info.about.trim() || info.memory.trim()) out.push({ folder, ...info })
    }
    return out
  }

  // ---------- search ----------
  /** Plain text of a note (markdown as-is; canvases: the text in their shapes). */
  plainText(n: NoteEntry): string {
    try {
      const raw = readFileSync(this.abs(n.path), 'utf8')
      if (n.kind === 'md') return raw
      const doc = JSON.parse(raw)
      const texts: string[] = []
      const walk = (node: unknown) => {
        if (!node || typeof node !== 'object') return
        const o = node as Record<string, unknown>
        if (typeof o.text === 'string') texts.push(o.text)
        for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v)
      }
      for (const r of doc.records ?? [])
        if (r.typeName === 'shape') {
          walk(r.props?.richText)
          // handwriting converted to typeset math (text conversions are already text shapes)
          if (r.type === 'image' && typeof r.meta?.read?.value === 'string') texts.push(r.meta.read.value)
        }
      return texts.join(' ')
    } catch {
      return ''
    }
  }

  search(query: string, limit = 30) {
    const q = query.trim().toLowerCase()
    const words = q.split(/\s+/).filter(Boolean)
    const results: { id: string; name: string; path: string; kind: NoteKind; score: number; snippet: string; updated: string }[] = []
    for (const n of Object.values(this.index.notes)) {
      if (n.path.startsWith('.trash/')) continue
      const name = baseName(n.path)
      const hay = n.path.toLowerCase()
      let score = 0
      if (!words.length) score = 1
      else {
        const nameL = name.toLowerCase()
        if (nameL === q) score += 100
        else if (nameL.startsWith(q)) score += 60
        else if (nameL.includes(q)) score += 40
        if (words.every((w) => hay.includes(w))) score += 25
      }
      let snippet = ''
      if (words.length) {
        const text = this.plainText(n)
        const tl = text.toLowerCase()
        const hits = words.filter((w) => tl.includes(w)).length
        if (hits) {
          score += 10 * hits
          const i = tl.indexOf(words.find((w) => tl.includes(w))!)
          snippet = (i > 40 ? '…' : '') + text.slice(Math.max(0, i - 40), i + 100).replace(/\s+/g, ' ').trim()
        }
      }
      if (score > 0) results.push({ id: n.id, name, path: n.path, kind: n.kind, score, snippet, updated: n.updated })
    }
    results.sort((a, b) => b.score - a.score || b.updated.localeCompare(a.updated))
    return results.slice(0, limit)
  }
}
