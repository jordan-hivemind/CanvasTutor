// Import worksheets (PDFs and photos) onto the board as locked images you can write on top of.
import { AssetRecordType, Box, createShapeId, type Editor, type TLShapeId } from 'tldraw'
import { uploadImage } from './assetStore'

const PAGE_WIDTH = 800 // board units per imported page
const MAX_PX = 1700 // pixel width we store (sharp enough when zoomed in, small enough to sync)
const GAP = 40

async function pdfPages(file: File): Promise<HTMLCanvasElement[]> {
  const pdfjs = await import('pdfjs-dist')
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
  const pages: HTMLCanvasElement[] = []
  for (let i = 1; i <= Math.min(doc.numPages, 40); i++) {
    const page = await doc.getPage(i)
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: MAX_PX / base.width })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    // 'print' renders without requestAnimationFrame, so it also finishes if the tab is in the background
    await page.render({ canvas, canvasContext: ctx, viewport, intent: 'print' }).promise
    pages.push(canvas)
  }
  return pages
}

async function imageCanvas(file: File): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const scale = Math.min(1, MAX_PX / Math.max(bmp.width, bmp.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bmp.width * scale)
  canvas.height = Math.round(bmp.height * scale)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  return canvas
}

/** Adds the files as a column of locked pages, starting at the top-left of the current view. */
export async function importWorksheets(editor: Editor, files: File[], onProgress?: (msg: string) => void): Promise<number> {
  const vb = editor.getViewportPageBounds()
  let x = vb.minX + 120
  let y = vb.minY + 60
  // don't drop the pages on top of existing work: start below anything already in that column
  const below = editor
    .getCurrentPageShapes()
    .map((s) => editor.getShapePageBounds(s.id))
    .filter((b): b is Box => !!b && b.maxX > x && b.minX < x + PAGE_WIDTH && b.maxY > y)
  if (below.length) y = Math.max(...below.map((b) => b.maxY)) + GAP

  const created: TLShapeId[] = []
  for (const file of files) {
    onProgress?.(`Importing ${file.name}…`)
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    const canvases = isPdf ? await pdfPages(file) : [await imageCanvas(file)]
    for (const [i, canvas] of canvases.entries()) {
      const w = PAGE_WIDTH
      const h = (canvas.height / canvas.width) * PAGE_WIDTH
      const assetId = AssetRecordType.createId()
      const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the page'))), 'image/jpeg', 0.85))
      const src = await uploadImage(blob)
      editor.createAssets([
        {
          id: assetId,
          type: 'image',
          typeName: 'asset',
          props: { name: file.name, src, w: canvas.width, h: canvas.height, mimeType: 'image/jpeg', isAnimated: false },
          meta: {},
        },
      ])
      const id = createShapeId()
      const label = canvases.length > 1 ? `worksheet "${file.name}" page ${i + 1}` : `worksheet "${file.name}"`
      editor.createShape({ id, type: 'image', x, y, isLocked: true, meta: { worksheet: '1', label }, props: { assetId, w, h } })
      created.push(id)
      y += h + GAP
    }
  }
  if (created.length) {
    const first = editor.getShapePageBounds(created[0])
    if (first) editor.zoomToBounds(new Box(first.x, first.y, first.w, Math.min(first.h, first.w * 1.3)), { animation: { duration: 300 }, inset: 24 })
  }
  return created.length
}
