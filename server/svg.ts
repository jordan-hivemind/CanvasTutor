// Server-side SVG rendering: LaTeX (MathJax), graphs, and free-form line drawings.
// Everything renders to standalone SVG strings that the client places on the canvas as images.
import { mathjax } from 'mathjax-full/js/mathjax.js'
import { TeX } from 'mathjax-full/js/input/tex.js'
import { SVG } from 'mathjax-full/js/output/svg.js'
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js'
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js'
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js'
import { compile } from 'mathjs'
import { esc, fmt, hex, niceStep, type RenderedSvg } from './plotcore.ts'
export { COLORS, COLOR_NAMES, hex, renderPlot3D, type ColorName, type Plot3DSpec, type RenderedSvg } from './plotcore.ts'



// ---------- LaTeX ----------
const adaptor = liteAdaptor()
RegisterHTMLHandler(adaptor)
const texDoc = mathjax.document('', {
  InputJax: new TeX({ packages: AllPackages }),
  OutputJax: new SVG({ fontCache: 'none' }),
})

const EX_PX = 9 // pixels per ex at scale 1 (≈ 20px body text)

export function renderLatex(latex: string, color: string, scale = 1, display = true): RenderedSvg {
  const node = texDoc.convert(latex, { display })
  let svg = adaptor.innerHTML(node)
  const err = svg.match(/data-mjx-error="([^"]*)"/)
  if (err) throw new Error(`LaTeX error: ${err[1]}`)
  const wEx = parseFloat(svg.match(/width="([\d.]+)ex"/)?.[1] ?? '10')
  const hEx = parseFloat(svg.match(/height="([\d.]+)ex"/)?.[1] ?? '3')
  const w = Math.max(1, Math.round(wEx * EX_PX * scale))
  const h = Math.max(1, Math.round(hEx * EX_PX * scale))
  svg = svg
    .replace(/width="[\d.]+ex"/, `width="${w}"`)
    .replace(/height="[\d.]+ex"/, `height="${h}"`)
    .replace(/style="[^"]*"/, '')
    .replace(/currentColor/g, color)
  if (!svg.includes('xmlns=')) svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')
  return { svg, w, h }
}

// ---------- Lines / free-form paths ----------
export type PathSpec = {
  points: [number, number][]
  closed?: boolean
  color?: string
  dashed?: boolean
  width?: number
  arrowEnd?: boolean
}

/** Paths are given in page coordinates; returns an SVG plus its page-space origin. */
export function renderPaths(paths: PathSpec[]): RenderedSvg & { x: number; y: number } {
  const all = paths.flatMap((p) => p.points)
  if (all.length < 2) throw new Error('Need at least two points')
  const pad = 12
  const minX = Math.min(...all.map((p) => p[0])) - pad
  const minY = Math.min(...all.map((p) => p[1])) - pad
  const maxX = Math.max(...all.map((p) => p[0])) + pad
  const maxY = Math.max(...all.map((p) => p[1])) + pad
  const w = Math.max(1, Math.round(maxX - minX))
  const h = Math.max(1, Math.round(maxY - minY))
  let defs = ''
  const body = paths
    .map((p, i) => {
      const col = hex(p.color)
      const pts = p.points.map(([x, y]) => `${(x - minX).toFixed(1)},${(y - minY).toFixed(1)}`).join(' ')
      let marker = ''
      if (p.arrowEnd) {
        defs += `<marker id="a${i}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="${col}"/></marker>`
        marker = ` marker-end="url(#a${i})"`
      }
      const tag = p.closed ? 'polygon' : 'polyline'
      return `<${tag} points="${pts}" fill="none" stroke="${col}" stroke-width="${p.width ?? 3}" stroke-linecap="round" stroke-linejoin="round"${p.dashed ? ' stroke-dasharray="10 8"' : ''}${marker}/>`
    })
    .join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${defs}</defs>${body}</svg>`
  return { svg, w, h, x: minX, y: minY }
}

// ---------- Graphs ----------
export type PlotSpec = {
  w: number
  h: number
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  title?: string
  xLabel?: string
  yLabel?: string
  grid?: boolean
  functions?: { expr: string; color?: string; label?: string; dashed?: boolean }[]
  parametric?: { x: string; y: string; tMin: number; tMax: number; color?: string; label?: string; dashed?: boolean }[]
  points?: { x: number; y: number; label?: string; color?: string }[]
  vectors?: { x0?: number; y0?: number; dx: number; dy: number; color?: string; label?: string }[]
  contours?: { expr: string; levels: number[]; color?: string; labelLevels?: boolean }
  vectorField?: { p: string; q: string; density?: number; color?: string; normalize?: boolean }
}


function fn1(expr: string, v = 'x'): (t: number) => number {
  const c = compile(expr)
  return (t) => {
    try {
      const r = c.evaluate({ [v]: t, e: Math.E, pi: Math.PI })
      return typeof r === 'number' ? r : NaN
    } catch {
      return NaN
    }
  }
}

function fn2(expr: string): (x: number, y: number) => number {
  const c = compile(expr)
  return (x, y) => {
    try {
      const r = c.evaluate({ x, y, e: Math.E, pi: Math.PI })
      return typeof r === 'number' ? r : NaN
    } catch {
      return NaN
    }
  }
}

export function renderPlot(s: PlotSpec): RenderedSvg {
  if (!(s.xMax > s.xMin) || !(s.yMax > s.yMin)) throw new Error('Axis ranges must have max > min')
  const W = Math.round(s.w)
  const H = Math.round(s.h)
  const m = { l: 44, r: 16, t: s.title ? 34 : 14, b: 36 }
  const pw = W - m.l - m.r
  const ph = H - m.t - m.b
  const X = (x: number) => m.l + ((x - s.xMin) / (s.xMax - s.xMin)) * pw
  const Y = (y: number) => m.t + ((s.yMax - y) / (s.yMax - s.yMin)) * ph
  const out: string[] = []
  const font = `font-family="Helvetica, Arial, sans-serif"`
  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="white" fill-opacity="0.92"/>`)
  out.push(`<clipPath id="plot"><rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}"/></clipPath>`)

  // grid + ticks
  const xs = niceStep(s.xMax - s.xMin, Math.max(3, pw / 70))
  const ys = niceStep(s.yMax - s.yMin, Math.max(3, ph / 50))
  const ax = s.yMin <= 0 && s.yMax >= 0 ? Y(0) : s.yMin > 0 ? Y(s.yMin) : Y(s.yMax)
  const ay = s.xMin <= 0 && s.xMax >= 0 ? X(0) : s.xMin > 0 ? X(s.xMin) : X(s.xMax)
  for (let v = Math.ceil(s.xMin / xs) * xs; v <= s.xMax + 1e-9; v += xs) {
    if (s.grid !== false) out.push(`<line x1="${X(v)}" y1="${m.t}" x2="${X(v)}" y2="${m.t + ph}" stroke="#e3e6ea"/>`)
    if (Math.abs(v) > xs / 1000) {
      out.push(`<line x1="${X(v)}" y1="${ax - 4}" x2="${X(v)}" y2="${ax + 4}" stroke="#555"/>`)
      out.push(`<text x="${X(v)}" y="${Math.min(ax + 16, m.t + ph + 16)}" font-size="11" text-anchor="middle" fill="#555" ${font}>${fmt(v)}</text>`)
    }
  }
  for (let v = Math.ceil(s.yMin / ys) * ys; v <= s.yMax + 1e-9; v += ys) {
    if (s.grid !== false) out.push(`<line x1="${m.l}" y1="${Y(v)}" x2="${m.l + pw}" y2="${Y(v)}" stroke="#e3e6ea"/>`)
    if (Math.abs(v) > ys / 1000) {
      out.push(`<line x1="${ay - 4}" y1="${Y(v)}" x2="${ay + 4}" y2="${Y(v)}" stroke="#555"/>`)
      out.push(`<text x="${Math.max(ay - 7, m.l - 7)}" y="${Y(v) + 4}" font-size="11" text-anchor="end" fill="#555" ${font}>${fmt(v)}</text>`)
    }
  }
  out.push(`<line x1="${m.l}" y1="${ax}" x2="${m.l + pw}" y2="${ax}" stroke="#333" stroke-width="1.5"/>`)
  out.push(`<line x1="${ay}" y1="${m.t}" x2="${ay}" y2="${m.t + ph}" stroke="#333" stroke-width="1.5"/>`)

  const plot: string[] = []
  const legend: { label: string; color: string }[] = []

  // contours (marching squares)
  if (s.contours) {
    const f = fn2(s.contours.expr)
    const col = hex(s.contours.color, 'blue')
    const N = 120
    const gx = (i: number) => s.xMin + ((s.xMax - s.xMin) * i) / N
    const gy = (j: number) => s.yMin + ((s.yMax - s.yMin) * j) / N
    const vals: number[][] = []
    for (let i = 0; i <= N; i++) {
      vals.push([])
      for (let j = 0; j <= N; j++) vals[i].push(f(gx(i), gy(j)))
    }
    for (const level of s.contours.levels) {
      let d = ''
      let labelAt: [number, number] | null = null
      for (let i = 0; i < N; i++)
        for (let j = 0; j < N; j++) {
          const c = [vals[i][j], vals[i + 1][j], vals[i + 1][j + 1], vals[i][j + 1]]
          if (c.some((v) => !isFinite(v))) continue
          const pts: [number, number][] = []
          const corners: [number, number][] = [
            [gx(i), gy(j)],
            [gx(i + 1), gy(j)],
            [gx(i + 1), gy(j + 1)],
            [gx(i), gy(j + 1)],
          ]
          for (let k = 0; k < 4; k++) {
            const a = c[k] - level
            const b = c[(k + 1) % 4] - level
            if ((a < 0) !== (b < 0)) {
              const t = a / (a - b)
              const p = corners[k]
              const q = corners[(k + 1) % 4]
              pts.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t])
            }
          }
          for (let k = 0; k + 1 < pts.length; k += 2) {
            d += `M${X(pts[k][0]).toFixed(1)},${Y(pts[k][1]).toFixed(1)}L${X(pts[k + 1][0]).toFixed(1)},${Y(pts[k + 1][1]).toFixed(1)}`
            if (!labelAt && i > N * 0.3 && j > N * 0.3) labelAt = [X(pts[k][0]), Y(pts[k][1])]
          }
        }
      if (d) plot.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="1.8"/>`)
      if (labelAt && s.contours.labelLevels !== false)
        plot.push(`<text x="${labelAt[0]}" y="${labelAt[1]}" font-size="10" fill="${col}" stroke="white" stroke-width="3" paint-order="stroke" ${font}>${fmt(level)}</text>`)
    }
  }

  // vector field
  if (s.vectorField) {
    const P = fn2(s.vectorField.p)
    const Q = fn2(s.vectorField.q)
    const col = hex(s.vectorField.color, 'grey')
    const n = s.vectorField.density ?? 15
    const cell = Math.min(pw, ph) / n
    const samples: { x: number; y: number; u: number; v: number }[] = []
    let maxMag = 0
    for (let px = m.l + cell / 2; px < m.l + pw; px += cell)
      for (let py = m.t + cell / 2; py < m.t + ph; py += cell) {
        const x = s.xMin + ((px - m.l) / pw) * (s.xMax - s.xMin)
        const y = s.yMax - ((py - m.t) / ph) * (s.yMax - s.yMin)
        const u = P(x, y)
        const v = Q(x, y)
        if (!isFinite(u) || !isFinite(v)) continue
        samples.push({ x: px, y: py, u, v })
        maxMag = Math.max(maxMag, Math.hypot(u, v))
      }
    const sx = pw / (s.xMax - s.xMin)
    const sy = ph / (s.yMax - s.yMin)
    for (const sm of samples) {
      let du = sm.u * sx
      let dv = -sm.v * sy
      const mag = Math.hypot(du, dv)
      if (mag < 1e-9) continue
      const scale = s.vectorField.normalize === false ? (cell * 0.85) / (maxMag * Math.max(sx, sy)) : (cell * 0.75) / mag
      du *= scale
      dv *= scale
      const x1 = sm.x - du / 2
      const y1 = sm.y - dv / 2
      const x2 = sm.x + du / 2
      const y2 = sm.y + dv / 2
      const ang = Math.atan2(y2 - y1, x2 - x1)
      const hs = Math.min(6, Math.hypot(du, dv) * 0.4)
      plot.push(
        `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${col}" stroke-width="1.3"/>` +
          `<path d="M${x2.toFixed(1)},${y2.toFixed(1)}L${(x2 - hs * Math.cos(ang - 0.45)).toFixed(1)},${(y2 - hs * Math.sin(ang - 0.45)).toFixed(1)}L${(x2 - hs * Math.cos(ang + 0.45)).toFixed(1)},${(y2 - hs * Math.sin(ang + 0.45)).toFixed(1)}z" fill="${col}"/>`,
      )
    }
  }

  const curve = (pts: [number, number][], col: string, dashed?: boolean) => {
    let d = ''
    let pen = false
    let prev: [number, number] | null = null
    const yr = s.yMax - s.yMin
    for (const [x, y] of pts) {
      const ok = isFinite(x) && isFinite(y) && y > s.yMin - 3 * yr && y < s.yMax + 3 * yr
      const jump = prev && Math.abs(y - prev[1]) > yr * 1.5
      if (!ok || jump) pen = false
      if (ok) {
        d += `${pen ? 'L' : 'M'}${X(x).toFixed(1)},${Y(y).toFixed(1)}`
        pen = true
        prev = [x, y]
      } else prev = null
    }
    plot.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round"${dashed ? ' stroke-dasharray="8 6"' : ''}/>`)
  }

  for (const f of s.functions ?? []) {
    const g = fn1(f.expr)
    const col = hex(f.color, 'blue')
    const pts: [number, number][] = []
    const n = 600
    for (let i = 0; i <= n; i++) {
      const x = s.xMin + ((s.xMax - s.xMin) * i) / n
      pts.push([x, g(x)])
    }
    curve(pts, col, f.dashed)
    if (f.label) legend.push({ label: f.label, color: col })
  }
  for (const p of s.parametric ?? []) {
    const fx = fn1(p.x, 't')
    const fy = fn1(p.y, 't')
    const col = hex(p.color, 'blue')
    const pts: [number, number][] = []
    const n = 800
    for (let i = 0; i <= n; i++) {
      const t = p.tMin + ((p.tMax - p.tMin) * i) / n
      pts.push([fx(t), fy(t)])
    }
    curve(pts, col, p.dashed)
    if (p.label) legend.push({ label: p.label, color: col })
  }
  for (const v of s.vectors ?? []) {
    const col = hex(v.color, 'red')
    const x1 = X(v.x0 ?? 0)
    const y1 = Y(v.y0 ?? 0)
    const x2 = X((v.x0 ?? 0) + v.dx)
    const y2 = Y((v.y0 ?? 0) + v.dy)
    const ang = Math.atan2(y2 - y1, x2 - x1)
    plot.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="2.5"/>` +
        `<path d="M${x2},${y2}L${x2 - 11 * Math.cos(ang - 0.4)},${y2 - 11 * Math.sin(ang - 0.4)}L${x2 - 11 * Math.cos(ang + 0.4)},${y2 - 11 * Math.sin(ang + 0.4)}z" fill="${col}"/>`,
    )
    if (v.label) plot.push(`<text x="${x2 + 6}" y="${y2 - 6}" font-size="13" fill="${col}" ${font}>${esc(v.label)}</text>`)
  }
  for (const p of s.points ?? []) {
    const col = hex(p.color, 'red')
    plot.push(`<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="4.5" fill="${col}"/>`)
    if (p.label)
      plot.push(`<text x="${X(p.x) + 7}" y="${Y(p.y) - 7}" font-size="13" fill="${col}" stroke="white" stroke-width="3" paint-order="stroke" ${font}>${esc(p.label)}</text>`)
  }
  out.push(`<g clip-path="url(#plot)">${plot.join('')}</g>`)

  if (s.title) out.push(`<text x="${W / 2}" y="22" font-size="15" text-anchor="middle" font-weight="600" fill="#222" ${font}>${esc(s.title)}</text>`)
  if (s.xLabel) out.push(`<text x="${m.l + pw}" y="${H - 6}" font-size="12" text-anchor="end" fill="#333" ${font}>${esc(s.xLabel)}</text>`)
  if (s.yLabel) out.push(`<text x="${m.l + 4}" y="${m.t + 12}" font-size="12" fill="#333" ${font}>${esc(s.yLabel)}</text>`)
  legend.forEach((l, i) => {
    const y = m.t + 14 + i * 18
    out.push(`<line x1="${m.l + pw - 120}" y1="${y - 4}" x2="${m.l + pw - 100}" y2="${y - 4}" stroke="${l.color}" stroke-width="3"/>`)
    out.push(`<text x="${m.l + pw - 94}" y="${y}" font-size="12" fill="#222" stroke="white" stroke-width="3" paint-order="stroke" ${font}>${esc(l.label)}</text>`)
  })

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${out.join('')}</svg>`
  return { svg, w: W, h: H }
}

/** Light sanitising for model-written SVG (it's displayed via <img>, where scripts never run anyway). */
export function cleanSvg(svg: string, w: number, h: number): RenderedSvg {
  let s = svg.trim()
  if (!s.startsWith('<svg')) throw new Error('SVG must start with <svg')
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '').replace(/\son\w+="[^"]*"/gi, '')
  if (!/xmlns=/.test(s)) s = s.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')
  if (!/viewBox=/.test(s)) s = s.replace('<svg', `<svg viewBox="0 0 ${w} ${h}"`)
  s = s.replace(/<svg([^>]*?)\swidth="[^"]*"/, '<svg$1').replace(/<svg([^>]*?)\sheight="[^"]*"/, '<svg$1')
  s = s.replace('<svg', `<svg width="${Math.round(w)}" height="${Math.round(h)}"`)
  return { svg: s, w: Math.round(w), h: Math.round(h) }
}
