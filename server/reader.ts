// Reads handwriting into text or LaTeX with Claude vision (for converting ink as the student writes).
// One long-lived Claude Code session, so each read skips the startup cost; it's restarted every so
// often so the conversation (one image per read) doesn't grow without bound.
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { mkdirSync } from 'node:fs'
import { AsyncQueue } from './tutor.ts'

export type Reading = { kind: 'math' | 'text' | 'drawing'; value: string; alternatives: string[] }

const MODEL = 'sonnet'
const READS_PER_SESSION = 20

const PROMPT = `You transcribe handwriting from a student's class notes. Each message is an image of ink just written with a pen or mouse (dark strokes on white), sometimes with a hint about the class. Reply with ONLY a JSON object, no other text:
{"kind": "math" | "text" | "drawing", "value": "...", "alternatives": ["..."]}

- "math": anything with mathematical notation: equations, expressions, numbers with operators, Greek letters, integrals, limits, sums, products, fractions, roots, exponents, subscripts, vectors, arrows, set or logic symbols. "value" is LaTeX (no $ delimiters) that typesets like what was written and keeps its 2D layout: limits under \\lim, bounds on \\int, \\sum and \\prod, fractions as \\frac, exponents and subscripts where they were written. Words mixed into math go in \\text{...}. Several lines: \\begin{aligned} ... \\end{aligned} with \\\\ between lines.
- "text": ordinary words and sentences with no math notation. "value" is the plain text; separate lines with \\n.
- "drawing": a graph, diagram, sketch, lone arrow, box, underline or scribble that isn't writing. "value" is "".

"alternatives": up to 3 other plausible readings, as complete values of the same kind, most likely first, when part of it is ambiguous (2 vs z, 1 vs l vs |, 0 vs o, x vs ×, u vs μ, n vs η, v vs ν, t vs +, 5 vs s, a missing or extra exponent). [] when the reading is clear.

Transcribe exactly what is written, including mistakes, unfinished expressions and odd notation. Never solve, simplify, correct or complete anything.`

class Reader {
  private q: Query | null = null
  private queue: AsyncQueue<SDKUserMessage> | null = null
  private waiting: { resolve: (text: string) => void; reject: (e: Error) => void } | null = null
  private reads = 0
  private chain: Promise<unknown> = Promise.resolve()

  private workDir: string

  constructor(workDir: string) {
    this.workDir = workDir
    mkdirSync(workDir, { recursive: true })
  }

  private start() {
    this.close()
    const queue = new AsyncQueue<SDKUserMessage>()
    const q = query({
      prompt: queue,
      options: {
        systemPrompt: PROMPT,
        model: MODEL,
        effort: 'low',
        tools: [],
        permissionMode: 'dontAsk',
        settingSources: [],
        cwd: this.workDir,
        persistSession: false,
        stderr: (d) => console.error('[reader]', d.trimEnd()),
      },
    })
    this.q = q
    this.queue = queue
    this.reads = 0
    void (async () => {
      try {
        for await (const m of q) {
          if (m.type !== 'result') continue
          const w = this.waiting
          this.waiting = null
          if (m.subtype === 'success') w?.resolve(m.result)
          else w?.reject(new Error(`Reading stopped early (${m.subtype})`))
        }
      } catch (e) {
        if (this.q === q) console.error('[reader] session error', e)
      }
      if (this.q === q) {
        this.q = null
        this.queue = null
      }
      this.waiting?.reject(new Error('The handwriting reader stopped unexpectedly'))
      this.waiting = null
    })()
  }

  close() {
    this.queue?.close()
    try {
      this.q?.close()
    } catch {}
    this.q = null
    this.queue = null
  }

  /** Warm up Claude Code so the first read is quick. */
  warm() {
    if (!this.q) this.start()
  }

  /** One read at a time: the session answers messages in order. */
  read(image: { data: string; mediaType: string }, hint: string): Promise<Reading> {
    const run = this.chain.then(() => this.readNow(image, hint))
    this.chain = run.catch(() => {})
    return run
  }

  private async readNow(image: { data: string; mediaType: string }, hint: string): Promise<Reading> {
    if (!this.q || this.reads >= READS_PER_SESSION) this.start()
    this.reads++
    const content = [
      { type: 'image' as const, source: { type: 'base64' as const, media_type: image.mediaType as 'image/png', data: image.data } },
      { type: 'text' as const, text: hint ? `Hint: ${hint}` : 'Transcribe this.' },
    ]
    const t0 = Date.now()
    const text = await new Promise<string>((resolve, reject) => {
      this.waiting = { resolve, reject }
      this.queue!.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null })
    })
    const r = parseReading(text)
    console.log(`[reader] ${((Date.now() - t0) / 1000).toFixed(1)}s ${r.kind}: ${JSON.stringify(r.value).slice(0, 120)}`)
    return r
  }
}

export function parseReading(text: string): Reading {
  const json = text.match(/\{[\s\S]*\}/)?.[0]
  if (!json) throw new Error(`Couldn't read the handwriting: ${text.slice(0, 200)}`)
  const o = JSON.parse(json)
  const kind = o.kind === 'math' || o.kind === 'text' ? o.kind : 'drawing'
  const value = typeof o.value === 'string' ? o.value.trim() : ''
  const alternatives = Array.isArray(o.alternatives) ? o.alternatives.filter((a: unknown): a is string => typeof a === 'string' && !!a.trim() && a.trim() !== value).slice(0, 3) : []
  return value ? { kind, value, alternatives } : { kind: 'drawing', value: '', alternatives: [] }
}

let reader: Reader | null = null
export const handwritingReader = (workDir: string) => (reader ??= new Reader(workDir))
