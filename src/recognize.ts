// Letter/number/symbol matching for handwriting neatening.
// Recognition uses the $P point-cloud recognizer (Vatavu, Anthony & Wobbrock 2012), which ignores
// stroke order, count and direction, so multi-stroke characters (f, t, x, =, ÷) work naturally.
// The morph pulls each of the student's points part of the way toward the nearest point of the
// matched shape (after fitting its position and size), with the pull smoothed along each stroke so
// the strokes stay coherent and still look hand-drawn.
import { GLYPHS, SAME_SHAPE, type Glyph } from './glyphs'

type Pt = { x: number; y: number }
type SP = Pt & { s: number }
const N = 48

function cloudLength(pts: SP[]) {
  let L = 0
  for (let i = 1; i < pts.length; i++) if (pts[i].s === pts[i - 1].s) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return L
}

function resample(strokes: Pt[][], n: number): SP[] {
  const pts: SP[] = strokes.flatMap((st, s) => st.map((p) => ({ x: p.x, y: p.y, s })))
  if (pts.length < 2) return pts
  const I = cloudLength(pts) / (n - 1)
  if (!I) return Array.from({ length: n }, () => ({ ...pts[0] }))
  const out: SP[] = [pts[0]]
  let D = 0
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].s !== pts[i - 1].s) continue
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    if (D + d >= I && d > 0) {
      const t = (I - D) / d
      const q: SP = { x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x), y: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y), s: pts[i].s }
      out.push(q)
      pts.splice(i, 0, q)
      D = 0
    } else D += d
  }
  while (out.length < n) out.push({ ...pts[pts.length - 1] })
  return out.slice(0, n)
}

function frame(pts: Pt[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, cx = 0, cy = 0
  for (const p of pts) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
    cx += p.x
    cy += p.y
  }
  return { cx: cx / pts.length, cy: cy / pts.length, size: Math.max(maxX - minX, maxY - minY) || 1, w: maxX - minX, h: maxY - minY }
}

function normalize(pts: SP[]): SP[] {
  const f = frame(pts)
  return pts.map((p) => ({ x: (p.x - f.cx) / f.size, y: (p.y - f.cy) / f.size, s: p.s }))
}

function cloudDistance(a: Pt[], b: Pt[], start: number) {
  const n = a.length
  const matched = new Array(n).fill(false)
  let sum = 0
  let i = start
  do {
    let best = Infinity
    let idx = -1
    for (let j = 0; j < n; j++) {
      if (matched[j]) continue
      const d = Math.hypot(a[i].x - b[j].x, a[i].y - b[j].y)
      if (d < best) {
        best = d
        idx = j
      }
    }
    matched[idx] = true
    sum += (1 - ((i - start + n) % n) / n) * best
    i = (i + 1) % n
  } while (i !== start)
  return sum
}

function greedyMatch(a: Pt[], b: Pt[]) {
  const step = Math.floor(Math.sqrt(a.length))
  let min = Infinity
  for (let i = 0; i < a.length; i += step) min = Math.min(min, cloudDistance(a, b, i), cloudDistance(b, a, i))
  return min
}

let templates: { glyph: Glyph; cloud: SP[] }[] | null = null
const tmpl = () => (templates ??= GLYPHS.map((glyph) => ({ glyph, cloud: normalize(resample(glyph.strokes, N)) })))

const sameShape = (a: string, b: string) => a === b || SAME_SHAPE.some((set) => set.includes(a) && set.includes(b))

export type Match = { glyph: Glyph; score: number; runnerUp: string; runnerScore: number }

const personalCache = new WeakMap<Glyph, SP[]>()
const cloudOf = (g: Glyph) => {
  let c = personalCache.get(g)
  if (!c) personalCache.set(g, (c = normalize(resample(g.strokes, N))))
  return c
}

/**
 * Best-matching glyph. `personal` are the student's own samples (what they look like when the
 * student writes them); when given, only those are used, since they match far better than generic
 * shapes. `prior` (0..1 per character, from context) nudges the scores.
 */
export function recognize(strokes: Pt[][], personal?: Glyph[], prior?: (ch: string) => number): Match | null {
  const total = strokes.reduce((n, s) => n + s.length, 0)
  if (total < 4) return null
  const cloud = normalize(resample(strokes, N))
  const pool = personal?.length ? personal.map((glyph) => ({ glyph, cloud: cloudOf(glyph) })) : tmpl()
  const scored = pool
    .map((t) => ({ glyph: t.glyph, score: greedyMatch(cloud, t.cloud) * (prior ? 1 - 0.25 * prior(t.glyph.ch) : 1) }))
    .sort((a, b) => a.score - b.score)
  const best = scored[0]
  const second = scored.find((s) => !sameShape(s.glyph.ch, best.glyph.ch)) ?? scored[1]
  return { glyph: best.glyph, score: best.score, runnerUp: second.glyph.ch, runnerScore: second.score }
}

/** Accept a match only when it's good and clearly better than the nearest different character. */
export function confident(m: Match | null): m is Match {
  // scores are for the student's own samples: a match under ~2.5 is a close fit, and the next
  // different character must be clearly worse
  return !!m && m.score < 2.5 && m.score < m.runnerScore * 0.85
}

function nearestOnSegments(p: Pt, segs: [Pt, Pt][]): Pt {
  let best = Infinity
  let q: Pt = p
  for (const [a, b] of segs) {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l2 = dx * dx + dy * dy
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
    const x = a.x + t * dx
    const y = a.y + t * dy
    const d = (p.x - x) ** 2 + (p.y - y) ** 2
    if (d < best) {
      best = d
      q = { x, y }
    }
  }
  return q
}

/** Points at the given arc-length fractions along a polyline. */
function atFractions(st: Pt[], fr: number[]): Pt[] {
  const cum = [0]
  for (let i = 1; i < st.length; i++) cum.push(cum[i - 1] + Math.hypot(st[i].x - st[i - 1].x, st[i].y - st[i - 1].y))
  const L = cum[cum.length - 1] || 1
  let j = 0
  return fr.map((f) => {
    const d = f * L
    while (j < st.length - 2 && cum[j + 1] < d) j++
    const seg = cum[j + 1] - cum[j] || 1
    const t = Math.max(0, Math.min(1, (d - cum[j]) / seg))
    return { x: st[j].x + (st[j + 1]?.x - st[j].x || 0) * t, y: st[j].y + (st[j + 1]?.y - st[j].y || 0) * t }
  })
}
function fractions(st: Pt[]): number[] {
  const cum = [0]
  for (let i = 1; i < st.length; i++) cum.push(cum[i - 1] + Math.hypot(st[i].x - st[i - 1].x, st[i].y - st[i - 1].y))
  const L = cum[cum.length - 1] || 1
  return cum.map((c) => c / L)
}
const isClosed = (st: Pt[]) => {
  const f = frame(st)
  return Math.hypot(st[0].x - st[st.length - 1].x, st[0].y - st[st.length - 1].y) < 0.12 * f.size
}
/** A closed stroke started from a different point (fraction `shift` of the way round). */
function rotateClosed(st: Pt[], shift: number): Pt[] {
  return atFractions(st, Array.from({ length: 64 }, (_, i) => (shift + i / 63) % 1))
}

/**
 * Pair each of the student's strokes with the glyph stroke it corresponds to (and which way round),
 * so points can move along the letter rather than just to the nearest line. Null if it doesn't fit.
 */
function correspond(user: Pt[][], tmpl: Pt[][], size: number): Pt[][] | null {
  // a letter written in one stroke that the clean version draws in several (b, d, h, m, r, 4):
  // join the clean strokes into one path, in whichever order and directions fit the writing best
  if (user.length === 1 && tmpl.length > 1 && tmpl.length <= 3) {
    const perms = (n: number): number[][] => (n <= 1 ? [[0]] : perms(n - 1).flatMap((p) => Array.from({ length: n }, (_, i) => [...p.slice(0, i), n - 1, ...p.slice(i)])))
    let best: { c: number; path: Pt[] } | null = null
    const K = 40
    const fr = Array.from({ length: K }, (_, i) => i / (K - 1))
    const u = atFractions(user[0], fr)
    for (const perm of perms(tmpl.length))
      for (let dirs = 0; dirs < 1 << tmpl.length; dirs++) {
        const path = perm.flatMap((idx, k) => ((dirs >> k) & 1 ? [...tmpl[idx]].reverse() : tmpl[idx]))
        const t = atFractions(path, fr)
        const c = u.reduce((s, p, i) => s + Math.hypot(p.x - t[i].x, p.y - t[i].y), 0) / K
        if (!best || c < best.c) best = { c, path }
      }
    if (best && best.c <= 0.25 * size) return [best.path]
    return null
  }
  if (user.length !== tmpl.length || user.length > 4) return null
  const K = 32
  const fr = Array.from({ length: K }, (_, i) => i / (K - 1))
  const us = user.map((s) => atFractions(s, fr))
  // every orientation of each template stroke: forwards, backwards, and for loops, other start points
  const options = tmpl.map((t) => {
    const outs: Pt[][] = [t, [...t].reverse()]
    if (isClosed(t)) for (let k = 1; k < 16; k++) {
      const r = rotateClosed(t, k / 16)
      outs.push(r, [...r].reverse())
    }
    return outs.map((o) => ({ full: o, pts: atFractions(o, fr) }))
  })
  const cost = (u: Pt[], t: Pt[]) => u.reduce((s, p, i) => s + Math.hypot(p.x - t[i].x, p.y - t[i].y), 0) / u.length
  const perms = (n: number): number[][] => (n <= 1 ? [[0]] : perms(n - 1).flatMap((p) => Array.from({ length: n }, (_, i) => [...p.slice(0, i), n - 1, ...p.slice(i)])))
  let best: { total: number; pick: Pt[][] } | null = null
  for (const perm of perms(user.length)) {
    let total = 0
    const pick: Pt[][] = []
    for (let i = 0; i < user.length; i++) {
      let b = Infinity
      let bf: Pt[] = []
      for (const o of options[perm[i]]) {
        const c = cost(us[i], o.pts)
        if (c < b) {
          b = c
          bf = o.full
        }
      }
      total += b
      pick.push(bf)
    }
    if (!best || total < best.total) best = { total, pick }
  }
  // strokes that don't line up with any part of the letter: don't force it
  if (!best || best.total / user.length > 0.25 * size) return null
  return best.pick
}

/**
 * Move the strokes `amount` (0..1) of the way toward the glyph. Returns new strokes, same lengths.
 * When the strokes pair up with the glyph's, each point moves toward the matching point along the
 * glyph (so a shape really changes toward the clean one); otherwise toward the nearest line of it.
 */
export function morphToward<T extends Pt>(strokes: T[][], glyph: Glyph, amount: number): T[][] {
  const uf0 = frame(strokes.flat())
  const gf0 = frame(glyph.strokes.flat())
  // the glyph stretched over the writing's box (keeps the student's proportions)
  const kx = gf0.w > 0.15 * gf0.size && uf0.w > 0.15 * uf0.size ? uf0.w / gf0.w : uf0.size / gf0.size
  const ky = gf0.h > 0.15 * gf0.size && uf0.h > 0.15 * uf0.size ? uf0.h / gf0.h : uf0.size / gf0.size
  const ux = (Math.min(...strokes.flat().map((p) => p.x)) + Math.max(...strokes.flat().map((p) => p.x))) / 2
  const uy = (Math.min(...strokes.flat().map((p) => p.y)) + Math.max(...strokes.flat().map((p) => p.y))) / 2
  const gx = (Math.min(...glyph.strokes.flat().map((p) => p.x)) + Math.max(...glyph.strokes.flat().map((p) => p.x))) / 2
  const gy = (Math.min(...glyph.strokes.flat().map((p) => p.y)) + Math.max(...glyph.strokes.flat().map((p) => p.y))) / 2
  const placed = glyph.strokes.map((s) => s.map((p) => ({ x: ux + (p.x - gx) * kx, y: uy + (p.y - gy) * ky })))
  const pairs = correspond(strokes as Pt[][], placed, uf0.size)
  if (pairs) {
    return strokes.map((st, i) => {
      const target = atFractions(pairs[i], fractions(st))
      return st.map((p, j) => ({ ...p, x: p.x + (target[j].x - p.x) * amount, y: p.y + (target[j].y - p.y) * amount }))
    })
  }
  return morphNearest(strokes, glyph, amount)
}

function morphNearest<T extends Pt>(strokes: T[][], glyph: Glyph, amount: number): T[][] {
  const all = strokes.flat()
  const uf = frame(all)
  // the glyph stretched over the writing's box, so it takes on the student's proportions
  // (narrow writing stays narrow); a glyph that's a thin line keeps its own width
  const gpts = glyph.strokes.flat()
  const gf = frame(gpts)
  const kx0 = gf.w > 0.15 * gf.size && uf.w > 0.15 * uf.size ? uf.w / gf.w : uf.size / gf.size
  const ky0 = gf.h > 0.15 * gf.size && uf.h > 0.15 * uf.size ? uf.h / gf.h : uf.size / gf.size
  let place = (p: Pt): Pt => ({ x: uf.cx + (p.x - gf.cx) * kx0, y: uf.cy + (p.y - gf.cy) * ky0 })
  let tStrokes = glyph.strokes.map((s) => s.map(place))
  // refine position and size so the glyph sits on the writing (a few rounds of nearest-point fitting)
  const samples = resample(strokes as Pt[][], 64)
  let kx = 1
  let ky = 1
  for (let it = 0; it < 4; it++) {
    const segs = tStrokes.flatMap((s) => s.slice(1).map((q, i) => [s[i], q] as [Pt, Pt]))
    const pairs = samples.map((u) => ({ u, a: nearestOnSegments(u, segs) }))
    const ax = pairs.reduce((s, p) => s + p.a.x, 0) / pairs.length
    const ay = pairs.reduce((s, p) => s + p.a.y, 0) / pairs.length
    const bx = pairs.reduce((s, p) => s + p.u.x, 0) / pairs.length
    const by = pairs.reduce((s, p) => s + p.u.y, 0) / pairs.length
    let nx = 0, dx = 0, ny = 0, dy = 0
    for (const { u, a } of pairs) {
      nx += (a.x - ax) * (u.x - bx)
      dx += (a.x - ax) ** 2
      ny += (a.y - ay) * (u.y - by)
      dy += (a.y - ay) ** 2
    }
    // don't let the fit run away
    const sx = Math.max(0.8 / kx, Math.min(1.25 / kx, dx > 1e-6 ? nx / dx : 1))
    const sy = Math.max(0.8 / ky, Math.min(1.25 / ky, dy > 1e-6 ? ny / dy : 1))
    kx *= sx
    ky *= sy
    const prev = place
    place = (p: Pt) => {
      const q = prev(p)
      return { x: bx + sx * (q.x - ax), y: by + sy * (q.y - ay) }
    }
    tStrokes = glyph.strokes.map((st) => st.map(place))
  }
  const segs = tStrokes.flatMap((s) => s.slice(1).map((q, i) => [s[i], q] as [Pt, Pt]))
  const limit = 0.25 * uf.size
  return strokes.map((st) => {
    // pull of each point toward the glyph, smoothed along the stroke
    const raw = st.map((p) => {
      const q = nearestOnSegments(p, segs)
      return { x: q.x - p.x, y: q.y - p.y }
    })
    const sigma = Math.max(2, st.length * 0.06)
    const R = Math.ceil(sigma * 2.5)
    return st.map((p, i) => {
      let sx = 0
      let sy = 0
      let sw = 0
      for (let j = Math.max(0, i - R); j <= Math.min(st.length - 1, i + R); j++) {
        const w = Math.exp(-((j - i) ** 2) / (2 * sigma * sigma))
        sx += raw[j].x * w
        sy += raw[j].y * w
        sw += w
      }
      let dx = (sx / sw) * amount
      let dy = (sy / sw) * amount
      const m = Math.hypot(dx, dy)
      if (m > limit) {
        dx *= limit / m
        dy *= limit / m
      }
      return { ...p, x: p.x + dx, y: p.y + dy }
    })
  })
}
