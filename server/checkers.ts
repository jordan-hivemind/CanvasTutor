// Math-checking backends: a long-lived SymPy worker (symbolic) and Qalculate's CLI (numbers, units, constants).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { evaluate as mathjsEvaluate } from 'mathjs'

const CAS_TIMEOUT_MS = 20_000
const QALC_TIMEOUT_MS = 10_000

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

/** A long-lived Python process speaking one JSON object per line on stdin/stdout. */
export class PythonWorker {
  private proc: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private ready: Promise<void> | null = null
  private python: string
  private args: string[]
  private timeoutMs: number
  private label: string

  constructor(label: string, python: string, args: string[], timeoutMs: number) {
    this.label = label
    this.python = python
    this.args = args
    this.timeoutMs = timeoutMs
  }

  private start() {
    // -P: don't put the script's directory on sys.path
    const proc = spawn(this.python, ['-P', ...this.args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    this.proc = proc
    const lines = createInterface({ input: proc.stdout })
    this.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.label} worker did not start`)), 60_000)
      lines.once('line', () => {
        clearTimeout(t)
        resolve()
      })
      proc.once('error', (e) => {
        clearTimeout(t)
        reject(e)
      })
      proc.once('exit', () => {
        clearTimeout(t)
        reject(new Error(`${this.label} worker failed to start: ${stderr.trim().split('\n').pop() ?? 'unknown error'}`))
      })
    })
    this.ready.catch(() => {})
    lines.on('line', (line) => {
      try {
        const msg = JSON.parse(line)
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        p.resolve(msg)
      } catch {}
    })
    proc.stderr.on('data', (d) => {
      stderr += d
      console.error(`[${this.label}]`, String(d).trimEnd())
    })
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`${this.label} worker exited`))
        this.pending.delete(id)
      }
    })
  }

  async call(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.proc) this.start()
    await this.ready
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out after ${this.timeoutMs / 1000}s`))
        this.proc?.kill() // runaway computation: restart the worker next time
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.proc!.stdin.write(JSON.stringify({ id, ...req }) + '\n')
    })
  }
}

const ROOT = join(import.meta.dirname, '..')
const PYTHON = process.env.CAS_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const SCRIPT = [join(ROOT, 'server', 'cas.py'), join(import.meta.dirname, 'cas.py')].find((p) => existsSync(p)) ?? join(ROOT, 'server', 'cas.py')
export const sympy = new PythonWorker('sympy', PYTHON, [SCRIPT], CAS_TIMEOUT_MS)

const QALC = process.env.QALC_PATH ?? (process.platform === 'win32' ? 'C:\\Program Files\\Qalculate\\qalc.exe' : 'qalc')

/** Evaluate with Qalculate; falls back to mathjs if qalc isn't installed. */
export function qalculate(expression: string): Promise<{ result: string; engine: string }> {
  const expr = expression.trim().startsWith('-') ? `(${expression})` : expression
  return new Promise((resolve, reject) => {
    const proc = spawn(QALC, ['-t', '-set', 'precision 12', expr], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('Qalculate timed out'))
    }, QALC_TIMEOUT_MS)
    proc.stdout.on('data', (d) => (out += d))
    proc.stderr.on('data', (d) => (err += d))
    proc.on('error', () => {
      clearTimeout(timer)
      try {
        resolve({ result: String(mathjsEvaluate(expression)), engine: 'mathjs (Qalculate not installed)' })
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
    proc.on('close', () => {
      clearTimeout(timer)
      const text = out.trim()
      if (!text && err.trim()) reject(new Error(err.trim()))
      else resolve({ result: text + (err.trim() ? `\n(warnings: ${err.trim()})` : ''), engine: 'Qalculate' })
    })
  })
}
