// Browser-safe plotting helpers shared by the server tools and the in-browser 3D plot shape.
import { compile } from 'mathjs'

export const COLORS = {
  black: '#1d1d1d',
  grey: '#9fa8b2',
  'light-violet': '#e085f4',
  violet: '#ae3ec9',
  blue: '#4465e9',
  'light-blue': '#4ba1f1',
  yellow: '#f1ac4b',
  orange: '#e16919',
  green: '#099268',
  'light-green': '#4cb05e',
  'light-red': '#f87777',
  red: '#e03131',
} as const
export type ColorName = keyof typeof COLORS
export const COLOR_NAMES = Object.keys(COLORS) as [ColorName, ...ColorName[]]

export function hex(c: string | undefined, fallback: ColorName = 'violet'): string {
  return COLORS[(c ?? fallback) as ColorName] ?? COLORS[fallback]
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export type RenderedSvg = { svg: string; w: number; h: number }

export function niceStep(range: number, target: number): number {
  const raw = range / target
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const n = raw / mag
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag
}

export function fmt(v: number): string {
  const r = Math.round(v * 1e6) / 1e6
  return Math.abs(r) >= 1e4 || (Math.abs(r) < 1e-3 && r !== 0) ? r.toExponential(1) : String(r)
}

// ---------- 3D plots ----------
export type Plot3DSpec = {
  w: number
  h: number
  title?: string
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  zMin?: number
  zMax?: number
  azimuth?: number
  elevation?: number
  xLabel?: string
  yLabel?: string
  zLabel?: string
  surfaces?: { expr: string; color?: string; opacity?: number }[]
  parametricSurfaces?: { x: string; y: string; z: string; uMin: number; uMax: number; vMin: number; vMax: number; color?: string; opacity?: number }[]
  curves?: { x: string; y: string; z: string; tMin: number; tMax: number; color?: string; label?: string; dashed?: boolean }[]
  points?: { x: number; y: number; z: number; label?: string; color?: string }[]
  vectors?: { x0?: number; y0?: number; z0?: number; dx: number; dy: number; dz: number; color?: string; label?: string }[]
  /** Mesh cells per side (default 34); lower renders faster while rotating. */
  resolution?: number
}

const VIRIDIS = ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725']
function ramp(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (VIRIDIS.length - 1)
  const i = Math.min(VIRIDIS.length - 2, Math.floor(x))
  const f = x - i
  const a = VIRIDIS[i].match(/\w\w/g)!.map((h) => parseInt(h, 16))
  const b = VIRIDIS[i + 1].match(/\w\w/g)!.map((h) => parseInt(h, 16))
  return [0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * f) as [number, number, number]
}
function hexRgb(h: string): [number, number, number] {
  return h.match(/\w\w/g)!.map((x) => parseInt(x, 16)) as [number, number, number]
}
const rgb = (c: [number, number, number], k = 1) => `rgb(${c.map((v) => Math.round(Math.max(0, Math.min(255, v * k)))).join(',')})`

function fnT(expr: string, vars: string[]): (...a: number[]) => number {
  const c = compile(expr)
  return (...a) => {
    const scope: Record<string, number> = { e: Math.E, pi: Math.PI }
    vars.forEach((v, i) => (scope[v] = a[i]))
    try {
      const r = c.evaluate(scope)
      return typeof r === 'number' ? r : NaN
    } catch {
      return NaN
    }
  }
}

export function renderPlot3D(s: Plot3DSpec): RenderedSvg {
  if (!(s.xMax > s.xMin) || !(s.yMax > s.yMin)) throw new Error('Axis ranges must have max > min')
  const W = Math.round(s.w)
  const H = Math.round(s.h)
  const N = Math.max(8, Math.min(60, Math.round(s.resolution ?? 34)))

  // sample surfaces first so we can auto-fit z
  type Grid = { pts: [number, number, number][][]; color?: string; opacity: number }
  const grids: Grid[] = []
  for (const sf of s.surfaces ?? []) {
    const f = fnT(sf.expr, ['x', 'y'])
    const pts: [number, number, number][][] = []
    for (let i = 0; i <= N; i++) {
      pts.push([])
      for (let j = 0; j <= N; j++) {
        const x = s.xMin + ((s.xMax - s.xMin) * i) / N
        const y = s.yMin + ((s.yMax - s.yMin) * j) / N
        pts[i].push([x, y, f(x, y)])
      }
    }
    grids.push({ pts, color: sf.color, opacity: sf.opacity ?? 1 })
  }
  for (const ps of s.parametricSurfaces ?? []) {
    const fx = fnT(ps.x, ['u', 'v'])
    const fy = fnT(ps.y, ['u', 'v'])
    const fz = fnT(ps.z, ['u', 'v'])
    const pts: [number, number, number][][] = []
    for (let i = 0; i <= N; i++) {
      pts.push([])
      for (let j = 0; j <= N; j++) {
        const u = ps.uMin + ((ps.uMax - ps.uMin) * i) / N
        const v = ps.vMin + ((ps.vMax - ps.vMin) * j) / N
        pts[i].push([fx(u, v), fy(u, v), fz(u, v)])
      }
    }
    grids.push({ pts, color: ps.color, opacity: ps.opacity ?? 1 })
  }
  const curves = (s.curves ?? []).map((c) => {
    const fx = fnT(c.x, ['t'])
    const fy = fnT(c.y, ['t'])
    const fz = fnT(c.z, ['t'])
    const pts: [number, number, number][] = []
    for (let i = 0; i <= 400; i++) {
      const t = c.tMin + ((c.tMax - c.tMin) * i) / 400
      pts.push([fx(t), fy(t), fz(t)])
    }
    return { ...c, pts }
  })

  let zMin = s.zMin
  let zMax = s.zMax
  if (zMin === undefined || zMax === undefined) {
    const zs = [
      ...grids.flatMap((g) => g.pts.flat().map((p) => p[2])),
      ...curves.flatMap((c) => c.pts.map((p) => p[2])),
      ...(s.points ?? []).map((p) => p.z),
    ].filter(isFinite)
    const lo = zs.length ? Math.min(...zs) : -1
    const hi = zs.length ? Math.max(...zs) : 1
    zMin ??= lo
    zMax ??= hi > lo ? hi : lo + 1
  }
  if (!(zMax > zMin)) zMax = zMin + 1

  // normalise to a cube, rotate, orthographic projection
  const az = ((s.azimuth ?? -55) * Math.PI) / 180
  const el = ((s.elevation ?? 28) * Math.PI) / 180
  const nx = (x: number) => ((x - s.xMin) / (s.xMax - s.xMin)) * 2 - 1
  const ny = (y: number) => ((y - s.yMin) / (s.yMax - s.yMin)) * 2 - 1
  const nz = (z: number) => (((z - zMin!) / (zMax! - zMin!)) * 2 - 1) * 0.8
  const proj = (x: number, y: number, z: number) => {
    const X = nx(x)
    const Y = ny(y)
    const Z = nz(z)
    const rx = X * Math.cos(az) - Y * Math.sin(az)
    const ry = X * Math.sin(az) + Y * Math.cos(az)
    return { sx: rx, sy: Z * Math.cos(el) + ry * Math.sin(el), depth: ry * Math.cos(el) - Z * Math.sin(el) }
  }
  const top = s.title ? 30 : 10
  const corners: [number, number, number][] = []
  for (const x of [s.xMin, s.xMax]) for (const y of [s.yMin, s.yMax]) for (const z of [zMin, zMax]) corners.push([x, y, z])
  const pc = corners.map((c) => proj(...c))
  const minSx = Math.min(...pc.map((p) => p.sx))
  const maxSx = Math.max(...pc.map((p) => p.sx))
  const minSy = Math.min(...pc.map((p) => p.sy))
  const maxSy = Math.max(...pc.map((p) => p.sy))
  const pad = 40
  const k = Math.min((W - 2 * pad) / (maxSx - minSx), (H - top - 2 * pad) / (maxSy - minSy))
  const cx = W / 2 - ((minSx + maxSx) / 2) * k
  const cy = top + (H - top) / 2 + ((minSy + maxSy) / 2) * k
  const P = (x: number, y: number, z: number) => {
    const p = proj(x, y, z)
    return { x: cx + p.sx * k, y: cy - p.sy * k, d: p.depth }
  }
  const font = `font-family="Helvetica, Arial, sans-serif"`
  const out: string[] = [`<rect width="${W}" height="${H}" fill="white" fill-opacity="0.94"/>`]

  // box: back edges behind everything
  const edges: [number, number][] = [
    [0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7],
  ]
  const P3 = corners.map((c) => P(...c))
  const meanD = P3.reduce((a, p) => a + p.d, 0) / 8
  for (const [a, b] of edges) {
    const back = (P3[a].d + P3[b].d) / 2 > meanD
    if (back) out.push(`<line x1="${P3[a].x}" y1="${P3[a].y}" x2="${P3[b].x}" y2="${P3[b].y}" stroke="#cfd4da" stroke-width="1"/>`)
  }
  // floor grid
  const xs = niceStep(s.xMax - s.xMin, 5)
  const ys = niceStep(s.yMax - s.yMin, 5)
  for (let v = Math.ceil(s.xMin / xs) * xs; v <= s.xMax + 1e-9; v += xs) {
    const a = P(v, s.yMin, zMin)
    const b = P(v, s.yMax, zMin)
    out.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#eceff2"/>`)
  }
  for (let v = Math.ceil(s.yMin / ys) * ys; v <= s.yMax + 1e-9; v += ys) {
    const a = P(s.xMin, v, zMin)
    const b = P(s.xMax, v, zMin)
    out.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#eceff2"/>`)
  }

  // surface quads, painter's algorithm
  type Quad = { d: number; svg: string }
  const quads: Quad[] = []
  const light = [0.4, -0.5, 0.77]
  for (const g of grids) {
    const solid = g.color && g.color !== 'height' ? hexRgb(hex(g.color, 'blue')) : null
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++) {
        const c = [g.pts[i][j], g.pts[i + 1][j], g.pts[i + 1][j + 1], g.pts[i][j + 1]]
        if (c.some((p) => !p.every(isFinite))) continue
        const zAvg = (c[0][2] + c[1][2] + c[2][2] + c[3][2]) / 4
        if (zAvg < zMin - 1e-9 || zAvg > zMax + 1e-9) continue
        const cc = c.map((p) => [p[0], p[1], Math.max(zMin!, Math.min(zMax!, p[2]))] as [number, number, number])
        const pp = cc.map((p) => P(...p))
        // shading from the normal in normalised space
        const u = [nx(cc[2][0]) - nx(cc[0][0]), ny(cc[2][1]) - ny(cc[0][1]), nz(cc[2][2]) - nz(cc[0][2])]
        const v = [nx(cc[3][0]) - nx(cc[1][0]), ny(cc[3][1]) - ny(cc[1][1]), nz(cc[3][2]) - nz(cc[1][2])]
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        const len = Math.hypot(...n) || 1
        const shade = 0.72 + 0.35 * Math.abs((n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) / len)
        const base = solid ?? ramp((zAvg - zMin) / (zMax - zMin))
        const fill = rgb(base, shade)
        const d = pp.reduce((a, p) => a + p.d, 0) / 4
        quads.push({
          d,
          svg: `<path d="M${pp.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L')}z" fill="${fill}" stroke="rgba(0,0,0,0.18)" stroke-width="0.5"${g.opacity < 1 ? ` fill-opacity="${g.opacity}"` : ''}/>`,
        })
      }
  }
  quads.sort((a, b) => b.d - a.d)
  out.push(...quads.map((q) => q.svg))

  // curves, vectors, points on top
  for (const c of curves) {
    const col = hex(c.color, 'red')
    let d = ''
    let pen = false
    for (const p of c.pts) {
      if (!p.every(isFinite) || p[2] < zMin - 1e-9 || p[2] > zMax + 1e-9) {
        pen = false
        continue
      }
      const q = P(...p)
      d += `${pen ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`
      pen = true
    }
    out.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="2.5"${c.dashed ? ' stroke-dasharray="7 5"' : ''}/>`)
    if (c.label) {
      const last = c.pts.filter((p) => p.every(isFinite)).pop()
      if (last) {
        const q = P(...last)
        out.push(`<text x="${q.x + 6}" y="${q.y - 6}" font-size="13" fill="${col}" stroke="white" stroke-width="3" paint-order="stroke" ${font}>${esc(c.label)}</text>`)
      }
    }
  }
  for (const v of s.vectors ?? []) {
    const col = hex(v.color, 'red')
    const a = P(v.x0 ?? 0, v.y0 ?? 0, v.z0 ?? 0)
    const b = P((v.x0 ?? 0) + v.dx, (v.y0 ?? 0) + v.dy, (v.z0 ?? 0) + v.dz)
    const ang = Math.atan2(b.y - a.y, b.x - a.x)
    out.push(
      `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${col}" stroke-width="2.5"/>` +
        `<path d="M${b.x},${b.y}L${b.x - 11 * Math.cos(ang - 0.4)},${b.y - 11 * Math.sin(ang - 0.4)}L${b.x - 11 * Math.cos(ang + 0.4)},${b.y - 11 * Math.sin(ang + 0.4)}z" fill="${col}"/>`,
    )
    if (v.label) out.push(`<text x="${b.x + 6}" y="${b.y - 6}" font-size="13" fill="${col}" stroke="white" stroke-width="3" paint-order="stroke" ${font}>${esc(v.label)}</text>`)
  }
  for (const p of s.points ?? []) {
    const col = hex(p.color, 'red')
    const q = P(p.x, p.y, p.z)
    out.push(`<circle cx="${q.x}" cy="${q.y}" r="4.5" fill="${col}" stroke="white" stroke-width="1.5"/>`)
    if (p.label) out.push(`<text x="${q.x + 7}" y="${q.y - 7}" font-size="13" fill="${col}" stroke="white" stroke-width="3" paint-order="stroke" ${font}>${esc(p.label)}</text>`)
  }

  // front box edges + axis ticks/labels
  for (const [a, b] of edges) {
    const back = (P3[a].d + P3[b].d) / 2 > meanD
    if (!back) out.push(`<line x1="${P3[a].x}" y1="${P3[a].y}" x2="${P3[b].x}" y2="${P3[b].y}" stroke="#9aa3ad" stroke-width="1" stroke-opacity="0.6"/>`)
  }
  const tickText = (x: number, y: number, z: number, text: string, dx = 0, dy = 0) => {
    const q = P(x, y, z)
    out.push(`<text x="${(q.x + dx).toFixed(1)}" y="${(q.y + dy).toFixed(1)}" font-size="10" text-anchor="middle" fill="#555" ${font}>${text}</text>`)
  }
  // choose the front-most bottom edges for x and y ticks
  const yEdge = P(0 + s.xMin, s.yMin, zMin).d < P(s.xMin, s.yMax, zMin).d ? s.yMin : s.yMax
  const xEdge = P(s.xMin, s.yMin, zMin).d < P(s.xMax, s.yMin, zMin).d ? s.xMin : s.xMax
  for (let v = Math.ceil(s.xMin / xs) * xs; v <= s.xMax + 1e-9; v += xs) tickText(v, yEdge, zMin, fmt(v), 0, 14)
  for (let v = Math.ceil(s.yMin / ys) * ys; v <= s.yMax + 1e-9; v += ys)
    if (Math.abs(v - yEdge) > ys / 2) tickText(xEdge, v, zMin, fmt(v), 0, 14) // skip the corner shared with the x ticks
  const zs = niceStep(zMax - zMin, 4)
  const zx = xEdge
  const zy = yEdge === s.yMin ? s.yMax : s.yMin
  for (let v = Math.ceil(zMin / zs) * zs; v <= zMax + 1e-9; v += zs) tickText(zx, zy, v, fmt(v), -14, 4)
  const lbl = (x: number, y: number, z: number, t: string) => {
    const q = P(x, y, z)
    out.push(`<text x="${q.x}" y="${q.y}" font-size="13" font-weight="600" text-anchor="middle" fill="#333" ${font}>${esc(t)}</text>`)
  }
  lbl((s.xMin + s.xMax) / 2, yEdge + (yEdge === s.yMin ? -1 : 1) * (s.yMax - s.yMin) * 0.16, zMin, s.xLabel ?? 'x')
  lbl(xEdge + (xEdge === s.xMin ? -1 : 1) * (s.xMax - s.xMin) * 0.16, (s.yMin + s.yMax) / 2, zMin, s.yLabel ?? 'y')
  lbl(zx, zy, zMax + (zMax - zMin) * 0.12, s.zLabel ?? 'z')
  if (s.title) out.push(`<text x="${W / 2}" y="20" font-size="15" text-anchor="middle" font-weight="600" fill="#222" ${font}>${esc(s.title)}</text>`)

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${out.join('')}</svg>`
  return { svg, w: W, h: H }
}
