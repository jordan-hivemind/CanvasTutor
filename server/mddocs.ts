// Live sync for markdown notes, using Yjs (a CRDT, so simultaneous edits from several devices, and
// later the tutor, merge cleanly). The server relays updates between devices over server-sent
// events and keeps the merged state in data/ydocs/<id>.bin. The readable .md file is written
// from markdown snapshots the editors send (see /api/note/text).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import * as Y from 'yjs'

class MdDoc {
  doc = new Y.Doc()
  clients = new Map<ServerResponse, string>()
  lastUsed = Date.now()
  private saveTimer: NodeJS.Timeout | null = null
  private file: string

  constructor(file: string) {
    this.file = file
    if (existsSync(file)) Y.applyUpdate(this.doc, readFileSync(file))
  }

  /** Whole state, for a device opening the note. Empty means "seed me from the .md file". */
  state(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc)
  }
  get isEmpty() {
    return this.doc.getXmlFragment('prosemirror').length === 0
  }

  apply(from: string, update: Uint8Array) {
    this.lastUsed = Date.now()
    Y.applyUpdate(this.doc, update, from)
    const msg = `data: ${JSON.stringify({ from, update: Buffer.from(update).toString('base64') })}\n\n`
    for (const [res, id] of this.clients) if (id !== from && !res.writableEnded) res.write(msg)
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.save(), 1000)
  }

  subscribe(res: ServerResponse, clientId: string) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    res.write('event: hello\ndata: {}\n\n')
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
    writeFileSync(this.file + '.tmp', Y.encodeStateAsUpdate(this.doc))
    renameSync(this.file + '.tmp', this.file)
  }

  get dirty() {
    return !!this.saveTimer
  }
}

export class MdDocs {
  private docs = new Map<string, MdDoc>()
  private dir: string

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'ydocs')
    mkdirSync(this.dir, { recursive: true })
    setInterval(() => {
      for (const [id, d] of this.docs) {
        d.ping()
        if (!d.clients.size && !d.dirty && Date.now() - d.lastUsed > 10 * 60_000) this.docs.delete(id)
      }
    }, 20_000).unref()
  }

  get(id: string): MdDoc {
    if (!/^[\w-]+$/.test(id)) throw new Error('Bad note id')
    let d = this.docs.get(id)
    if (!d) {
      d = new MdDoc(join(this.dir, `${id}.bin`))
      this.docs.set(id, d)
    }
    return d
  }

  saveAll() {
    for (const d of this.docs.values()) if (d.dirty) d.save()
  }
}
