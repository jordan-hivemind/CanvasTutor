// Canvas tools exposed to Claude via an in-process MCP server.
// Handlers don't touch the canvas directly: they turn each call into a CanvasOp that is streamed
// to the browser, which applies it to the tldraw board.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { qalculate, sympy } from './checkers.ts'
import { markdownTools, notesTools, NOTE_TOOL_STATUS, type MdOp, type MdOpResult, type NotesAccess } from './noteTools.ts'
import { COLOR_NAMES, cleanSvg, hex, renderLatex, renderPaths, renderPlot, renderPlot3D } from './svg.ts'

export type CanvasOp =
  | { op: 'text'; id: string; x: number; y: number; text: string; color: string; size: string; w?: number }
  | { op: 'svg'; id: string; x: number; y: number; w: number; h: number; svg: string; label: string }
  | { op: 'plot3d'; id: string; x: number; y: number; w: number; h: number; spec: string; azimuth: number; elevation: number; label: string }
  | { op: 'geo'; id: string; geo: string; x: number; y: number; w: number; h: number; color: string; fill: string; dash: string; opacity: number; label?: string; size: string }
  | { op: 'arrow'; id: string; x1: number; y1: number; x2: number; y2: number; color: string; label?: string; bend: number }
  | { op: 'erase'; ids: string[] | 'all' }
  | { op: 'view'; x: number; y: number; w: number; h: number }

export type ToolEmitter = (op: CanvasOp, status: string) => void
export type BoardView = { image: { data: string; mediaType: string }; context: string }
/** What to capture: the student's view (default), the whole page, or a region in board coordinates. */
export type SnapRegion = 'page' | { x: number; y: number; w: number; h: number } | { note: string }
export type ViewBounds = { minX: number; minY: number; maxX: number; maxY: number }
export type ToolContext = {
  emit: ToolEmitter
  status: (s: string) => void
  snapshot: (region?: SnapRegion) => Promise<BoardView>
  view: ViewBounds | null
  mdOp: (op: MdOp) => Promise<MdOpResult>
  access: NotesAccess
}

const TEXT_PX: Record<string, number> = { s: 18, m: 24, l: 36, xl: 44 }

function offscreenWarning(op: CanvasOp, v: ViewBounds | null): string {
  if (!v) return ''
  let b: { x: number; y: number; w: number; h: number } | null = null
  if (op.op === 'text') {
    const px = TEXT_PX[op.size] ?? 24
    const lines = op.text.split('\n')
    const w = op.w ?? Math.max(...lines.map((l) => l.length)) * px * 0.55
    b = { x: op.x, y: op.y, w, h: lines.length * px * 1.35 }
  } else if (op.op === 'svg' || op.op === 'geo' || op.op === 'plot3d') b = { x: op.x, y: op.y, w: op.w, h: op.h }
  else if (op.op === 'arrow') b = { x: Math.min(op.x1, op.x2), y: Math.min(op.y1, op.y2), w: Math.abs(op.x2 - op.x1), h: Math.abs(op.y2 - op.y1) }
  if (!b) return ''
  const tol = 4
  if (b.x >= v.minX - tol && b.y >= v.minY - tol && b.x + b.w <= v.maxX + tol && b.y + b.h <= v.maxY + tol) return ''
  const r = (n: number) => Math.round(n)
  const where = `(view x=${r(v.minX)}..${r(v.maxX)}, y=${r(v.minY)}..${r(v.maxY)}; this item x=${r(b.x)}..${r(b.x + b.w)}, y=${r(b.y)}..${r(b.y + b.h)})`
  // marks point at something the student is looking at, so off-screen is probably a mistake;
  // new content may go anywhere: the student's view follows it at the end of the turn
  const isMark = op.op === 'arrow' || (op.op === 'geo' && (op.opacity < 1 || op.dash === 'draw')) // highlight or circle
  return isMark
    ? ` — WARNING: this mark extends outside the student's view ${where}. Check it points at the right thing.`
    : ` — note: outside the student's current view ${where}. Their view will pan to show it at the end of your turn (or call move_view to choose the framing).`
}

const color = z.enum(COLOR_NAMES).optional()
const num = z.number()
const newId = () => 'ai-' + randomBytes(5).toString('hex')

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}
function fail(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true }
}

/** Drawing tools only make sense on a canvas note. */
const CANVAS_ONLY = new Set(['look_at_board', 'write_text', 'write_math', 'highlight', 'circle', 'draw_arrow', 'draw_shape', 'draw_lines', 'plot_graph', 'plot_3d', 'draw_svg', 'erase', 'move_view'])

/** The tutor's tools for one note: math checking + notes everywhere; drawing on canvases; editing/commenting on markdown notes. */
export function createTutorServer(getCtx: () => ToolContext | null, kind: 'md' | 'canvas') {
  const ctx = () => {
    const c = getCtx()
    if (!c) throw new Error('No active request')
    return c
  }
  /** Sends the op to the board; returns a warning if it lands outside the student's view. */
  const emit = (op: CanvasOp, status: string): string => {
    const c = ctx()
    c.emit(op, status)
    return offscreenWarning(op, c.view)
  }

  const tools = [
    tool(
      'calculate',
      'Exact/numeric calculation with Qalculate. Pass ALL the expressions you need at once; they are evaluated together and returned in order. Handles arithmetic, units and unit conversion ("3 ft to m", "60 mph to m/s"), physical constants (G, c, h, k_B, N_A, e_charge... ), astronomy (solar_mass, au, lightyear, parsec; planet data as planet(earth; mass), planet(mars; radius)), functions, and equation solving ("solve(x^2 = 2)"). Unknown names are silently read as products of units, so check that each result has the units you expect; if not, rewrite with explicit numbers. Use it for every number you state or write.',
      { expressions: z.array(z.string()).min(1).max(20).describe('e.g. ["sqrt(G*planet(earth; mass)/(6371 km + 400 km)) to km/s", "2*pi*6771 km / (7.67 km/s) to min"]') },
      async (a) => {
        ctx().status('Checking the math')
        const results = await Promise.all(
          a.expressions.map((ex) =>
            qalculate(ex).then(
              (r) => `${ex}  =>  ${r.result}${r.engine === 'Qalculate' ? '' : `  [${r.engine}]`}`,
              (e) => `${ex}  =>  ERROR: ${e instanceof Error ? e.message : e}`,
            ),
          ),
        )
        return ok(results.join('\n'))
      },
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      'sympy',
      'Evaluate SymPy expressions for symbolic math. Pass ALL the expressions you need at once; results come back in order. Examples: diff(f, x), diff(f, x, y) (mixed partials), integrate(f, (x, a, b), (y, c, d)), limit(f, x, 0), solve([eqs], [vars]), series(f, x, 0, 6), simplify(...), factor(...), Matrix([[1,2],[3,4]]).eigenvects(), .det(), .rref(), .inv(), dsolve(...). ^ means power; implicit multiplication like "2x" works. Symbols a–z (except e, i) and Greek names are predefined; E/e is Euler\'s number, I/i is √-1. Each result includes LaTeX, and a decimal when numeric.',
      { expressions: z.array(z.string()).min(1).max(20) },
      async (a) => {
        ctx().status('Checking the math')
        const out: unknown[] = []
        for (const ex of a.expressions) {
          try {
            const r = await sympy.call({ op: 'evaluate', expression: ex })
            out.push(r.ok ? { expression: ex, result: r.result, latex: r.latex, decimal: r.decimal } : { expression: ex, error: r.error })
          } catch (e) {
            out.push({ expression: ex, error: String(e instanceof Error ? e.message : e) })
          }
        }
        return ok(JSON.stringify(out))
      },
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      'check_equal',
      "Check whether pairs of expressions (or equations) are mathematically equivalent, symbolically and with numeric spot checks. Pass ALL pairs at once (e.g. every step of the student's work against the correct version). Same syntax as the sympy tool.",
      { pairs: z.array(z.object({ a: z.string(), b: z.string(), variables: z.array(z.string()).optional() })).min(1).max(20) },
      async (a) => {
        ctx().status('Checking the math')
        const out: unknown[] = []
        for (const p of a.pairs) {
          try {
            const r = await sympy.call({ op: 'check_equal', a: p.a, b: p.b, variables: p.variables ?? null })
            if (!r.ok) out.push({ a: p.a, b: p.b, error: r.error })
            else {
              const { id: _id, ok: _ok, ...rest } = r
              out.push({ a: p.a, b: p.b, ...rest })
            }
          } catch (e) {
            out.push({ a: p.a, b: p.b, error: String(e instanceof Error ? e.message : e) })
          }
        }
        return ok(JSON.stringify(out))
      },
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      'look_at_board',
      "Get a fresh image of the board, including everything you've drawn this turn. By default it shows the student's current view: use it to confirm that highlights, circles and arrows landed on the right thing and that nothing overlaps. To see beyond what the student is looking at (work that seems cut off at the edge, an earlier problem the question refers to, or what's in the [Whole page] area outside the view), pass area: \"page\" for the whole page, or x, y, w, h for a specific region in board coordinates.",
      {
        area: z.enum(['view', 'page']).optional().describe('"view" (default): what the student sees; "page": everything on the page'),
        x: num.optional(),
        y: num.optional(),
        w: num.optional(),
        h: num.optional(),
      },
      async (a) => {
        ctx().status('Looking at the board')
        const region: SnapRegion | undefined =
          a.x !== undefined && a.y !== undefined && a.w && a.h ? { x: a.x, y: a.y, w: a.w, h: a.h } : a.area === 'page' ? 'page' : undefined
        try {
          const v = await ctx().snapshot(region)
          return {
            content: [
              { type: 'image' as const, data: v.image.data, mimeType: v.image.mediaType },
              { type: 'text' as const, text: v.context },
            ],
          }
        } catch (e) {
          return fail(`Couldn't capture the board: ${e instanceof Error ? e.message : e}`)
        }
      },
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      'write_text',
      'Write plain text on the board. (x, y) is the top-left corner. Use write_math for anything with real math notation.',
      {
        x: num,
        y: num,
        text: z.string(),
        color,
        size: z.enum(['s', 'm', 'l', 'xl']).optional().describe('s≈18px, m≈24px, l≈36px, xl≈44px tall letters. Default m.'),
        maxWidth: z.number().optional().describe('Wrap text at this width (board units). Omit for no wrapping.'),
      },
      async (a) => {
        const id = newId()
        const warn = emit({ op: 'text', id, x: a.x, y: a.y, text: a.text, color: a.color ?? 'violet', size: a.size ?? 'm', w: a.maxWidth }, 'Writing on the board')
        return ok(`created ${id}` + warn)
      },
    ),
    tool(
      'write_math',
      'Typeset LaTeX math on the board (rendered with MathJax, display style). (x, y) is the top-left corner. Returns the rendered size.',
      {
        x: num,
        y: num,
        latex: z.string().describe('LaTeX without surrounding $ signs. Use \\begin{aligned}...\\end{aligned} or \\\\ for multiple lines.'),
        color,
        scale: z.number().min(0.3).max(5).optional().describe('1 ≈ 20px body text. Default 1.2.'),
      },
      async (a) => {
        try {
          const r = renderLatex(a.latex, hex(a.color), a.scale ?? 1.2)
          const id = newId()
          const warn = emit({ op: 'svg', id, x: a.x, y: a.y, w: r.w, h: r.h, svg: r.svg, label: `math: ${a.latex}` }, 'Writing math')
          return ok(`created ${id} (${r.w}×${r.h})` + warn)
        } catch (e) {
          return fail(String(e instanceof Error ? e.message : e))
        }
      },
    ),
    tool(
      'highlight',
      'Translucent highlighter box over a region of the board, to point at something the student wrote.',
      { x: num, y: num, w: num, h: num, color },
      async (a) => {
        const id = newId()
        const warn = emit({ op: 'geo', id, geo: 'rectangle', x: a.x, y: a.y, w: a.w, h: a.h, color: a.color ?? 'yellow', fill: 'fill', dash: 'solid', opacity: 0.32, size: 's' }, 'Highlighting')
        return ok(`created ${id}` + warn)
      },
    ),
    tool(
      'circle',
      'Draw an ellipse outline around a region (x, y, w, h is its bounding box) to draw attention to it, e.g. a mistake.',
      { x: num, y: num, w: num, h: num, color },
      async (a) => {
        const id = newId()
        const warn = emit({ op: 'geo', id, geo: 'ellipse', x: a.x, y: a.y, w: a.w, h: a.h, color: a.color ?? 'red', fill: 'none', dash: 'draw', opacity: 1, size: 'm' }, 'Circling')
        return ok(`created ${id}` + warn)
      },
    ),
    tool(
      'draw_arrow',
      'Draw an arrow from (x1, y1) to (x2, y2), optionally with a text label.',
      { x1: num, y1: num, x2: num, y2: num, color, label: z.string().optional(), bend: z.number().optional().describe('Curvature in board units; 0 = straight') },
      async (a) => {
        const id = newId()
        const warn = emit({ op: 'arrow', id, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, color: a.color ?? 'violet', label: a.label, bend: a.bend ?? 0 }, 'Drawing an arrow')
        return ok(`created ${id}` + warn)
      },
    ),
    tool(
      'draw_shape',
      'Draw a basic shape with an optional centred text label (plain text). Good for boxes, diagram nodes, bodies in a free-body diagram, planets, etc.',
      {
        shape: z.enum(['rectangle', 'ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon', 'star', 'cloud', 'oval', 'trapezoid', 'rhombus']),
        x: num,
        y: num,
        w: num,
        h: num,
        color,
        fill: z.enum(['none', 'semi', 'solid']).optional(),
        dashed: z.boolean().optional(),
        label: z.string().optional(),
      },
      async (a) => {
        const id = newId()
        const warn = emit({ op: 'geo', id, geo: a.shape, x: a.x, y: a.y, w: a.w, h: a.h, color: a.color ?? 'violet', fill: a.fill ?? 'none', dash: a.dashed ? 'dashed' : 'solid', opacity: 1, label: a.label, size: 'm' }, 'Drawing a shape')
        return ok(`created ${id}` + warn)
      },
    ),
    tool(
      'draw_lines',
      'Draw one or more polylines/polygons in board coordinates (one combined image). Use for sketches, coordinate axes in a diagram, trajectories, orbits approximated with many points, geometric figures.',
      {
        paths: z
          .array(
            z.object({
              points: z.array(z.tuple([num, num])).min(2),
              closed: z.boolean().optional(),
              color,
              dashed: z.boolean().optional(),
              width: z.number().optional().describe('Stroke width, default 3'),
              arrowEnd: z.boolean().optional(),
            }),
          )
          .min(1),
      },
      async (a) => {
        try {
          const r = renderPaths(a.paths)
          const id = newId()
          const warn = emit({ op: 'svg', id, x: r.x, y: r.y, w: r.w, h: r.h, svg: r.svg, label: 'drawing' }, 'Sketching')
          return ok(`created ${id}` + warn)
        } catch (e) {
          return fail(String(e instanceof Error ? e.message : e))
        }
      },
    ),
    tool(
      'plot_graph',
      'Place a rendered graph on the board in the box (x, y, w, h). Supports y=f(x) functions, parametric curves, points, vectors, contour (level) curves of f(x,y), and 2D vector fields. Expressions use mathjs syntax: x^2, sin(x), exp(-x^2), sqrt(x), log(x) (natural), abs(x), pi, e.',
      {
        x: num,
        y: num,
        w: z.number().min(120).describe('Width on the board, e.g. 400'),
        h: z.number().min(100).describe('Height on the board, e.g. 320'),
        xMin: num,
        xMax: num,
        yMin: num,
        yMax: num,
        title: z.string().optional(),
        xLabel: z.string().optional(),
        yLabel: z.string().optional(),
        functions: z.array(z.object({ expr: z.string().describe('in terms of x'), color, label: z.string().optional(), dashed: z.boolean().optional() })).optional(),
        parametric: z.array(z.object({ x: z.string(), y: z.string(), tMin: num, tMax: num, color, label: z.string().optional(), dashed: z.boolean().optional() })).optional(),
        points: z.array(z.object({ x: num, y: num, label: z.string().optional(), color })).optional(),
        vectors: z.array(z.object({ x0: num.optional(), y0: num.optional(), dx: num, dy: num, color, label: z.string().optional() })).optional(),
        contours: z.object({ expr: z.string().describe('f(x, y)'), levels: z.array(num).min(1), color, labelLevels: z.boolean().optional() }).optional(),
        vectorField: z.object({ p: z.string().describe('x-component P(x,y)'), q: z.string().describe('y-component Q(x,y)'), density: z.number().optional(), color, normalize: z.boolean().optional().describe('Default true: equal-length arrows') }).optional(),
      },
      async (a) => {
        try {
          const r = renderPlot(a)
          const id = newId()
          const warn = emit({ op: 'svg', id, x: a.x, y: a.y, w: r.w, h: r.h, svg: r.svg, label: `graph${a.title ? ': ' + a.title : ''}` }, 'Plotting a graph')
          return ok(`created ${id}` + warn)
        } catch (e) {
          return fail(String(e instanceof Error ? e.message : e))
        }
      },
    ),
    tool(
      'plot_3d',
      'Place a rendered 3D plot (fixed viewpoint, shaded, coloured by height) in the box (x, y, w, h). Supports surfaces z = f(x, y), parametric surfaces (u, v), space curves r(t), 3D points and vectors — e.g. saddle points, tangent planes (add the plane as a second surface with opacity ~0.6 and a solid color), level surfaces, helices with tangent vectors, spheres/cylinders. Same expression syntax as plot_graph. Choose azimuth/elevation so the key feature is visible.',
      {
        x: num,
        y: num,
        w: z.number().min(200).describe('e.g. 460'),
        h: z.number().min(160).describe('e.g. 380'),
        xMin: num,
        xMax: num,
        yMin: num,
        yMax: num,
        zMin: num.optional().describe('Omit to fit the data'),
        zMax: num.optional(),
        azimuth: num.optional().describe('Degrees, rotation about the z-axis. Default -55'),
        elevation: num.optional().describe('Degrees above the xy-plane. Default 28'),
        title: z.string().optional(),
        xLabel: z.string().optional(),
        yLabel: z.string().optional(),
        zLabel: z.string().optional(),
        surfaces: z.array(z.object({ expr: z.string().describe('f(x, y)'), color: z.union([z.enum(COLOR_NAMES), z.literal('height')]).optional(), opacity: z.number().min(0.1).max(1).optional() })).optional(),
        parametricSurfaces: z
          .array(z.object({ x: z.string(), y: z.string(), z: z.string(), uMin: num, uMax: num, vMin: num, vMax: num, color: z.union([z.enum(COLOR_NAMES), z.literal('height')]).optional(), opacity: z.number().min(0.1).max(1).optional() }))
          .optional(),
        curves: z.array(z.object({ x: z.string(), y: z.string(), z: z.string(), tMin: num, tMax: num, color, label: z.string().optional(), dashed: z.boolean().optional() })).optional(),
        points: z.array(z.object({ x: num, y: num, z: num, label: z.string().optional(), color })).optional(),
        vectors: z.array(z.object({ x0: num.optional(), y0: num.optional(), z0: num.optional(), dx: num, dy: num, dz: num, color, label: z.string().optional() })).optional(),
      },
      async (a) => {
        try {
          const r = renderPlot3D(a)
          const id = newId()
          const { x: _x, y: _y, w: _w, h: _h, azimuth, elevation, ...spec } = a
          const warn = emit({ op: 'plot3d', id, x: a.x, y: a.y, w: r.w, h: r.h, spec: JSON.stringify(spec), azimuth: azimuth ?? -55, elevation: elevation ?? 28, label: `3D plot${a.title ? ': ' + a.title : ''} (student can rotate it)` }, 'Plotting in 3D')
          return ok(`created ${id}` + warn)
        } catch (e) {
          return fail(String(e instanceof Error ? e.message : e))
        }
      },
    ),
    tool(
      'draw_svg',
      'Place a custom SVG diagram you write yourself, scaled into the box (x, y, w, h). Use when the other tools cannot express the diagram (e.g. labelled physics or astronomy figures). Include a viewBox. No scripts or external resources.',
      { x: num, y: num, w: num, h: num, svg: z.string() },
      async (a) => {
        try {
          const r = cleanSvg(a.svg, a.w, a.h)
          const id = newId()
          const warn = emit({ op: 'svg', id, x: a.x, y: a.y, w: r.w, h: r.h, svg: r.svg, label: 'diagram' }, 'Drawing a diagram')
          return ok(`created ${id}` + warn)
        } catch (e) {
          return fail(String(e instanceof Error ? e.message : e))
        }
      },
    ),
    tool(
      'erase',
      'Erase things you drew earlier, by id, or "all" to clear all of your marks on this page. Cannot erase the student\'s own writing.',
      { ids: z.union([z.array(z.string()).min(1), z.literal('all')]) },
      async (a) => {
        emit({ op: 'erase', ids: a.ids }, 'Erasing')
        return ok('erased')
      },
    ),
    tool(
      'move_view',
      "Pan/zoom the student's view to show the region (x, y, w, h). Use after writing outside the current view, to frame the new content (ideally together with the work it relates to). If you don't, the view pans to your new content automatically at the end of the turn.",
      { x: num, y: num, w: num, h: num },
      async (a) => {
        emit({ op: 'view', x: a.x, y: a.y, w: a.w, h: a.h }, 'Moving the view')
        return ok('moved')
      },
    ),
  ]

  const all = [
    ...tools.filter((x) => kind === 'canvas' || !CANVAS_ONLY.has(x.name)),
    ...notesTools(getCtx),
    ...(kind === 'md' ? markdownTools(getCtx) : []),
  ]
  return createSdkMcpServer({ name: 'canvas', version: '1.0.0', tools: all, alwaysLoad: true })
}

export const TOOL_STATUS: Record<string, string> = {
  ...NOTE_TOOL_STATUS,
  WebFetch: 'Reading a web page',
  WebSearch: 'Searching the web',
  calculate: 'Checking the math',
  sympy: 'Checking the math',
  check_equal: 'Checking the math',
  look_at_board: 'Looking at the board',
  write_text: 'Writing on the board',
  write_math: 'Writing math',
  highlight: 'Highlighting',
  circle: 'Circling',
  draw_arrow: 'Drawing an arrow',
  draw_shape: 'Drawing a shape',
  draw_lines: 'Sketching',
  plot_graph: 'Plotting a graph',
  plot_3d: 'Plotting in 3D',
  draw_svg: 'Drawing a diagram',
  erase: 'Erasing',
  move_view: 'Moving the view',
}
