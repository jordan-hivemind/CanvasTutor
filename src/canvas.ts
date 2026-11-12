// Bridges the tutor and the tldraw board: snapshots for Claude, and applying Claude's drawing ops.
import { AssetRecordType, Box, createShapeId, renderPlaintextFromRichText, toRichText, type Editor, type TLShapeId } from 'tldraw'

export type CanvasOp =
  | { op: 'text'; id: string; x: number; y: number; text: string; color: string; size: string; w?: number }
  | { op: 'svg'; id: string; x: number; y: number; w: number; h: number; svg: string; label: string }
  | { op: 'plot3d'; id: string; x: number; y: number; w: number; h: number; spec: string; azimuth: number; elevation: number; label: string }
  | { op: 'geo'; id: string; geo: string; x: number; y: number; w: number; h: number; color: string; fill: string; dash: string; opacity: number; label?: string; size: string }
  | { op: 'arrow'; id: string; x1: number; y1: number; x2: number; y2: number; color: string; label?: string; bend: number }
  | { op: 'erase'; ids: string[] | 'all' }
  | { op: 'view'; x: number; y: number; w: number; h: number }

const MAX_SIDE = 1400

function niceGrid(span: number): number {
  const raw = span / 10
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const n = raw / mag
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag
}

function svgToDataUrl(svg: string): string {
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))
}

function aiShapes(editor: Editor) {
  return editor.getCurrentPageShapes().filter((s) => (s.meta as { ai?: string })?.ai)
}

export type SnapRegion = 'page' | { x: number; y: number; w: number; h: number }

/**
 * JPEG of part of the page with a labelled board-coordinate grid, plus a text description.
 * By default the part the student can see; the tutor can also ask for the whole page or any region.
 */
export async function captureView(
  editor: Editor,
  region?: SnapRegion,
): Promise<{ image: { data: string; mediaType: 'image/jpeg' }; context: string; view: { minX: number; minY: number; maxX: number; maxY: number } }> {
  const studentView = editor.getViewportPageBounds()
  let vb = studentView
  if (region === 'page') {
    const page = editor.getCurrentPageBounds()
    vb = page ? Box.Common([page, studentView]).expandBy(40) : studentView
  } else if (region && region.w > 0 && region.h > 0) vb = new Box(region.x, region.y, region.w, region.h)
  const isView = vb === studentView
  const scale = Math.min(2, MAX_SIDE / Math.max(vb.w, vb.h))
  const W = Math.round(vb.w * scale)
  const H = Math.round(vb.h * scale)
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)

  const ids = [...editor.getCurrentPageShapeIds()]
  if (ids.length) {
    try {
      const { blob } = await editor.toImage(ids, { bounds: vb, scale, background: true, padding: 0, format: 'png' })
      const bmp = await createImageBitmap(blob)
      ctx.drawImage(bmp, 0, 0, W, H)
    } catch (e) {
      console.warn('snapshot failed', e)
    }
  }

  // grid in board coordinates
  const step = niceGrid(Math.max(vb.w, vb.h))
  ctx.strokeStyle = 'rgba(0, 120, 255, 0.16)'
  ctx.lineWidth = 1
  ctx.fillStyle = 'rgba(0, 90, 220, 0.75)'
  ctx.font = '11px sans-serif'
  for (let x = Math.ceil(vb.minX / step) * step; x <= vb.maxX; x += step) {
    const px = Math.round((x - vb.minX) * scale) + 0.5
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, H)
    ctx.stroke()
    ctx.fillText(String(Math.round(x)), px + 2, 11)
  }
  for (let y = Math.ceil(vb.minY / step) * step; y <= vb.maxY; y += step) {
    const py = Math.round((y - vb.minY) * scale) + 0.5
    ctx.beginPath()
    ctx.moveTo(0, py)
    ctx.lineTo(W, py)
    ctx.stroke()
    ctx.fillText(String(Math.round(y)), 2, py - 2)
  }
  // coordinate labels at every other intersection, so positions can be read anywhere in the image
  ctx.font = '10px sans-serif'
  ctx.fillStyle = 'rgba(0, 90, 220, 0.55)'
  const x0 = Math.ceil(vb.minX / step)
  const y0 = Math.ceil(vb.minY / step)
  for (let i = x0; i * step <= vb.maxX; i++)
    for (let j = y0; j * step <= vb.maxY; j++) {
      if ((i + j) % 2 || i === x0 || j === y0) continue
      ctx.fillText(`${Math.round(i * step)},${Math.round(j * step)}`, (i * step - vb.minX) * scale + 2, (j * step - vb.minY) * scale - 2)
    }

  const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
  const mine = aiShapes(editor).map((s) => {
    const b = editor.getShapePageBounds(s.id)
    const label = (s.meta as { label?: string }).label ?? s.type
    return `- ${String(s.id).replace('shape:', '')}: ${label} at x=${Math.round(b?.x ?? s.x)}, y=${Math.round(b?.y ?? s.y)}, w=${Math.round(b?.w ?? 0)}, h=${Math.round(b?.h ?? 0)}`
  })
  const theirs = studentRegions(editor, vb)
  const covered = coveredRegions(editor)
  // the whole page, so the tutor knows where free space is beyond what the student is looking at
  const all = editor.getCurrentPageBounds()
  const r = Math.round
  const pageInfo = all
    ? `[Whole page] Everything on this page (yours and the student's) lies within x=${r(all.minX)}..${r(all.maxX)}, y=${r(all.minY)}..${r(all.maxY)}; the board is infinite and empty beyond that. ${
        all.minX < vb.minX - 1 || all.maxX > vb.maxX + 1 || all.minY < vb.minY - 1 || all.maxY > vb.maxY + 1
          ? 'Some of it is outside the current view (not in the image).'
          : 'All of it is in the current view.'
      }`
    : ''
  const context = [
    `[Board ${isView ? 'view' : 'image'}] The image shows the board region x=${Math.round(vb.minX)}..${Math.round(vb.maxX)}, y=${Math.round(vb.minY)}..${Math.round(vb.maxY)} (grid lines every ${step} units, labelled with board coordinates; y grows downward). ${ids.length ? '' : 'The board is currently empty.'}${
      isView
        ? ''
        : ` This is NOT what the student is looking at: their screen shows x=${Math.round(studentView.minX)}..${Math.round(studentView.maxX)}, y=${Math.round(studentView.minY)}..${Math.round(studentView.maxY)}.`
    }`,
    pageInfo,
    theirs.length
      ? `Exact bounding boxes of the student's work in view (ink strokes near each other are grouped, roughly one per line of writing). Use these to place highlights and circles precisely; to mark part of a line, take a sub-range of its box:\n${theirs.join('\n')}`
      : '',
    mine.length ? `Things you drew that are on this page:\n${mine.join('\n')}` : 'You have not drawn anything on this page yet.',
    isView && covered.length ? `These parts of the view are hidden under app controls on the student's screen; don't put anything there:\n${covered.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return {
    image: { data: dataUrl.split(',')[1], mediaType: 'image/jpeg' },
    context,
    view: { minX: studentView.minX, minY: studentView.minY, maxX: studentView.maxX, maxY: studentView.maxY },
  }
}

/** Page-space boxes of the UI panels floating over the canvas (tldraw menus/toolbars + our controls). */
function coveredRegions(editor: Editor): string[] {
  const sel = '.tlui-style-panel, .tlui-menu-zone, .tlui-toolbar, .tlui-navigation-panel, .composer, .top-stack > *'
  const rects = [...document.querySelectorAll<HTMLElement>(sel)].map((el) => el.getBoundingClientRect()).filter((r) => r.width >= 10 && r.height >= 10)
  const inside = (a: DOMRect, b: DOMRect) => a !== b && a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1
  return rects
    .filter((r, i) => !rects.some((o, j) => inside(r, o) && (!inside(o, r) || j < i)))
    .map((r) => {
      const a = editor.screenToPage({ x: r.left, y: r.top })
      const b = editor.screenToPage({ x: r.right, y: r.bottom })
      return `- x=${Math.round(a.x)}..${Math.round(b.x)}, y=${Math.round(a.y)}..${Math.round(b.y)}`
    })
}

/** Group the student's shapes in view into line-ish regions with exact bounds. */
function studentRegions(editor: Editor, vb: Box): string[] {
  type R = { x1: number; y1: number; x2: number; y2: number; texts: string[]; kinds: Set<string> }
  const regions: R[] = []
  for (const s of editor.getCurrentPageShapes()) {
    if ((s.meta as { ai?: string })?.ai) continue
    const b = editor.getShapePageBounds(s.id)
    if (!b || !b.collides(vb)) continue
    const read = (s.meta as { read?: { kind: string; value: string } }).read
    const kind = read ? (read.kind === 'math' ? 'math converted from handwriting (LaTeX)' : 'text converted from handwriting') : (s.meta as { label?: string; worksheet?: string })?.worksheet ? String((s.meta as { label?: string }).label ?? 'worksheet') : s.type
    const r: R = { x1: b.minX, y1: b.minY, x2: b.maxX, y2: b.maxY, texts: read?.kind === 'math' ? [read.value] : [], kinds: new Set([kind]) }
    const rt = (s.props as { richText?: unknown }).richText
    if (rt) {
      try {
        const t = renderPlaintextFromRichText(editor, rt as never).trim()
        if (t) r.texts.push(t)
      } catch {}
    }
    regions.push(r)
  }
  // merge regions that sit on the same line and are close horizontally (handwriting = many strokes)
  const near = (a: R, b: R) => {
    const vOverlap = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1)
    const minH = Math.min(a.y2 - a.y1, b.y2 - b.y1)
    const hGap = Math.max(a.x1, b.x1) - Math.min(a.x2, b.x2)
    return vOverlap > minH * 0.4 && hGap < 40
  }
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < regions.length; i++)
      for (let j = i + 1; j < regions.length; j++)
        if (regions[i].kinds.has('draw') === regions[j].kinds.has('draw') && near(regions[i], regions[j])) {
          const a = regions[i]
          const b = regions[j]
          a.x1 = Math.min(a.x1, b.x1)
          a.y1 = Math.min(a.y1, b.y1)
          a.x2 = Math.max(a.x2, b.x2)
          a.y2 = Math.max(a.y2, b.y2)
          a.texts.push(...b.texts)
          b.kinds.forEach((k) => a.kinds.add(k))
          regions.splice(j, 1)
          merged = true
          break outer
        }
  }
  regions.sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1)
  return regions.slice(0, 60).map((r) => {
    const kind = r.kinds.has('draw') ? 'handwriting' : [...r.kinds].join('/')
    const text = r.texts.length ? ` "${r.texts.join(' ').slice(0, 120)}"` : ''
    return `- ${kind}${text}: x=${Math.round(r.x1)}, y=${Math.round(r.y1)}, w=${Math.round(r.x2 - r.x1)}, h=${Math.round(r.y2 - r.y1)}`
  })
}

const FONT_SIZE: Record<string, number> = { s: 18, m: 24, l: 36, xl: 44 }

export function applyOp(editor: Editor, op: CanvasOp) {
  editor.run(() => {
    switch (op.op) {
      case 'text': {
        editor.createShape({
          id: createShapeId(op.id),
          type: 'text',
          x: op.x,
          y: op.y,
          meta: { ai: '1', label: `text: ${op.text.slice(0, 60)}` },
          props: {
            richText: toRichText(op.text),
            color: op.color as never,
            size: (FONT_SIZE[op.size] ? op.size : 'm') as never,
            font: 'sans',
            ...(op.w ? { autoSize: false, w: op.w } : { autoSize: true }),
          },
        })
        break
      }
      case 'svg': {
        const assetId = AssetRecordType.createId()
        editor.createAssets([
          {
            id: assetId,
            type: 'image',
            typeName: 'asset',
            props: { name: `${op.id}.svg`, src: svgToDataUrl(op.svg), w: op.w, h: op.h, mimeType: 'image/svg+xml', isAnimated: false },
            meta: {},
          },
        ])
        editor.createShape({
          id: createShapeId(op.id),
          type: 'image',
          x: op.x,
          y: op.y,
          meta: { ai: '1', label: op.label.slice(0, 80) },
          props: { assetId, w: op.w, h: op.h },
        })
        break
      }
      case 'plot3d': {
        editor.createShape({
          id: createShapeId(op.id),
          type: 'plot3d',
          x: op.x,
          y: op.y,
          meta: { ai: '1', label: op.label.slice(0, 80) },
          props: { w: op.w, h: op.h, spec: op.spec, azimuth: op.azimuth, elevation: op.elevation },
        })
        break
      }
      case 'geo': {
        editor.createShape({
          id: createShapeId(op.id),
          type: 'geo',
          x: op.x,
          y: op.y,
          opacity: op.opacity,
          meta: { ai: '1', label: `${op.geo}${op.label ? ': ' + op.label : ''}${op.opacity < 1 ? ' (highlight)' : ''}` },
          props: {
            geo: op.geo as never,
            w: Math.max(1, op.w),
            h: Math.max(1, op.h),
            color: op.color as never,
            fill: op.fill as never,
            dash: op.dash as never,
            size: op.size as never,
            richText: toRichText(op.label ?? ''),
          },
        })
        break
      }
      case 'arrow': {
        editor.createShape({
          id: createShapeId(op.id),
          type: 'arrow',
          x: op.x1,
          y: op.y1,
          meta: { ai: '1', label: `arrow${op.label ? ': ' + op.label : ''}` },
          props: {
            start: { x: 0, y: 0 },
            end: { x: op.x2 - op.x1, y: op.y2 - op.y1 },
            color: op.color as never,
            bend: op.bend,
            richText: toRichText(op.label ?? ''),
          },
        })
        break
      }
      case 'erase': {
        const mine = aiShapes(editor)
        const ids: TLShapeId[] =
          op.ids === 'all' ? mine.map((s) => s.id) : op.ids.map((i) => createShapeId(i.replace(/^shape:/, ''))).filter((id) => mine.some((s) => s.id === id))
        if (ids.length) editor.deleteShapes(ids)
        break
      }
      case 'view': {
        editor.zoomToBounds(new Box(op.x, op.y, op.w, op.h), { animation: { duration: 400 }, inset: 40 })
        break
      }
    }
  })
}

/**
 * After a turn: if the tutor wrote somewhere the student can't see (because there wasn't room in
 * view), move the view so the new content shows, keeping the old view in frame when that still
 * leaves things readable. Never zooms in.
 */
export function followNewContent(editor: Editor, opIds: string[]) {
  const boxes = opIds.map((id) => editor.getShapePageBounds(createShapeId(id))).filter((b): b is Box => !!b)
  if (!boxes.length) return
  const added = Box.Common(boxes)
  const vb = editor.getViewportPageBounds()
  if (vb.contains(added)) return
  const zoom = editor.getZoomLevel()
  const both = Box.Common([vb, added])
  // showing both shrinks things by vb.w/both.w (or height); allow down to ~70% size
  const shrink = Math.min(vb.w / both.w, vb.h / both.h)
  const target = shrink >= 0.7 ? both : added
  editor.zoomToBounds(target, { animation: { duration: 500 }, inset: 40, targetZoom: zoom })
}

export function clearAiMarks(editor: Editor) {
  const ids = aiShapes(editor).map((s) => s.id)
  if (ids.length) editor.deleteShapes(ids)
}
