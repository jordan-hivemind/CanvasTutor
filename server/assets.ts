// Images on canvases (worksheet pages, pasted pictures) are kept as files rather than inside the
// canvas: a canvas with a few worksheets was megabytes of base64 that had to load before anything
// showed. Files are named by their content hash, so they never change and the browser caches them.
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'

const TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }
const EXT: Record<string, string> = Object.fromEntries(Object.entries(TYPES).map(([e, t]) => [t, e]))

export const ASSET_PREFIX = '/api/assets/'

export class Assets {
  private dir: string
  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
  }

  /** Store image bytes; returns the URL to use as the asset's src. */
  save(buf: Buffer, mime: string): string {
    const ext = EXT[mime.toLowerCase()] ?? 'jpg'
    const name = `${createHash('sha256').update(buf).digest('hex').slice(0, 32)}.${ext}`
    const file = join(this.dir, name)
    if (!existsSync(file)) writeFileSync(file, buf)
    return ASSET_PREFIX + name
  }

  /** A data: URL turned into a stored file (or null if it isn't an image data URL). */
  fromDataUrl(src: string): string | null {
    const m = src.match(/^data:([\w/+.-]+);base64,(.*)$/s)
    if (!m || !m[1].startsWith('image/')) return null
    return this.save(Buffer.from(m[2], 'base64'), m[1])
  }

  /** Move an asset record's inline image into a file. Returns true if it changed. */
  externalize(rec: { typeName?: string; props?: unknown }): boolean {
    const props = rec.props as { src?: unknown } | undefined
    if (rec.typeName !== 'asset' || typeof props?.src !== 'string' || !props.src.startsWith('data:')) return false
    const url = this.fromDataUrl(props.src)
    if (!url) return false
    props.src = url
    return true
  }

  serve(name: string, res: ServerResponse): boolean {
    const m = name.match(/^([0-9a-f]{32})\.(\w+)$/)
    if (!m || !TYPES[m[2]]) return false
    const file = join(this.dir, name)
    if (!existsSync(file)) return false
    // content-addressed: safe to cache forever (private: it's behind the login)
    res.writeHead(200, {
      'Content-Type': TYPES[m[2]],
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      // the tutor's graphs are SVGs: never let one run scripts if opened directly
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    })
    createReadStream(file).pipe(res)
    return true
  }
}
