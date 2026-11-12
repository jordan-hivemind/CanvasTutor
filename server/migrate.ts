// One-time move from the old single board (pages + Obsidian export) to the notes tree.
//  - every board page becomes a canvas note (in the folder it was filed under, else "Unsorted"),
//    keeping its conversation and Claude session
//  - markdown notes from the Obsidian vault are imported with their folders (images are skipped)
// The old files are kept as backups.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import type { Notes } from './notes.ts'

type Rec = { id: string; typeName: string; parentId?: string; fromId?: string; toId?: string; props?: Record<string, unknown>; name?: string }

export function migrate(dataDir: string, notes: Notes) {
  const marker = join(dataDir, '.migrated-to-notes')
  if (existsSync(marker)) return
  const log: string[] = []

  // ---- board pages → canvas notes ----
  const boardPath = join(dataDir, 'board.json')
  const metaPath = join(dataDir, 'meta.json')
  if (existsSync(boardPath)) {
    const board = JSON.parse(readFileSync(boardPath, 'utf8')) as { document?: { store?: Record<string, Rec>; schema?: unknown } | null }
    const meta = existsSync(metaPath)
      ? (JSON.parse(readFileSync(metaPath, 'utf8')) as { pages: Record<string, { sessionId: string | null; history: { at: string; question: string; reply: string }[]; export?: { folder?: string } }> })
      : { pages: {} }
    const recs = Object.values(board.document?.store ?? {})
    const docRecs = recs.filter((r) => r.typeName === 'document')
    for (const page of recs.filter((r) => r.typeName === 'page')) {
      // shapes on this page (parents can be other shapes, e.g. groups/frames)
      const shapes = new Set<string>()
      let grew = true
      while (grew) {
        grew = false
        for (const r of recs)
          if (r.typeName === 'shape' && !shapes.has(r.id) && (r.parentId === page.id || shapes.has(r.parentId ?? ''))) {
            shapes.add(r.id)
            grew = true
          }
      }
      const shapeRecs = recs.filter((r) => shapes.has(r.id))
      const assetIds = new Set(shapeRecs.map((s) => s.props?.assetId).filter(Boolean) as string[])
      const records = [
        ...docRecs,
        page,
        ...shapeRecs,
        ...recs.filter((r) => r.typeName === 'binding' && (shapes.has(r.fromId ?? '') || shapes.has(r.toId ?? ''))),
        ...recs.filter((r) => r.typeName === 'asset' && assetIds.has(r.id)),
      ]
      const m = meta.pages[page.id]
      if (!shapeRecs.length && !m?.history.length) continue // empty, never used
      const folder = m?.export?.folder || 'Unsorted'
      const entry = notes.createNote(folder, page.name || 'Untitled', 'canvas', JSON.stringify({ tldrawFileFormatVersion: 1, schema: board.document?.schema ?? null, records }))
      if (m) {
        entry.sessionId = m.sessionId
        entry.history = m.history
      }
      log.push(`canvas: ${entry.path} (${shapeRecs.length} shapes, ${m?.history.length ?? 0} Q&A)`)
    }
    notes.saveNoteMeta()
    renameSync(boardPath, join(dataDir, 'board.pre-notes.json'))
    if (existsSync(metaPath)) renameSync(metaPath, join(dataDir, 'meta.pre-notes.json'))
  }

  // ---- Obsidian vault markdown → markdown notes ----
  const vault = process.env.OBSIDIAN_VAULT
  if (vault && existsSync(vault)) {
    const walk = (rel: string) => {
      for (const e of readdirSync(join(vault, ...rel.split('/').filter(Boolean)), { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'attachments') continue
        const child = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) walk(child)
        else if (e.name.endsWith('.md')) {
          const text = readFileSync(join(vault, ...child.split('/')), 'utf8')
          if (text.includes('%% tutor:start %%')) continue // notes Canvas Tutor exported itself
          // images aren't imported: leave a readable marker instead of a broken embed
          const converted = text.replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (_, f: string) => (/\.(png|jpe?g|gif|svg|webp|bmp|pdf)$/i.test(f) ? `*(image not imported: ${f})*` : `[[${f}]]`))
          const folder = posix.dirname(child) === '.' ? '' : posix.dirname(child)
          const entry = notes.createNote(folder, e.name.replace(/\.md$/, ''), 'md', converted)
          log.push(`md: ${entry.path}`)
        }
      }
    }
    walk('')
  }

  notes.flush()
  writeFileSync(marker, `${new Date().toISOString()}\n${log.join('\n')}\n`)
  console.log(`[migrate] moved to the notes tree: ${log.length} notes`)
}
