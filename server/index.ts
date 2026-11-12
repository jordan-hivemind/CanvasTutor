// HTTP server: auth, the notes tree, canvas live sync, tutor streaming (SSE), voice, and the web app
// (Vite in dev, dist/ in prod).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Auth } from './auth.ts'
import { Canvases } from './board.ts'
import { Assets, ASSET_PREFIX } from './assets.ts'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { CURRENT_VERSION, updateNote } from './changelog.ts'
import { MdDocs } from './mddocs.ts'
import { migrate } from './migrate.ts'
import { Notes, type NoteKind, type TreeNode } from './notes.ts'
import type { MdOpResult, NotesAccess } from './noteTools.ts'
import type { BoardView, ViewBounds } from './tools.ts'
import { synthesize, ttsAvailable, warmTts } from './tts.ts'
import { sttAvailable, transcribe, warmStt } from './stt.ts'
import { handwritingReader } from './reader.ts'
import { hex, renderLatex } from './svg.ts'
import { TutorSession, type AskInput, type Effort, type TutorEvent } from './tutor.ts'

try {
  process.loadEnvFile('.env')
} catch {}

const PROD = process.argv.includes('--prod') || process.env.NODE_ENV === 'production'
const PORT = Number(process.env.PORT ?? 8795)
const HOST = process.env.HOST ?? (PROD ? '127.0.0.1' : '0.0.0.0')
const ROOT = resolve(import.meta.dirname, '..')
const DATA = resolve(process.env.DATA_DIR ?? join(ROOT, 'data'))
const PASSWORD = process.env.TUTOR_PASSWORD ?? ''
if (!PASSWORD) console.warn('⚠ TUTOR_PASSWORD is not set — nobody can log in. Add it to .env')

const notes = new Notes(DATA)
migrate(DATA, notes)

// trash empties itself after 30 days (checked at startup and every 6 hours)
const TRASH_DAYS = 30
const emptyOldTrash = () => {
  try {
    const n = notes.purgeOlderThan(TRASH_DAYS)
    if (n) console.log(`[trash] deleted ${n} item(s) older than ${TRASH_DAYS} days`)
  } catch (e) {
    console.error('[trash] cleanup failed', e)
  }
}
emptyOldTrash()
setInterval(emptyOldTrash, 6 * 3600 * 1000).unref()
const assets = new Assets(join(DATA, 'assets'))
type Prefs = { neaten: boolean; matchLetters: boolean; matchStrength: 'light' | 'medium' | 'strong' | 'full'; convertInk: boolean }
const PREF_DEFAULTS: Prefs = { neaten: false, matchLetters: false, matchStrength: 'medium', convertInk: false }
const PREFS = join(DATA, 'prefs.json')
const readPrefs = (): Prefs => {
  try {
    return { ...PREF_DEFAULTS, ...JSON.parse(readFileSync(PREFS, 'utf8')) }
  } catch {
    return { ...PREF_DEFAULTS }
  }
}
// samples of the student's own handwriting, used to recognise characters for neatening
// `basis`: the clean reference version of the character (what writing is pulled toward); other
// samples are examples of how the student actually writes it, used only for recognising it
type Sample = { id: string; ch: string; strokes: { x: number; y: number }[][]; basis?: boolean }
const HANDWRITING = join(DATA, 'handwriting.json')
const readSamples = (): Sample[] => {
  try {
    return JSON.parse(readFileSync(HANDWRITING, 'utf8')).samples ?? []
  } catch {
    return []
  }
}
const writeSamples = (samples: Sample[]) => writeFileSync(HANDWRITING, JSON.stringify({ samples }))
const canvases = new Canvases(notes, assets)
const mdDocs = new MdDocs(DATA)
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    canvases.saveAll() // don't lose the last second of edits on restart/deploy
    mdDocs.saveAll()
    notes.flush()
    process.exit(0)
  })
const auth = new Auth(DATA, PASSWORD)
const tutors = new Map<string, TutorSession>()
const mdOps = new Map<string, { resolve: (r: MdOpResult) => void; timer: NodeJS.Timeout }>()
const snapshots = new Map<string, { resolve: (v: BoardView) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

/** What the tutor can do with the notes tree while working on one note. */
function notesAccess(noteId: string): NotesAccess {
  const here = () => notes.note(noteId).path
  const live = () => Object.values(notes.index.notes).filter((n) => !n.path.startsWith('.trash/'))
  const icon = (k: string) => (k === 'canvas' ? '🎨' : '📝')
  const find = (path: string) => {
    const p = path.replace(/^\/+/, '').replace(/\.(md|tldr)$/, '')
    // a note and a canvas can share a name: an extension picks one
    const ext = path.match(/\.(md|tldr)$/)?.[0]
    if (ext) {
      const exact = live().find((x) => x.path === p + ext)
      if (exact) return exact
    }
    const n = live().find((x) => x.path.replace(/\.(md|tldr)$/, '') === p) ?? live().find((x) => x.path.replace(/\.(md|tldr)$/, '').toLowerCase().endsWith(p.toLowerCase()))
    if (!n) throw new Error(`No note at "${path}". Use list_notes or search_notes to find the right path.`)
    return n
  }
  /** Default memory folder: the class (Year/Class) the note is in. */
  const classFolder = () => {
    const parts = here().split('/').slice(0, -1)
    return parts.slice(0, Math.min(2, parts.length)).join('/')
  }
  return {
    notePath: here,
    list(folder) {
      const root = folder.replace(/^\/+|\/+$/g, '')
      const lines: string[] = []
      const walk = (nodes: TreeNode[], depth: number) => {
        for (const n of nodes) {
          if (lines.length > 300) return
          if (n.type === 'folder') {
            lines.push(`${'  '.repeat(depth)}📁 ${n.path}/`)
            if (depth < 4) walk(n.children, depth + 1)
          } else lines.push(`${'  '.repeat(depth)}${icon(n.kind)} ${n.path.replace(/\.(md|tldr)$/, '')}`)
        }
      }
      let nodes = notes.tree()
      if (root) {
        for (const seg of root.split('/')) {
          const f = nodes.find((n) => n.type === 'folder' && n.name === seg)
          if (!f || f.type !== 'folder') throw new Error(`No folder "${root}"`)
          nodes = f.children
        }
      }
      walk(nodes, 0)
      return lines.length ? lines.join('\n') : '(empty folder)'
    },
    canvasId(path) {
      const n = find(path)
      return n.kind === 'canvas' ? n.id : null
    },
    read(path) {
      const n = find(path)
      const body = notes.plainText(n)
      return `${n.kind === 'canvas' ? '(canvas note: the text written on it)' : '(markdown note)'} ${n.path}\n\n${body.slice(0, 30000) || '(empty)'}`
    },
    search(query) {
      const r = notes.search(query, 15)
      return r.length ? r.map((x) => `${icon(x.kind)} ${x.path.replace(/\.(md|tldr)$/, '')}${x.snippet ? `\n   …${x.snippet}` : ''}`).join('\n') : 'No matches.'
    },
    folderInfo(path) {
      const i = notes.folderInfo(path)
      return `About:\n${i.about.trim() || '(none)'}\n\nTutor memory:\n${i.memory.trim() || '(none)'}`
    },
    remember(folder, text, mode) {
      const f = (folder ?? classFolder()).replace(/^\/+|\/+$/g, '')
      if (!f) throw new Error('This note is not inside a folder; pass a folder.')
      const old = notes.folderInfo(f).memory.trim()
      const line = `- ${new Date().toISOString().slice(0, 10)}: ${text.trim()}`
      const memory = mode === 'replace' ? text.trim() : old ? `${old}\n${line}` : line
      notes.setFolderInfo(f, { memory })
      return `Saved to the tutor memory of ${f}.`
    },
  }
}

function tutorFor(noteId: string): TutorSession {
  let t = tutors.get(noteId)
  if (!t) {
    const n = notes.note(noteId)
    t = new TutorSession(
      join(DATA, 'claude-work'),
      n.sessionId,
      (id) => {
        const e = notes.index.notes[noteId]
        if (!e) return
        e.sessionId = id || null
        notes.saveNoteMeta()
      },
      n.kind,
      notesAccess(noteId),
    )
    tutors.set(noteId, t)
  }
  return t
}

/** Where the note lives + the About/memory of every folder above it, for the tutor. */
function noteContext(noteId: string): string {
  const n = notes.note(noteId)
  const parts = n.path.replace(/\.(md|tldr)$/, '').split('/')
  const name = parts.pop()!
  const where = [parts[0] && `school year "${parts[0]}"`, parts[1] && `class "${parts[1]}"`, parts.length > 2 && `subfolder "${parts.slice(2).join('/')}"`].filter(Boolean)
  const lines = [
    `[Note] "${name}" (${n.kind === 'canvas' ? 'canvas note' : 'markdown note'}), full path "${parts.concat(name).join('/')}"${where.length ? `: ${where.join(', ')}` : ', at the top level'}.`,
  ]
  // folder-level context, outermost first; each block says which folder (and level) it comes from
  const level = (folder: string) => {
    const d = folder.split('/').length
    return d === 1 ? 'school year' : d === 2 ? 'class' : 'subfolder'
  }
  for (const f of notes.inheritedFor(n.path)) {
    const src = `${level(f.folder)} folder "${f.folder}"`
    if (f.about.trim()) lines.push(`[About, from the ${src}; applies to everything inside it]\n${f.about.trim()}`)
    if (f.memory.trim()) lines.push(`[Tutor memory, from the ${src}]\n${f.memory.trim()}`)
  }
  return lines.join('\n\n')
}

function parseView(v: unknown): ViewBounds | null {
  const o = v as Record<string, unknown> | null
  if (!o || ![o.minX, o.minY, o.maxX, o.maxY].every((n) => typeof n === 'number' && isFinite(n))) return null
  return { minX: o.minX as number, minY: o.minY as number, maxX: o.maxX as number, maxY: o.maxY as number }
}

const MODELS = new Set(['opus', 'sonnet', 'haiku'])
const EFFORTS = new Set<Effort>(['low', 'medium', 'high', 'xhigh', 'max'])

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

const gzipAsync = promisify(gzip)
/** JSON, gzipped when it's big (canvases are mostly pen strokes, which shrink ~5×). */
async function bigJson(req: IncomingMessage, res: ServerResponse, body: unknown) {
  const text = JSON.stringify(body)
  if (text.length < 32_000 || !/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) return json(res, 200, body)
  const gz = await gzipAsync(text, { level: 5 })
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' })
  res.end(gz)
}

async function readBody(req: IncomingMessage, limit = 20 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new Error('Body too large')
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}
const body = async (req: IncomingMessage, limit?: number) => JSON.parse((await readBody(req, limit)) || '{}')

const isSecure = (req: IncomingMessage) => req.headers['x-forwarded-proto'] === 'https'

async function api(req: IncomingMessage, res: ServerResponse, path: string) {
  if (path === '/api/login' && req.method === 'POST') {
    const { password } = await body(req, 10_000)
    const r = auth.tryLogin(req, res, String(password ?? ''), isSecure(req))
    return r === 'ok' ? json(res, 200, { ok: true }) : json(res, r === 'limited' ? 429 : 401, { error: r === 'limited' ? 'Too many attempts. Wait a few minutes.' : 'Wrong password' })
  }
  if (!auth.isAuthed(req)) return json(res, 401, { error: 'Not logged in' })

  if (path === '/api/me') return json(res, 200, { ok: true })
  if (path === '/api/logout' && req.method === 'POST') {
    auth.logout(res)
    return json(res, 200, { ok: true })
  }
  const url = new URL(req.url ?? '/', 'http://x')
  const q = (k: string) => url.searchParams.get(k) ?? ''

  // ---------- notes tree ----------
  if (path === '/api/tree' && req.method === 'GET') return json(res, 200, { tree: notes.tree(), trash: notes.index.trash })
  if (path === '/api/events' && req.method === 'GET') return notes.subscribe(res)
  if (path === '/api/notes' && req.method === 'POST') {
    const b = await body(req)
    const kind: NoteKind = b.kind === 'canvas' ? 'canvas' : 'md'
    const e = notes.createNote(String(b.folder ?? ''), String(b.name || (kind === 'canvas' ? 'Untitled canvas' : 'Untitled')), kind)
    return json(res, 200, { id: e.id, path: e.path })
  }
  if (path === '/api/folders' && req.method === 'POST') {
    const b = await body(req)
    return json(res, 200, { path: notes.createFolder(String(b.parent ?? ''), String(b.name ?? '')) })
  }
  if (path === '/api/rename' && req.method === 'POST') {
    const b = await body(req)
    return json(res, 200, { path: notes.rename(String(b.path ?? ''), String(b.name ?? '')) })
  }
  if (path === '/api/move' && req.method === 'POST') {
    const b = await body(req)
    return json(res, 200, { path: notes.move(String(b.path ?? ''), String(b.to ?? '')) })
  }
  if (path === '/api/duplicate' && req.method === 'POST') {
    const b = await body(req)
    canvases.forget(String(b.id)) // make sure the file on disk is current before copying
    const e = notes.duplicate(String(b.id))
    return json(res, 200, { id: e.id, path: e.path })
  }
  if (path === '/api/trash' && req.method === 'POST') {
    const b = await body(req)
    return json(res, 200, { id: notes.trash(String(b.path ?? '')) })
  }
  if (path === '/api/restore' && req.method === 'POST') {
    const b = await body(req)
    return json(res, 200, { path: notes.restore(String(b.id ?? '')) })
  }
  if (path === '/api/purge' && req.method === 'POST') {
    const b = await body(req)
    notes.purge(String(b.id ?? ''))
    return json(res, 200, { ok: true })
  }
  if (path === '/api/note' && req.method === 'GET') {
    const n = notes.note(q('id'))
    return json(res, 200, { id: n.id, path: n.path, kind: n.kind, updated: n.updated, trashed: notes.isTrashed(n.id), text: n.kind === 'md' ? notes.readText(n.id) : undefined })
  }
  if (path === '/api/note/text' && req.method === 'PUT') {
    const b = await body(req)
    const n = notes.note(String(b.id))
    if (n.kind !== 'md') return json(res, 400, { error: 'Not a markdown note' })
    notes.writeText(n.id, String(b.text ?? ''))
    return json(res, 200, { ok: true, updated: notes.note(n.id).updated })
  }
  if (path === '/api/folder-info' && req.method === 'GET') return json(res, 200, notes.folderInfo(q('path')))
  if (path === '/api/folder-info' && req.method === 'POST') {
    const b = await body(req)
    const patch: { about?: string; memory?: string } = {}
    if (typeof b.about === 'string') patch.about = b.about.slice(0, 20000)
    if (typeof b.memory === 'string') patch.memory = b.memory.slice(0, 40000)
    return json(res, 200, notes.setFolderInfo(String(b.path ?? ''), patch))
  }
  if (path === '/api/search' && req.method === 'GET') return json(res, 200, { results: notes.search(q('q')) })

  // ---------- settings that apply on every device ----------
  if (path === '/api/prefs' && req.method === 'GET') return json(res, 200, readPrefs())
  if (path === '/api/prefs' && req.method === 'POST') {
    const b = await body(req, 10_000)
    const next = { ...readPrefs() }
    if (typeof b.neaten === 'boolean') next.neaten = b.neaten
    if (typeof b.matchLetters === 'boolean') next.matchLetters = b.matchLetters
    if (typeof b.convertInk === 'boolean') next.convertInk = b.convertInk
    if (['light', 'medium', 'strong', 'full'].includes(b.matchStrength)) next.matchStrength = b.matchStrength
    writeFileSync(PREFS, JSON.stringify(next, null, 2))
    return json(res, 200, next)
  }

  if (path === '/api/handwriting' && req.method === 'GET') return json(res, 200, { samples: readSamples() })
  if (path === '/api/handwriting' && req.method === 'POST') {
    const b = await body(req, 2_000_000)
    let samples = readSamples()
    if (typeof b.remove === 'string') samples = samples.filter((s) => s.id !== b.remove)
    if (b.add && typeof b.add.ch === 'string' && Array.isArray(b.add.strokes)) {
      const strokes = (b.add.strokes as unknown[][])
        .slice(0, 8)
        .map((st) => st.slice(0, 2000).map((p) => ({ x: Math.round(Number((p as { x: number }).x) * 10) / 10, y: Math.round(Number((p as { y: number }).y) * 10) / 10 })))
        .filter((st) => st.length && st.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)))
      if (strokes.length) samples.push({ id: randomUUID(), ch: String(b.add.ch).slice(0, 4), strokes, ...(b.add.basis === true ? { basis: true } : {}) })
    }
    writeSamples(samples)
    return json(res, 200, { samples })
  }
  // a crash in the app on some device: goes to the server log (journalctl -u canvas-tutor | grep client-error)
  if (path === '/api/client-error' && req.method === 'POST') {
    const b = await body(req, 20_000)
    console.error('[client-error]', JSON.stringify({ message: String(b.message ?? '').slice(0, 500), url: String(b.url ?? '').slice(0, 200), ua: String(b.ua ?? '').slice(0, 300), stack: String(b.stack ?? '').slice(0, 4000), where: String(b.where ?? '').slice(0, 2000) }))
    return json(res, 200, { ok: true })
  }
  // every character letter matching looked at and what it decided, for reviewing mistakes later
  if (path === '/api/handwriting-log' && req.method === 'POST') {
    const b = await body(req, 500_000)
    const file = join(DATA, 'handwriting-log.jsonl')
    let size = 0
    try {
      size = statSync(file).size
    } catch {}
    if (size < 50_000_000) appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...b }) + '\n')
    return json(res, 200, { ok: true })
  }

  // ---------- canvas images ----------
  if (path === '/api/assets' && req.method === 'POST') {
    const type = String(req.headers['content-type'] ?? '')
    if (!type.startsWith('image/')) return json(res, 400, { error: 'Not an image' })
    const chunks: Buffer[] = []
    let size = 0
    for await (const c of req) {
      size += (c as Buffer).length
      if (size > 40 * 1024 * 1024) return json(res, 413, { error: 'Image too large' })
      chunks.push(c as Buffer)
    }
    return json(res, 200, { src: assets.save(Buffer.concat(chunks), type) })
  }
  if (path.startsWith(ASSET_PREFIX) && req.method === 'GET') {
    if (!assets.serve(path.slice(ASSET_PREFIX.length), res)) json(res, 404, { error: 'Not found' })
    return
  }

  // ---------- canvas live sync ----------
  const cm = path.match(/^\/api\/canvas\/([\w-]+)(\/changes|\/events)?$/)
  if (cm) {
    const doc = canvases.get(cm[1])
    if (!cm[2] && req.method === 'GET') return bigJson(req, res, doc.snapshot())
    if (cm[2] === '/changes' && req.method === 'POST') {
      const b = await body(req, 100 * 1024 * 1024)
      const put = Array.isArray(b.put) ? b.put : []
      const remove = Array.isArray(b.remove) ? b.remove.map(String) : []
      return json(res, 200, { version: doc.apply(String(b.clientId ?? ''), put, remove, b.schema) })
    }
    if (cm[2] === '/events' && req.method === 'GET') return doc.subscribe(res, q('clientId'))
  }

  // ---------- markdown live sync (Yjs) ----------
  const mm = path.match(/^\/api\/md\/([\w-]+)(\/update|\/events)?$/)
  if (mm) {
    const n = notes.note(mm[1])
    if (n.kind !== 'md') return json(res, 400, { error: 'Not a markdown note' })
    const doc = mdDocs.get(n.id)
    if (!mm[2] && req.method === 'GET') return json(res, 200, { state: Buffer.from(doc.state()).toString('base64'), empty: doc.isEmpty, text: notes.readText(n.id) })
    if (mm[2] === '/update' && req.method === 'POST') {
      const b = await body(req, 20 * 1024 * 1024)
      doc.apply(String(b.clientId ?? ''), new Uint8Array(Buffer.from(String(b.update ?? ''), 'base64')))
      notes.touch(n.id)
      return json(res, 200, { ok: true })
    }
    if (mm[2] === '/events' && req.method === 'GET') return doc.subscribe(res, q('clientId'))
  }

  // ---------- images pasted into markdown notes ----------
  if (path === '/api/attachments' && req.method === 'POST') {
    const type = String(req.headers['content-type'] ?? '')
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' }[type.split(';')[0]]
    if (!ext) return json(res, 415, { error: 'Only images can be attached' })
    const chunks: Buffer[] = []
    let size = 0
    for await (const c of req) {
      size += c.length
      if (size > 15 * 1024 * 1024) return json(res, 413, { error: 'Image too large (max 15 MB)' })
      chunks.push(c)
    }
    return json(res, 200, { url: `/api/attachments/${notes.saveAttachment(Buffer.concat(chunks), ext)}` })
  }
  const am = path.match(/^\/api\/attachments\/([\w-]+\.(png|jpg|gif|webp|svg))$/)
  if (am && req.method === 'GET') {
    const file = notes.attachmentPath(am[1])
    if (!existsSync(file)) return json(res, 404, { error: 'Not found' })
    res.writeHead(200, { 'Content-Type': MIME[`.${am[2]}`] ?? `image/${am[2] === 'jpg' ? 'jpeg' : am[2]}`, 'Cache-Control': 'private, max-age=31536000, immutable' })
    return res.end(readFileSync(file))
  }

  // ---------- tutor ----------
  if (path === '/api/history' && req.method === 'GET') return json(res, 200, { history: notes.index.notes[q('note')]?.history ?? [] })
  if (path === '/api/reset' && req.method === 'POST') {
    const { noteId } = await body(req, 10_000)
    tutors.get(noteId)?.reset()
    tutors.delete(noteId)
    const n = notes.index.notes[noteId]
    if (n) n.sessionId = null
    notes.saveNoteMeta()
    return json(res, 200, { ok: true })
  }
  // ---------- converting handwriting to text and typeset math ----------
  if (path === '/api/read-ink' && req.method === 'POST') {
    const b = await body(req, 8_000_000)
    if (b.warm) {
      handwritingReader(join(DATA, 'claude-work')).warm()
      return json(res, 200, { ok: true })
    }
    if (typeof b.image?.data !== 'string') return json(res, 400, { error: 'Missing image' })
    const n = notes.index.notes[String(b.noteId ?? '')]
    const confirmed = Array.isArray(b.confirmed) ? b.confirmed.filter((c: unknown) => typeof c === 'string').slice(0, 5) : []
    const hint = [
      n && `this is from the notes "${n.path.replace(/\.(md|tldr)$/, '')}".`,
      ...confirmed.map((c: string) => `Part of this ink was already confirmed by the student to read: ${c} — keep that part exactly as written there.`),
    ]
      .filter(Boolean)
      .join(' ')
    const r = await handwritingReader(join(DATA, 'claude-work')).read({ data: b.image.data, mediaType: String(b.image.mediaType ?? 'image/png') }, hint)
    if (r.kind === 'drawing') return json(res, 200, { options: [] })
    // every reading, typeset; LaTeX that doesn't render is dropped
    const options = [r.value, ...r.alternatives].flatMap((value) => {
      if (r.kind === 'text') return [{ kind: 'text', value }]
      try {
        return [{ kind: 'math', value, ...renderLatex(value, hex('black')) }]
      } catch {
        return []
      }
    })
    return json(res, 200, { options })
  }
  if (path === '/api/render-latex' && req.method === 'POST') {
    const b = await body(req, 50_000)
    try {
      return json(res, 200, renderLatex(String(b.latex ?? ''), hex('black')))
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) })
    }
  }
  if (path === '/api/capabilities') return json(res, 200, { tts: ttsAvailable, stt: sttAvailable })
  if (path === '/api/stt' && req.method === 'POST') {
    if (!sttAvailable) return json(res, 503, { error: 'Speech recognition is not set up on this server' })
    const chunks: Buffer[] = []
    let size = 0
    for await (const c of req) {
      size += c.length
      if (size > 25 * 1024 * 1024) return json(res, 413, { error: 'Recording too long' })
      chunks.push(c)
    }
    const text = await transcribe(Buffer.concat(chunks), String(req.headers['content-type'] ?? ''), join(DATA, 'tmp'))
    return json(res, 200, { text })
  }
  if (path === '/api/tts' && req.method === 'POST') {
    const b = await body(req, 20_000)
    if (!ttsAvailable) return json(res, 503, { error: 'Kokoro is not set up on this server' })
    const wav = await synthesize(String(b.text ?? '').slice(0, 1200), String(b.voice ?? 'af_heart'), Number(b.speed ?? 1))
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'Content-Length': wav.length })
    return res.end(wav)
  }
  if (path === '/api/warm' && req.method === 'POST') {
    const b = await body(req, 10_000)
    if (b.noteId && notes.index.notes[b.noteId]) tutorFor(String(b.noteId)).warm(MODELS.has(b.model) ? b.model : 'opus', EFFORTS.has(b.effort) ? b.effort : 'medium')
    return json(res, 200, { ok: true })
  }
  if (path === '/api/cancel' && req.method === 'POST') {
    const { noteId } = await body(req, 10_000)
    await tutors.get(noteId)?.interrupt()
    return json(res, 200, { ok: true })
  }

  if (path === '/api/op-result' && req.method === 'POST') {
    const b = await body(req)
    const p = mdOps.get(String(b.id))
    if (!p) return json(res, 404, { error: 'No pending edit' })
    mdOps.delete(String(b.id))
    clearTimeout(p.timer)
    p.resolve({ ok: !!b.ok, message: String(b.message ?? (b.ok ? 'Done.' : 'Failed.')) })
    return json(res, 200, { ok: true })
  }

  if (path === '/api/snapshot' && req.method === 'POST') {
    const b = await body(req)
    const p = snapshots.get(String(b.id))
    if (!p) return json(res, 404, { error: 'No pending snapshot' })
    snapshots.delete(String(b.id))
    clearTimeout(p.timer)
    if (b.error || !b.image?.data) p.reject(new Error(String(b.error ?? (b.context || 'No image'))))
    else p.resolve({ image: { data: String(b.image.data), mediaType: String(b.image.mediaType ?? 'image/jpeg') }, context: String(b.context ?? '') })
    return json(res, 200, { ok: true })
  }

  if (path === '/api/ask' && req.method === 'POST') {
    const b = await body(req)
    const noteId = String(b.noteId ?? '')
    if (!noteId || !notes.index.notes[noteId]) return json(res, 400, { error: 'Open a note first' })
    const input: AskInput = {
      text: String(b.text ?? '').slice(0, 8000),
      // an ongoing conversation from before an app update gets told what changed (once)
      context: `${notes.index.notes[noteId].sessionId ? updateNote(notes.index.notes[noteId].seenVersion ?? 0) + '\n\n' : ''}${noteContext(noteId)}\n\n${String(b.context ?? '').slice(0, 30000)}`,
      image: b.image && typeof b.image.data === 'string' ? { data: b.image.data, mediaType: b.image.mediaType ?? 'image/jpeg' } : undefined,
      model: MODELS.has(b.model) ? b.model : 'opus',
      effort: EFFORTS.has(b.effort) ? b.effort : 'medium',
      snapshot: () => Promise.reject(new Error('unavailable')),
      mdOp: () => Promise.reject(new Error('unavailable')),
      view: parseView(b.view),
    }
    if (!input.text.trim()) return json(res, 400, { error: 'Missing question' })
    const tutor = tutorFor(noteId)
    if (tutor.busy) return json(res, 409, { error: 'Still answering the previous question' })
    input.snapshot = (region) =>
      new Promise<BoardView>((resolve, reject) => {
        const id = randomUUID()
        const timer = setTimeout(() => {
          snapshots.delete(id)
          reject(new Error('The browser did not send the board image in time'))
        }, 20_000)
        snapshots.set(id, { resolve, reject, timer })
        send({ type: 'snapshot', id, region })
      })
    input.mdOp = (op) =>
      new Promise<MdOpResult>((resolve, reject) => {
        const id = randomUUID()
        // typing long text out takes a while; allow for it
        const timer = setTimeout(() => {
          mdOps.delete(id)
          reject(new Error('The editor did not respond (is the note still open?)'))
        }, 90_000)
        mdOps.set(id, { resolve, timer })
        send({ type: 'mdop', id, op })
      })

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    let reply = ''
    const send = (e: TutorEvent) => {
      if (e.type === 'text') reply += e.delta
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`)
    }
    const ping = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15000)
    // the app went away mid-answer (closed, reloaded, lost connection): stop instead of staying busy
    res.on('close', () => {
      if (!res.writableEnded) void tutor.interrupt()
    })
    try {
      await tutor.ask(input, send)
    } catch (e) {
      send({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      clearInterval(ping)
      res.end()
    }
    const n = notes.index.notes[noteId]
    if (reply.trim() && n) {
      n.seenVersion = CURRENT_VERSION
      n.history.push({ at: new Date().toISOString(), question: input.text, reply })
      notes.saveNoteMeta()
    }
    return
  }
  json(res, 404, { error: 'Not found' })
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
}

function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
  const dist = join(ROOT, 'dist')
  let file = normalize(join(dist, decodeURIComponent(path)))
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html')
  const immutable = file.includes(join(dist, 'assets'))
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  res.end(readFileSync(file))
}

const server = createServer()
let vite: import('vite').ViteDevServer | null = null
if (!PROD) {
  const { createServer: createVite } = await import('vite')
  vite = await createVite({ root: ROOT, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' })
}

server.on('request', async (req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  try {
    if (path.startsWith('/api/')) return await api(req, res, path)
    if (vite) return vite.middlewares(req, res)
    serveStatic(req, res, path)
  } catch (e) {
    console.error(e)
    if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : 'Server error' })
    else res.end()
  }
})

server.listen(PORT, HOST, () => {
  console.log(`Canvas Tutor on http://${HOST}:${PORT} (${PROD ? 'production' : 'dev'}); Kokoro voice ${ttsAvailable ? 'on' : 'off (browser voices only)'}; Whisper ${sttAvailable ? 'on' : 'off (browser speech recognition only)'}`)
  warmTts()
  warmStt(join(DATA, 'tmp'))
})
