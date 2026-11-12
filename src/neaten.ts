// Handwriting neatening (a global setting): when a pen stroke ends, tidy it up while keeping it the
// student's handwriting (not a font). Tuned on the student's real notes. A stroke whose intent is
// unclear is left closer to how it was drawn rather than "fixed" into something else.
//  1. lines meant to be straight (bars, minus signs, underlines, long lines) → straight, with the hook
//     where the pen landed or lifted dropped; within 2.5° of level/upright → exact. A consistent bow
//     on a long stroke is kept as a curve (graphs).
//  2. a loop that almost closes (O, 0, circles) → closed
//  3. letters and symbols: split at corners; each piece is pulled most of the way toward a straight
//     line (if nearly straight) or a smooth curve, corners stay put, and no point moves far.
//     Big drawings (graphs, diagrams) only get a gentle version of this.
import { useEffect } from 'react'
import { b64Vecs, type Editor, type TLDrawShape, type TLShapeId, type VecModel } from 'tldraw'
import type { Glyph } from './glyphs'
import { confident, morphToward, recognize } from './recognize'
import { contextPrior } from './letterContext'
import type { MatchStrength } from './prefs'

type P = { x: number; y: number; z: number }

const STRAIGHT_MIN_PX = 14 // strokes smaller than this on screen (dots, tiny marks) are never straightened
const SMOOTH_MIN_PX = 12
const MAX_SMOOTH_SHIFT_PX = 1.5
const SNAP_DEG = 2.5
const HOOK_MAX_PX = 8 // an end flick shorter than this (and < 6% of the stroke) is dropped

const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y)

function pathLength(pts: P[]) {
  let L = 0
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i])
  return L
}

/** Signed distance of p from the line a→b. */
function perp(p: P, a: P, b: P) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  return ((p.x - a.x) * dy - (p.y - a.y) * dx) / len
}

/** Index range of the points whose arc length lies within [from, to]. */
function cumulative(pts: P[]) {
  const c = [0]
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + dist(pts[i - 1], pts[i]))
  return c
}

/** How straight the run s..e is: its chord, how far it strays each side, and its length. */
function fit(pts: P[], cum: number[], s: number, e: number) {
  const a = pts[s]
  const b = pts[e]
  let maxPos = 0
  let maxNeg = 0
  for (let i = s; i <= e; i++) {
    const d = perp(pts[i], a, b)
    if (d > maxPos) maxPos = d
    if (-d > maxNeg) maxNeg = -d
  }
  return { a, b, chord: dist(a, b), maxPos, maxNeg, maxDev: Math.max(maxPos, maxNeg), len: cum[e] - cum[s] }
}

/** 1. A straight line, or null if the stroke isn't clearly meant to be one. px = screen px per stroke unit. */
function straighten(pts: P[], px: number, mult = 1): P[] | null {
  const L = pathLength(pts)
  if (L * px < STRAIGHT_MIN_PX || pts.length < 4) return null
  const cum = cumulative(pts)
  const at = (f: number) => {
    let i = 0
    while (i < pts.length - 1 && cum[i] < f * L) i++
    return i
  }
  // Bars, minus signs, underlines and long lines are where a straight line is almost always meant;
  // short upright strokes are mostly parts of letters (l, 1, t, J), so those are judged strictly.
  const mid = fit(pts, cum, at(0.2), at(0.8))
  const angle = Math.abs((Math.atan2(mid.b.y - mid.a.y, mid.b.x - mid.a.x) * 180) / Math.PI)
  const level = Math.min(angle, 180 - angle) < 20
  const long = L * px >= 70
  const lenient = level || long
  // A hook where the pen landed or lifted can be dropped. On level strokes (bars, minus signs) that's
  // a short hook (≤ ~10% of the stroke, 10–20 screen px); anywhere else only a tiny flick, since a
  // longer tail on an upright stroke is usually part of a letter (J, 7, t) and a leg off a bar may be a corner.
  const levelHook = Math.min(20 / px, Math.max(10 / px, 0.1 * L)) / L
  const maxTrim = level ? Math.min(0.25, levelHook) : Math.min(0.06, HOOK_MAX_PX / px / L)
  const twoSided = (lenient ? 0.06 : 0.04) * mult // wobble either side of the line
  // a bow all to one side: beyond this it's a deliberate curve. Short bars bow from the arm's arc;
  // a long, gently bending stroke is more likely part of a graph, so it gets less leeway
  const oneSided = (level && L * px < 150 ? 0.035 : 0.008) * Math.min(mult, 1.2)
  // find the longest straight core (least trimmed off the ends)
  let best: { s: number; e: number; f: ReturnType<typeof fit> } | null = null
  const steps = [0, 0.03, 0.06, 0.1, 0.15, 0.2, 0.25].filter((t) => t <= maxTrim + 1e-9)
  if (!steps.length || steps[steps.length - 1] < maxTrim) steps.push(maxTrim)
  for (const ts of steps)
    for (const te of steps) {
      if (best && ts + te >= (cum[best.s] + (L - cum[best.e])) / L - 1e-9) continue
      const s = at(ts)
      const e = Math.min(pts.length - 1, at(1 - te))
      if (e - s < 3) continue
      const f = fit(pts, cum, s, e)
      if (f.chord * px < STRAIGHT_MIN_PX * 0.8 || f.len / f.chord > 1.12) continue
      const r = f.maxDev / f.chord
      const isBow = Math.min(f.maxPos, f.maxNeg) < 0.25 * f.maxDev
      if (r > twoSided || (isBow && r > oneSided)) continue
      best = { s, e, f }
    }
  if (!best) return null
  const { s, e } = best
  const { a, b, chord, maxDev } = best.f
  // ends: keep them on the line unless they're a short flick away from it
  const tailOk = (i: number) => Math.abs(perp(pts[i], a, b)) <= Math.max(2 * maxDev, 1 / px)
  let first = 0
  for (let i = 0; i < s; i++) if (!tailOk(i)) first = i + 1
  let last = pts.length - 1
  for (let i = pts.length - 1; i > e; i--) if (!tailOk(i)) last = i - 1
  // project onto the line through the core, keeping each point's position along it and its pressure
  const ux = (b.x - a.x) / chord
  const uy = (b.y - a.y) / chord
  let line = pts.slice(first, last + 1).map((p) => {
    const t = (p.x - a.x) * ux + (p.y - a.y) * uy
    return { x: a.x + ux * t, y: a.y + uy * t, z: p.z }
  })
  // nearly level or upright: make it exact (rotate about the middle)
  const ang = (Math.atan2(uy, ux) * 180) / Math.PI
  const target = Math.round(ang / 90) * 90
  if (Math.abs(ang - target) <= SNAP_DEG && ang !== target) {
    const r = ((target - ang) * Math.PI) / 180
    const m = line[Math.floor(line.length / 2)]
    const cos = Math.cos(r)
    const sin = Math.sin(r)
    line = line.map((p) => ({ x: m.x + (p.x - m.x) * cos - (p.y - m.y) * sin, y: m.y + (p.x - m.x) * sin + (p.y - m.y) * cos, z: p.z }))
  }
  return line
}

/** Total absolute turning of the path, in radians. */
function turning(pts: P[]) {
  let t = 0
  for (let i = 2; i < pts.length; i++) {
    const a1 = Math.atan2(pts[i - 1].y - pts[i - 2].y, pts[i - 1].x - pts[i - 2].x)
    const a2 = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x)
    let d = a2 - a1
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    t += d
  }
  return t
}

/** 2. A loop that almost closes gets its end eased onto its start; null if not such a loop. */
function closeLoop(pts: P[], px: number): P[] | null {
  if (pts.length < 8) return null
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const D = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  if (D * px < 14) return null
  const gap = dist(pts[0], pts[pts.length - 1])
  if (gap < 0.5 / px || gap > 0.12 * D) return null
  // it must go round once, consistently (net turning ≈ one full turn, not a figure 8 or a scribble)
  const net = Math.abs(turning(pts))
  if (net < 1.6 * Math.PI || net > 2.6 * Math.PI) return null
  // ease the last stretch (about 3× the gap) toward the start
  const cum = cumulative(pts)
  const L = cum[cum.length - 1]
  const span = Math.min(3 * gap, 0.25 * L)
  const dx = pts[0].x - pts[pts.length - 1].x
  const dy = pts[0].y - pts[pts.length - 1].y
  return pts.map((p, i) => {
    const into = cum[i] - (L - span)
    if (into <= 0) return p
    const w = into / span
    const ease = w * w * (3 - 2 * w)
    return { x: p.x + dx * ease, y: p.y + dy * ease, z: p.z }
  })
}

/** 3. Steady a wobbly stroke: smooth between corners, never moving a point far. */
function steady(pts: P[], px: number): P[] | null {
  if (pts.length < 6) return null
  const L = pathLength(pts)
  if (L * px < SMOOTH_MIN_PX) return null
  // corners: sharp direction changes over a short distance are kept exactly (letters depend on them)
  const corner = new Array(pts.length).fill(false)
  const k = 2
  for (let i = k; i < pts.length - k; i++) {
    const a1 = Math.atan2(pts[i].y - pts[i - k].y, pts[i].x - pts[i - k].x)
    const a2 = Math.atan2(pts[i + k].y - pts[i].y, pts[i + k].x - pts[i].x)
    let d = Math.abs(a2 - a1)
    if (d > Math.PI) d = 2 * Math.PI - d
    if (d > (55 * Math.PI) / 180) corner[i] = true
  }
  const maxShift = MAX_SMOOTH_SHIFT_PX / px
  const W = 3 // points each side
  const out = pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1 || corner[i]) return p
    let sx = 0
    let sy = 0
    let sw = 0
    for (let j = -W; j <= W; j++) {
      const q = pts[i + j]
      if (!q) continue
      // don't average across a corner
      const lo = Math.min(i, i + j)
      const hi = Math.max(i, i + j)
      let crosses = false
      for (let c = lo + 1; c < hi; c++) if (corner[c]) crosses = true
      if (crosses) continue
      const w = W + 1 - Math.abs(j)
      sx += q.x * w
      sy += q.y * w
      sw += w
    }
    let nx = sx / sw
    let ny = sy / sw
    const shift = Math.hypot(nx - p.x, ny - p.y)
    if (shift > maxShift) {
      nx = p.x + ((nx - p.x) * maxShift) / shift
      ny = p.y + ((ny - p.y) * maxShift) / shift
    }
    return { x: nx, y: ny, z: p.z }
  })
  return out
}

/** Evenly spaced copy of the stroke (pressure carried along). */
function resample(pts: P[], step: number): P[] {
  const out: P[] = [pts[0]]
  let carry = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const d = dist(a, b)
    if (!d) continue
    let t = step - carry
    while (t <= d) {
      const f = t / d
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f })
      t += step
    }
    carry = d - (t - step)
  }
  const last = pts[pts.length - 1]
  if (dist(out[out.length - 1], last) > step * 0.3) out.push(last)
  else out[out.length - 1] = last
  return out
}

/**
 * 3. Clean up a letter or symbol: split the stroke at its corners, pull each piece toward a clean
 * version (a straight line if it's nearly straight, otherwise a smooth curve), and blend that with
 * the original so it's tidier but still the student's hand. Corners stay exactly where they were.
 */
function beautify(input: P[], px: number, mult = 1): P[] | null {
  const L0 = pathLength(input)
  if (L0 * px < SMOOTH_MIN_PX || input.length < 5) return null
  const step = Math.max(1.5 / px, L0 / 400)
  const pts = resample(input, step)
  const n = pts.length
  if (n < 6) return null
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const D = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  // big drawings (graphs, diagrams) only get gentle treatment; handwriting gets the full clean-up
  const big = D * px > 160
  // corners: sharp turns over a short distance
  const k = Math.max(2, Math.round((0.05 * L0) / step))
  const turn = new Array(n).fill(0)
  for (let i = k; i < n - k; i++) {
    const a1 = Math.atan2(pts[i].y - pts[i - k].y, pts[i].x - pts[i - k].x)
    const a2 = Math.atan2(pts[i + k].y - pts[i].y, pts[i + k].x - pts[i].x)
    let d = Math.abs(a2 - a1)
    if (d > Math.PI) d = 2 * Math.PI - d
    turn[i] = d
  }
  const cut = [0]
  for (let i = k; i < n - k; i++) {
    if (turn[i] < (55 * Math.PI) / 180) continue
    let isMax = true
    for (let j = i - k; j <= i + k; j++) if (turn[j] > turn[i] || (turn[j] === turn[i] && j < i)) isMax = false
    if (isMax && i - cut[cut.length - 1] >= k) cut.push(i)
  }
  if (n - 1 - cut[cut.length - 1] < k && cut.length > 1) cut.pop()
  cut.push(n - 1)
  const target = pts.map((p) => ({ ...p }))
  for (let c = 0; c < cut.length - 1; c++) {
    const s = cut[c]
    const e = cut[c + 1]
    if (e - s < 2) continue
    const a = pts[s]
    const b = pts[e]
    const chord = dist(a, b)
    let maxPos = 0
    let maxNeg = 0
    for (let i = s; i <= e; i++) {
      const d = perp(pts[i], a, b)
      maxPos = Math.max(maxPos, d)
      maxNeg = Math.max(maxNeg, -d)
    }
    const r = Math.max(maxPos, maxNeg) / (chord || 1)
    const bow = Math.min(maxPos, maxNeg) < 0.25 * Math.max(maxPos, maxNeg)
    const straight = chord * px >= 6 && (bow ? r <= (big ? 0.01 : 0.045) : r <= (big ? 0.03 : 0.08))
    if (straight) {
      for (let i = s; i <= e; i++) {
        const t = (i - s) / (e - s)
        target[i] = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: pts[i].z }
      }
    } else {
      // a smooth curve through the piece: gaussian smoothing with its ends pinned
      const sigma = Math.max(1.5, ((big ? 0.025 : 0.07) * (e - s)) / 1)
      const R = Math.ceil(sigma * 2.5)
      for (let i = s + 1; i < e; i++) {
        let sx = 0
        let sy = 0
        let sw = 0
        const r2 = Math.min(R, i - s, e - i) // shrink near the ends so they stay put
        for (let j = -r2; j <= r2; j++) {
          const w = Math.exp((-j * j) / (2 * sigma * sigma))
          sx += pts[i + j].x * w
          sy += pts[i + j].y * w
          sw += w
        }
        target[i] = { x: sx / sw, y: sy / sw, z: pts[i].z }
      }
    }
  }
  // blend toward the clean version, never moving any point too far
  const amount = Math.min(0.95, (big ? 0.5 : 0.7) * mult)
  const maxShift = Math.max(MAX_SMOOTH_SHIFT_PX / px, (big ? 0.015 : 0.06) * D * mult)
  return pts.map((p, i) => {
    let dx = (target[i].x - p.x) * amount
    let dy = (target[i].y - p.y) * amount
    const m = Math.hypot(dx, dy)
    if (m > maxShift) {
      dx *= maxShift / m
      dy *= maxShift / m
    }
    return { x: p.x + dx, y: p.y + dy, z: p.z }
  })
}

/** `mult` scales how strongly to correct: below 1 for slow, careful strokes, above 1 for quick ones. */
export function neatenPoints(pts: P[], px: number, mult = 1): P[] | null {
  const line = straighten(pts, px, mult)
  if (line) return line
  const closed = closeLoop(pts, px) ?? pts
  return beautify(closed, px, mult) ?? (closed !== pts ? closed : steady(pts, px))
}

/**
 * How strongly to correct a stroke, from how fast it was drawn: a quick stroke is likely rougher
 * than intended (correct more), a slow one is probably close to what was meant (correct less).
 * speed is in screen px per ms.
 */
function speedMult(speed: number | null) {
  if (speed === null || !Number.isFinite(speed)) return 1
  const s = Math.max(0, Math.min(1, (speed - 0.15) / (0.9 - 0.15)))
  return 0.6 + 0.8 * s
}

/**
 * The student's typical way of writing `ch` (the sample most like their other samples of it),
 * neatened: the target letters are pulled toward. Cached per set of samples.
 */
const cleanCache = new Map<string, Glyph | null>()
function cleanSample(ch: string, samples: Glyph[]): Glyph | null {
  // the approved clean version of the character, when there is one, is always the target
  const basis = samples.find((s) => s.ch === ch && (s as { basis?: boolean }).basis)
  if (basis) return basis
  const own = samples.filter((s) => s.ch === ch)
  const key = ch + '|' + own.map((s) => (s as { id?: string }).id ?? s.strokes.length).join(',')
  if (cleanCache.has(key)) return cleanCache.get(key)!
  let pick = own[0]
  if (own.length > 2) {
    // the medoid: closest on average to the other samples
    let best = Infinity
    for (const s of own) {
      const d = own.reduce((sum, o) => (o === s ? sum : sum + (recognize(o.strokes, [s])?.score ?? 99)), 0)
      if (d < best) {
        best = d
        pick = s
      }
    }
  }
  let out: Glyph | null = null
  if (pick) {
    const all = pick.strokes.flat()
    const size = Math.max(Math.max(...all.map((p) => p.x)) - Math.min(...all.map((p) => p.x)), Math.max(...all.map((p) => p.y)) - Math.min(...all.map((p) => p.y))) || 1
    const px = 60 / size // judge it as if written at ordinary size on screen
    out = { ch, strokes: pick.strokes.map((st) => neatenPoints(st.map((p) => ({ ...p, z: 0.5 })), px, 1.2) ?? st) }
  }
  cleanCache.set(key, out)
  return out
}

type Box = { minX: number; minY: number; maxX: number; maxY: number }
type Pending = { ids: TLShapeId[]; box: Box; mult: number[]; timer: ReturnType<typeof setTimeout> | null }
const MORPH: Record<MatchStrength, number> = { light: 0.3, medium: 0.5, strong: 0.85, full: 1 }
const STRETCHY = new Set(['√', '−', '-', '=', '(', ')', '[', ']', '∫', '/', '|'])
const GROUP_MS = 700 // a character's strokes come this close together; after a pause it's finished

function pagePoints(s: TLDrawShape): P[] {
  const seg = s.props.segments[0]
  const sx = s.props.scaleX ?? 1
  const sy = s.props.scaleY ?? 1
  return (b64Vecs.decodePoints(seg.path, seg.dim) as P[]).map((p) => ({ x: s.x + p.x * sx, y: s.y + p.y * sy, z: p.z }))
}
function boxOf(pts: P[]): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return { minX, minY, maxX, maxY }
}

/** Does a new stroke belong to the character being written (f's bar, i's dot, the second line of =)? */
function joins(g: Box, b: Box) {
  const gw = g.maxX - g.minX
  const gh = g.maxY - g.minY
  const w = b.maxX - b.minX
  const h = b.maxY - b.minY
  const overlapX = Math.min(g.maxX, b.maxX) - Math.max(g.minX, b.minX)
  const cx = (b.minX + b.maxX) / 2
  const near = Math.abs((b.minY + b.maxY) / 2 - (g.minY + g.maxY) / 2) < 1.2 * Math.max(gh, h)
  const small = w < 0.4 * Math.max(gh, gw) && h < 0.4 * Math.max(gh, gw) // a dot or small mark
  return near && (overlapX > 0.3 * Math.min(w, gw) || (small && cx > g.minX - 0.3 * gw && cx < g.maxX + 0.3 * gw))
}

export type NeatenOptions = { on: boolean; match: boolean; strength: MatchStrength; samples: Glyph[] }

/** Neatens each pen stroke as it's finished; with matching on, also tidies whole characters toward the recognised one. */
/** Record what letter matching saw and decided (on the server), to review its mistakes later. */
function logMatch(strokes: { x: number; y: number }[][], m: ReturnType<typeof recognize>, before: string, strength: MatchStrength) {
  const r = (n: number) => Math.round(n * 10) / 10
  const entry = {
    strokes: strokes.map((st) => st.map((p) => ({ x: r(p.x), y: r(p.y) }))),
    ch: m?.glyph.ch ?? null,
    basis: !!(m?.glyph as { basis?: boolean } | undefined)?.basis,
    score: m ? r(m.score * 100) / 100 : null,
    runnerUp: m?.runnerUp ?? null,
    runnerScore: m ? r(m.runnerScore * 100) / 100 : null,
    applied: confident(m) && !STRETCHY.has(m.glyph.ch),
    before,
    strength,
  }
  fetch('/api/handwriting-log', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) }).catch(() => {})
}

export function useNeatening(editor: Editor | null, opts: NeatenOptions) {
  const { on, match, strength, samples } = opts
  useEffect(() => {
    if (!editor || (!on && !match)) return
    let downAt = 0
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element && e.target.closest('.tl-canvas'))) return
      downAt = performance.now()
      // writing again: hold the pending character open until this stroke ends (it may be its next part)
      if (pending?.timer) {
        clearTimeout(pending.timer)
        pending.timer = null
      }
    }
    window.addEventListener('pointerdown', onDown, { capture: true })
    // recently recognised characters, for context (what's to the left on the same line)
    const recent: { ch: string; box: Box; at: number }[] = []
    let pending: Pending | null = null

    const before = (b: Box): string => {
      const h = b.maxY - b.minY
      let out = ''
      let edge = b
      for (let n = 0; n < 6; n++) {
        const left = recent
          .filter((r) => Date.now() - r.at < 5 * 60_000 && r.box.maxX <= edge.minX + 0.2 * h && edge.minX - r.box.maxX < 1.3 * h)
          .filter((r) => Math.abs((r.box.minY + r.box.maxY) / 2 - (edge.minY + edge.maxY) / 2) < 0.8 * h)
          .sort((p, q) => q.box.maxX - p.box.maxX)[0]
        if (!left) break
        // a wide gap ends the word
        if (n === 0 || edge.minX - left.box.maxX < 0.6 * h) out = left.ch + out
        else break
        edge = left.box
      }
      return out
    }

    const flush = () => {
      const g = pending
      pending = null
      if (!g) return
      if (g.timer) clearTimeout(g.timer)
      if (!match || !samples.length) return
      const shapes = g.ids.map((id) => editor.getShape<TLDrawShape>(id)).filter((s): s is TLDrawShape => !!s && s.type === 'draw')
      if (!shapes.length) return
      const strokes = shapes.map(pagePoints)
      const word = before(g.box)
      const m = recognize(strokes, samples, contextPrior(word))
      logMatch(strokes, m, word, strength)
      if (!confident(m)) return
      recent.push({ ch: m.glyph.ch, box: g.box, at: Date.now() })
      if (recent.length > 80) recent.shift()
      // symbols that stretch to fit what's around them (a √'s bar, = and −, brackets, ∫) have no fixed
      // shape to pull toward; ordinary neatening already straightens their lines at any length
      if (STRETCHY.has(m.glyph.ch)) return
      // pull toward a cleaned-up version of how the student writes this character (never a generic shape,
      // which can be a different form of the letter, e.g. a round "a" for someone who writes a pointed one)
      const target = cleanSample(m.glyph.ch, samples)
      if (!target) return
      const mult = g.mult.reduce((a, b) => a + b, 0) / g.mult.length
      // full: exactly the clean shape, however the stroke was drawn
      const amount = strength === 'full' ? 1 : Math.min(0.95, MORPH[strength] * mult)
      const morphed = morphToward(strokes, target, amount)
      editor.run(
        () => {
          editor.updateShapes(
            shapes.map((s, i) => {
              const sx = s.props.scaleX ?? 1
              const sy = s.props.scaleY ?? 1
              const seg = s.props.segments[0]
              const local = morphed[i].map((p) => ({ x: (p.x - s.x) / sx, y: (p.y - s.y) / sy, z: p.z }))
              return { id: s.id, type: 'draw' as const, props: { segments: [{ ...seg, path: b64Vecs.encodePoints(local as VecModel[], seg.dim) }] } }
            }),
          )
        },
        { history: 'ignore' },
      )
    }

    const stop = editor.sideEffects.registerAfterChangeHandler('shape', (prev, next, source) => {
      if (source !== 'user' || next.type !== 'draw') return
      const beforeShape = prev as TLDrawShape
      const s = next as TLDrawShape
      if (beforeShape.props.isComplete || !s.props.isComplete) return
      if (s.props.segments.length !== 1 || s.props.segments[0].type !== 'free' || s.props.isClosed) return
      if ((s.meta as { ai?: string })?.ai) return
      try {
        const seg = s.props.segments[0]
        const pts = b64Vecs.decodePoints(seg.path, seg.dim) as P[]
        const px = (s.props.scaleX ?? 1) * editor.getZoomLevel()
        const ms = downAt ? performance.now() - downAt : 0
        const mult = speedMult(ms > 30 ? (pathLength(pts) * px) / ms : null)
        if (on) {
          const neat = neatenPoints(pts, px, mult)
          if (neat && neat.length >= 2)
            editor.updateShape<TLDrawShape>({
              id: s.id,
              type: 'draw',
              props: { segments: [{ ...seg, path: b64Vecs.encodePoints(neat as VecModel[], seg.dim) }] },
            })
        }
        if (match) {
          const box = boxOf(pagePoints(editor.getShape<TLDrawShape>(s.id) ?? s))
          if (pending && pending.ids.length < 4 && joins(pending.box, box)) {
            pending.ids.push(s.id)
            pending.mult.push(mult)
            pending.box = { minX: Math.min(pending.box.minX, box.minX), minY: Math.min(pending.box.minY, box.minY), maxX: Math.max(pending.box.maxX, box.maxX), maxY: Math.max(pending.box.maxY, box.maxY) }
          } else {
            flush()
            pending = { ids: [s.id], box, mult: [mult], timer: null }
          }
          if (pending.timer) clearTimeout(pending.timer)
          // after a pause, the character is done (unless the pen is down again)
          pending.timer = setTimeout(() => editor.run(flush), GROUP_MS)
        }
      } catch (e) {
        console.warn('neatening skipped', e)
      }
    })
    return () => {
      stop()
      if (pending?.timer) clearTimeout(pending.timer)
      window.removeEventListener('pointerdown', onDown, { capture: true })
    }
  }, [editor, on, match, strength, samples])
}
