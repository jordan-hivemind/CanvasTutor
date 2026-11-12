// Live sync for canvas notes. Each open canvas is held in memory: devices send record-level
// changes, every other device viewing that canvas gets them over server-sent events, and the
// canvas is saved back to its .tldr file shortly after changes.
import type { ServerResponse } from 'node:http'
import type { Notes } from './notes.ts'
import type { Assets } from './assets.ts'

type Rec = { id: string; typeName?: string; [k: string]: unknown }
type Change = { version: number; from: string; put: Rec[]; remove: string[] }

class CanvasDoc {
  records = new Map<string, Rec>()
  schema: unknown = null
  version = 0
  clients = new Map<ServerResponse, string>()
  private saveTimer: NodeJS.Timeout | null = null
  lastUsed = Date.now()
  private notes: Notes
  readonly id: string

  private assets: Assets

  constructor(notes: Notes, assets: Assets, id: string) {
    this.notes = notes
    this.assets = assets
    this.id = id
    const file = JSON.parse(notes.readText(id) || '{}') as { schema?: unknown; records?: Rec[] }
    this.schema = file.schema ?? null
    let moved = false
    for (const r of file.records ?? [])
      if (r && typeof r.id === 'string') {
        if (assets.externalize(r)) moved = true // older canvases kept images inline
        this.records.set(r.id, r)
      }
    // images whose shape was erased in an earlier session (nothing can undo back to them now)
    const used = new Set<unknown>()
    for (const r of this.records.values()) if (r.typeName === 'shape') used.add((r.props as { assetId?: unknown } | undefined)?.assetId)
    for (const [id, r] of this.records)
      if (r.typeName === 'asset' && !used.has(id)) {
        this.records.delete(id)
        moved = true
      }
    if (moved) this.save()
  }

  snapshot() {
    return { version: this.version, document: this.records.size ? { store: Object.fromEntries(this.records), schema: this.schema } : null }
  }

  apply(from: string, put: Rec[], remove: string[], schema?: unknown): number {
    this.lastUsed = Date.now()
    if (schema && !this.schema) this.schema = schema
    for (const r of put)
      if (r && typeof r.id === 'string') {
        this.assets.externalize(r) // an image pasted inline: store it as a file
        this.records.set(r.id, r)
      }
    for (const id of remove) this.records.delete(id)
    this.version++
    const msg = `data: ${JSON.stringify({ version: this.version, from, put, remove } satisfies Change)}\n\n`
    for (const [res, id] of this.clients) if (id !== from && !res.writableEnded) res.write(msg)
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.save(), 1500)
    return this.version
  }

  subscribe(res: ServerResponse, clientId: string) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    res.write(`event: hello\ndata: ${JSON.stringify({ version: this.version })}\n\n`)
    this.clients.set(res, clientId)
    this.lastUsed = Date.now()
    res.on('close', () => {
      this.clients.delete(res)
      this.lastUsed = Date.now()
    })
  }

  ping() {
    for (const res of this.clients.keys()) if (!res.writableEnded) res.write(': ping\n\n')
  }

  save() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (this.notes.isTrashed(this.id) && !this.notes.index.notes[this.id]) return
    try {
      this.notes.writeText(this.id, JSON.stringify({ tldrawFileFormatVersion: 1, schema: this.schema, records: [...this.records.values()] }))
    } catch (e) {
      console.error('[canvas] save failed', this.id, e)
    }
  }

  get dirty() {
    return !!this.saveTimer
  }
}

export class Canvases {
  private docs = new Map<string, CanvasDoc>()
  private notes: Notes
  private assets: Assets

  constructor(notes: Notes, assets: Assets) {
    this.notes = notes
    this.assets = assets
    setInterval(() => {
      for (const [id, d] of this.docs) {
        d.ping()
        // unload canvases nobody has had open for 10 minutes
        if (!d.clients.size && !d.dirty && Date.now() - d.lastUsed > 10 * 60_000) this.docs.delete(id)
      }
    }, 20_000).unref()
  }

  get(id: string): CanvasDoc {
    let d = this.docs.get(id)
    if (!d) {
      if (this.notes.note(id).kind !== 'canvas') throw new Error('That note is not a canvas')
      d = new CanvasDoc(this.notes, this.assets, id)
      this.docs.set(id, d)
    }
    return d
  }

  /** Drop an in-memory copy (e.g. after a duplicate/restore changed the file underneath). */
  forget(id: string) {
    const d = this.docs.get(id)
    if (d?.dirty) d.save()
    this.docs.delete(id)
  }

  saveAll() {
    for (const d of this.docs.values()) if (d.dirty) d.save()
  }
}
