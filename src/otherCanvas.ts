// Renders a canvas note that isn't open (for the tutor's read_note) into a JPEG of its whole page,
// using a headless tldraw editor so the open board is untouched.
import {
  Box,
  createTLStore,
  defaultAddFontsFromNode,
  defaultBindingUtils,
  defaultShapeUtils,
  Editor,
  tipTapDefaultExtensions,
  type TLAnyShapeUtilConstructor,
  type TLStoreSnapshot,
} from 'tldraw'
import { loadNote } from './noteCache'

const MAX_SIDE = 1800

type Doc = { document: TLStoreSnapshot | null }

export async function captureOtherCanvas(
  noteId: string,
  extraShapeUtils: TLAnyShapeUtilConstructor[],
  licenseKey?: string,
): Promise<{ image?: { data: string; mediaType: 'image/jpeg' }; context: string }> {
  const { data } = await loadNote<Doc>('canvas', noteId)
  if (!data.document?.schema) return { context: 'That canvas is empty.' }
  const shapeUtils = [...defaultShapeUtils, ...extraShapeUtils]
  const store = createTLStore({ shapeUtils, snapshot: data.document })
  const host = document.createElement('div')
  host.className = 'tl-container tl-theme__light'
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:800px;height:600px;pointer-events:none;'
  const inner = document.createElement('div')
  host.appendChild(inner)
  document.body.appendChild(host)
  const editor = new Editor({
    store,
    shapeUtils,
    bindingUtils: defaultBindingUtils,
    tools: [],
    getContainer: () => inner,
    licenseKey,
    options: { text: { tipTapConfig: { extensions: tipTapDefaultExtensions }, addFontsFromNode: defaultAddFontsFromNode } },
  })
  try {
    const pages = editor.getPages()
    // the page with the most on it (canvases normally have one)
    const page = pages.reduce((best, p) => (editor.getPageShapeIds(p.id).size > editor.getPageShapeIds(best.id).size ? p : best), pages[0])
    editor.setCurrentPage(page.id)
    const ids = [...editor.getCurrentPageShapeIds()]
    const bounds = editor.getCurrentPageBounds()
    if (!ids.length || !bounds) return { context: 'That canvas is empty.' }
    const vb = Box.From(bounds).expandBy(30)
    const scale = Math.min(2, MAX_SIDE / Math.max(vb.w, vb.h))
    const { blob } = await editor.toImage(ids, { bounds: vb, scale, background: true, padding: 0, format: 'png' })
    const bmp = await createImageBitmap(blob)
    const c = document.createElement('canvas')
    c.width = Math.round(vb.w * scale)
    c.height = Math.round(vb.h * scale)
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.drawImage(bmp, 0, 0, c.width, c.height)
    const data = c.toDataURL('image/jpeg', 0.85).split(',')[1]
    const small = scale < 0.6 ? ' It is a large canvas, so the image is scaled down; small writing may be hard to read.' : ''
    return {
      image: { data, mediaType: 'image/jpeg' },
      context: `Image of everything on that canvas (${ids.length} items).${small} You can only look at it; your drawing tools work on the open note.`,
    }
  } finally {
    editor.dispose()
    host.remove()
  }
}
