// Reference shapes for letter/number/symbol matching (handwriting-style, not a font).
// Coordinates: y grows down; ascender/cap top 0, x-height 0.45, baseline 1, descender 1.4.
// Stroke order, count and direction don't matter to the recognizer (it compares point clouds),
// so each glyph is just the set of lines that make it up.

type Pt = { x: number; y: number }
type Stroke = Pt[]
export type Glyph = { ch: string; strokes: Stroke[] }

const STEPS = 24
const line = (x1: number, y1: number, x2: number, y2: number): Stroke => Array.from({ length: STEPS + 1 }, (_, i) => ({ x: x1 + ((x2 - x1) * i) / STEPS, y: y1 + ((y2 - y1) * i) / STEPS }))
/** Elliptical arc; angles in degrees, 0 = right, 90 = down (screen coordinates). */
const arc = (cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): Stroke => {
  const n = Math.max(8, Math.round((Math.abs(a1 - a0) / 360) * 48))
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180
    return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }
  })
}
const ell = (cx: number, cy: number, rx: number, ry: number) => arc(cx, cy, rx, ry, 0, 360)
/** Quadratic curve p0 → p2 bending toward p1. */
const bez = (p0: [number, number], p1: [number, number], p2: [number, number]): Stroke =>
  Array.from({ length: STEPS + 1 }, (_, i) => {
    const t = i / STEPS
    const u = 1 - t
    return { x: u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], y: u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1] }
  })
const seq = (...parts: Stroke[]): Stroke => parts.flat()
const dot = (x: number, y: number) => line(x, y - 0.01, x, y + 0.01)

const g = (ch: string, ...strokes: Stroke[]): Glyph => ({ ch, strokes })

export const GLYPHS: Glyph[] = [
  // digits
  g('0', ell(0.25, 0.5, 0.25, 0.5)),
  g('1', seq(line(0.05, 0.2, 0.25, 0), line(0.25, 0, 0.25, 1))),
  g('2', seq(arc(0.25, 0.28, 0.25, 0.26, 200, 380), line(0.49, 0.37, 0, 1), line(0, 1, 0.55, 1))),
  g('3', seq(arc(0.25, 0.25, 0.24, 0.25, 200, 450), arc(0.25, 0.75, 0.27, 0.25, 270, 520))),
  g('4', seq(line(0.4, 0, 0, 0.68), line(0, 0.68, 0.58, 0.68)), line(0.42, 0.3, 0.42, 1)),
  g('5', seq(line(0.5, 0, 0.08, 0), line(0.08, 0, 0.06, 0.45), arc(0.25, 0.7, 0.27, 0.3, 235, 520))),
  g('6', seq(bez([0.45, 0.02], [0, 0.2], [0.02, 0.72]), arc(0.26, 0.73, 0.24, 0.27, 180, 540))),
  g('7', seq(line(0, 0, 0.55, 0), line(0.55, 0, 0.18, 1))),
  g('8', ell(0.25, 0.24, 0.21, 0.24), ell(0.25, 0.74, 0.25, 0.26)),
  g('9', ell(0.25, 0.27, 0.24, 0.27), line(0.49, 0.27, 0.42, 1)),
  // lowercase
  g('a', ell(0.22, 0.73, 0.22, 0.27), line(0.45, 0.46, 0.45, 1)),
  g('b', line(0, 0, 0, 1), ell(0.24, 0.73, 0.24, 0.27)),
  g('c', arc(0.24, 0.73, 0.24, 0.27, 320, 40)),
  g('d', ell(0.24, 0.73, 0.24, 0.27), line(0.48, 0, 0.48, 1)),
  g('e', seq(line(0.02, 0.72, 0.47, 0.72), arc(0.245, 0.73, 0.235, 0.27, 360, 45))),
  g('f', seq(bez([0.45, 0.05], [0.22, -0.06], [0.22, 0.22]), line(0.22, 0.22, 0.22, 1)), line(0.02, 0.46, 0.42, 0.46)),
  g('g', ell(0.22, 0.72, 0.22, 0.27), seq(line(0.45, 0.46, 0.45, 1.2), bez([0.45, 1.2], [0.42, 1.42], [0.04, 1.3]))),
  g('h', line(0, 0, 0, 1), seq(bez([0, 0.62], [0.22, 0.4], [0.42, 0.56]), line(0.43, 0.58, 0.43, 1))),
  g('i', line(0.1, 0.46, 0.1, 1), dot(0.1, 0.26)),
  g('j', seq(line(0.25, 0.46, 0.25, 1.2), bez([0.25, 1.2], [0.22, 1.42], [0, 1.3])), dot(0.25, 0.26)),
  g('k', line(0, 0, 0, 1), seq(line(0.42, 0.45, 0.02, 0.75), line(0.02, 0.75, 0.45, 1))),
  g('l', line(0, 0, 0, 1)),
  g('/', line(0.6, 0, 0, 1)),
  g('m', line(0, 0.46, 0, 1), seq(bez([0, 0.6], [0.14, 0.42], [0.27, 0.56]), line(0.27, 0.56, 0.27, 1)), seq(bez([0.27, 0.6], [0.42, 0.42], [0.55, 0.56]), line(0.55, 0.56, 0.55, 1))),
  g('n', line(0, 0.46, 0, 1), seq(bez([0, 0.62], [0.2, 0.4], [0.4, 0.56]), line(0.41, 0.58, 0.41, 1))),
  g('o', ell(0.23, 0.73, 0.23, 0.27)),
  g('p', line(0, 0.46, 0, 1.4), ell(0.24, 0.73, 0.24, 0.27)),
  g('q', ell(0.22, 0.73, 0.22, 0.27), line(0.45, 0.46, 0.45, 1.4)),
  g('r', line(0, 0.46, 0, 1), bez([0, 0.66], [0.12, 0.45], [0.36, 0.48])),
  g('s', seq(bez([0.42, 0.5], [0.25, 0.4], [0.05, 0.52]), bez([0.05, 0.52], [0, 0.68], [0.22, 0.73]), bez([0.22, 0.73], [0.47, 0.8], [0.4, 0.94]), bez([0.4, 0.94], [0.25, 1.05], [0, 0.95]))),
  g('t', line(0.18, 0.1, 0.18, 1), line(0, 0.45, 0.38, 0.45)),
  g('u', seq(line(0, 0.46, 0, 0.8), bez([0, 0.8], [0.03, 1.02], [0.22, 1]), bez([0.22, 1], [0.42, 0.97], [0.43, 0.75])), line(0.43, 0.46, 0.43, 1)),
  g('v', seq(line(0, 0.46, 0.22, 1), line(0.22, 1, 0.44, 0.46))),
  g('w', seq(line(0, 0.46, 0.15, 1), line(0.15, 1, 0.3, 0.6), line(0.3, 0.6, 0.45, 1), line(0.45, 1, 0.6, 0.46))),
  g('x', line(0, 0.46, 0.44, 1), line(0.44, 0.46, 0, 1)),
  g('y', line(0, 0.46, 0.22, 1), line(0.44, 0.46, 0.1, 1.4)),
  g('z', seq(line(0, 0.46, 0.42, 0.46), line(0.42, 0.46, 0, 1), line(0, 1, 0.44, 1))),
  // capitals that differ from their lowercase shapes
  g('A', seq(line(0, 1, 0.3, 0), line(0.3, 0, 0.6, 1)), line(0.12, 0.62, 0.48, 0.62)),
  g('B', line(0, 0, 0, 1), seq(bez([0, 0], [0.5, -0.02], [0.45, 0.25]), bez([0.45, 0.25], [0.42, 0.48], [0, 0.48]), bez([0, 0.48], [0.6, 0.48], [0.5, 0.78]), bez([0.5, 0.78], [0.42, 1.02], [0, 1]))),
  g('D', line(0, 0, 0, 1), seq(bez([0, 0], [0.62, 0], [0.6, 0.5]), bez([0.6, 0.5], [0.62, 1], [0, 1]))),
  g('E', line(0, 0, 0, 1), line(0, 0, 0.45, 0), line(0, 0.5, 0.38, 0.5), line(0, 1, 0.45, 1)),
  g('F', line(0, 0, 0, 1), line(0, 0, 0.45, 0), line(0, 0.5, 0.38, 0.5)),
  g('G', seq(arc(0.35, 0.5, 0.35, 0.5, 315, 30), line(0.65, 0.68, 0.65, 0.55), line(0.65, 0.55, 0.4, 0.55))),
  g('H', line(0, 0, 0, 1), line(0.5, 0, 0.5, 1), line(0, 0.5, 0.5, 0.5)),
  g('J', seq(line(0.35, 0, 0.35, 0.75), bez([0.35, 0.75], [0.35, 1.02], [0.15, 1]), bez([0.15, 1], [0, 0.98], [0, 0.8]))),
  g('K', line(0, 0, 0, 1), line(0.5, 0, 0, 0.55), line(0.15, 0.4, 0.52, 1)),
  g('L', seq(line(0, 0, 0, 1), line(0, 1, 0.42, 1))),
  g('M', seq(line(0, 1, 0.05, 0), line(0.05, 0, 0.33, 0.65), line(0.33, 0.65, 0.6, 0), line(0.6, 0, 0.65, 1))),
  g('N', seq(line(0, 1, 0, 0), line(0, 0, 0.5, 1), line(0.5, 1, 0.5, 0))),
  g('P', line(0, 0, 0, 1), seq(bez([0, 0], [0.55, -0.02], [0.48, 0.27]), bez([0.48, 0.27], [0.42, 0.53], [0, 0.52]))),
  g('Q', ell(0.33, 0.5, 0.33, 0.5), line(0.42, 0.75, 0.7, 1.05)),
  g('R', line(0, 0, 0, 1), seq(bez([0, 0], [0.55, -0.02], [0.48, 0.27]), bez([0.48, 0.27], [0.42, 0.53], [0, 0.52])), line(0.15, 0.52, 0.5, 1)),
  g('T', line(0, 0, 0.6, 0), line(0.3, 0, 0.3, 1)),
  g('U', seq(line(0, 0, 0, 0.7), bez([0, 0.7], [0.02, 1.02], [0.25, 1]), bez([0.25, 1], [0.5, 0.98], [0.5, 0.7]), line(0.5, 0.7, 0.5, 0))),
  g('Y', line(0, 0, 0.27, 0.5), seq(line(0.55, 0, 0.27, 0.5), line(0.27, 0.5, 0.27, 1))),
  // math
  g('+', line(0, 0.5, 1, 0.5), line(0.5, 0, 0.5, 1)),
  g('=', line(0, 0.35, 1, 0.35), line(0, 0.65, 1, 0.65)),
  g('÷', line(0, 0.5, 1, 0.5), dot(0.5, 0.15), dot(0.5, 0.85)),
  g('(', arc(1, 0.5, 0.75, 0.55, 245, 115)),
  g(')', arc(0, 0.5, 0.75, 0.55, -65, 65)),
  g('<', seq(line(0.6, 0, 0, 0.5), line(0, 0.5, 0.6, 1))),
  g('>', seq(line(0, 0, 0.6, 0.5), line(0.6, 0.5, 0, 1))),
  g('√', seq(line(0, 0.6, 0.15, 0.5), line(0.15, 0.5, 0.35, 1), line(0.35, 1, 0.55, 0), line(0.55, 0, 1.2, 0))),
  g('π', line(0, 0.1, 0.75, 0.1), line(0.22, 0.1, 0.18, 1), line(0.52, 0.1, 0.55, 1)),
  g('θ', ell(0.25, 0.5, 0.25, 0.5), line(0.02, 0.5, 0.48, 0.5)),
  g('Δ', seq(line(0.3, 0, 0, 1), line(0, 1, 0.6, 1), line(0.6, 1, 0.3, 0))),
  g('∫', seq(bez([0.42, 0.05], [0.3, -0.05], [0.25, 0.15]), line(0.25, 0.15, 0.2, 0.85), bez([0.2, 0.85], [0.15, 1.05], [0, 0.95]))),
  g('∞', ell(0.25, 0.5, 0.25, 0.22), ell(0.75, 0.5, 0.25, 0.22)),
]

/** Glyphs that are effectively the same shape (matching one of them for another is fine). */
export const SAME_SHAPE: string[][] = [
  ['0', 'o', 'O'],
  ['1', 'l', 'I', '|'],
  ['c', 'C'],
  ['s', 'S'],
  ['u', 'U'],
  ['v', 'V'],
  ['w', 'W'],
  ['x', 'X', '×'],
  ['z', 'Z'],
]
