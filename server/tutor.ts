// One long-lived Claude Code session per board page, driven through the Agent SDK.
// Keeping the query open (streaming input) avoids re-spawning Claude Code on every question.
import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { mkdirSync } from 'node:fs'
import { SYSTEM_PROMPT } from './prompt.ts'
import { createTutorServer, TOOL_STATUS, type BoardView, type CanvasOp, type SnapRegion, type ToolContext, type ViewBounds } from './tools.ts'
import type { MdOp, MdOpResult, NotesAccess } from './noteTools.ts'

export type TutorEvent =
  | { type: 'status'; text: string }
  | { type: 'text'; delta: string }
  | { type: 'canvas'; op: CanvasOp }
  | { type: 'snapshot'; id: string; region?: SnapRegion }
  | { type: 'mdop'; id: string; op: MdOp }
  | { type: 'done'; sessionId: string | null }
  | { type: 'error'; message: string }

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type AskInput = {
  text: string
  image?: { data: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' }
  context: string
  model: string
  effort: Effort
  /** The board region the student can see (for off-screen warnings). */
  view: ViewBounds | null
  /** Ask the browser for a fresh board image mid-turn. */
  snapshot: (region?: SnapRegion) => Promise<BoardView>
  /** Carry out an edit/comment in the student's open markdown editor and report back. */
  mdOp: (op: MdOp) => Promise<MdOpResult>
}

const IDLE_MS = 20 * 60 * 1000

export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private closed = false
  push(item: T) {
    const w = this.waiters.shift()
    if (w) w({ value: item, done: false })
    else this.items.push(item)
  }
  close() {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((r) => this.waiters.push(r))
      },
    }
  }
}

export class TutorSession {
  private q: Query | null = null
  private queue: AsyncQueue<SDKUserMessage> | null = null
  private emit: ((e: TutorEvent) => void) | null = null
  private finishTurn: (() => void) | null = null
  private model = ''
  private effort: Effort = 'medium'
  private idleTimer: NodeJS.Timeout | null = null
  private wroteText = false
  private syntheticError: string | null = null
  private snapshot: ((region?: SnapRegion) => Promise<BoardView>) | null = null
  private mdOp: ((op: MdOp) => Promise<MdOpResult>) | null = null
  private kind: 'md' | 'canvas'
  private access: NotesAccess
  view: ViewBounds | null = null
  private timing: { t0: number; steps: number; tools: string[]; firstText: number; cold: boolean } | null = null
  busy = false
  sessionId: string | null
  private workDir: string
  private onSessionId: (id: string) => void
  private liveSessionId: string | null = null
  private resumed = false
  private gotResult = false
  private lastMessage: SDKUserMessage | null = null

  constructor(workDir: string, sessionId: string | null, onSessionId: (id: string) => void, kind: 'md' | 'canvas', access: NotesAccess) {
    this.kind = kind
    this.access = access
    this.workDir = workDir
    this.sessionId = sessionId
    this.onSessionId = onSessionId
    mkdirSync(workDir, { recursive: true })
  }

  private start(model: string, effort: Effort) {
    this.close()
    this.model = model
    this.effort = effort
    const queue = new AsyncQueue<SDKUserMessage>()
    this.queue = queue
    const self = this
    const toolCtx: ToolContext = {
      emit: (op, status) => {
        this.emit?.({ type: 'status', text: status })
        this.emit?.({ type: 'canvas', op })
      },
      status: (text) => this.emit?.({ type: 'status', text }),
      get view() {
        return self.view
      },
      mdOp: (op) => {
        if (!this.mdOp) return Promise.reject(new Error('No active request'))
        return this.mdOp(op)
      },
      get access() {
        return self.access
      },
      snapshot: (region) => {
        if (!this.snapshot) return Promise.reject(new Error('No active request'))
        return this.snapshot(region)
      },
    }
    const q = query({
      prompt: queue,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        model,
        effort,
        tools: ['WebFetch', 'WebSearch'], // for online textbooks and references; no file or shell access
        mcpServers: { canvas: createTutorServer(() => (this.emit ? toolCtx : null), this.kind) },
        allowedTools: ['mcp__canvas__*', 'WebFetch', 'WebSearch'],
        permissionMode: 'dontAsk',
        settingSources: [],
        includePartialMessages: true,
        cwd: this.workDir,
        resume: this.sessionId || undefined,
        stderr: (d) => console.error('[claude]', d.trimEnd()),
      },
    })
    this.q = q
    this.resumed = !!this.sessionId
    this.gotResult = false
    this.liveSessionId = null
    void this.pump(q)
  }

  private async pump(q: Query) {
    try {
      for await (const m of q) this.handle(m)
      if (this.q !== q) return // replaced by a newer session (e.g. model/effort changed): not an error
      if (this.retryFresh(q)) return
      this.endTurn('The tutor session ended unexpectedly.')
    } catch (e) {
      if (this.q !== q) return
      console.error('[tutor] session error', e)
      if (this.retryFresh(q)) return
      this.endTurn(e instanceof Error ? e.message : String(e))
    } finally {
      if (this.q === q) {
        this.q = null
        this.queue = null
      }
    }
  }

  /** A resumed session that dies before answering anything is unusable: start fresh and resend the question. */
  private retryFresh(q: Query): boolean {
    if (this.q !== q || !this.resumed || this.gotResult || !this.finishTurn || !this.lastMessage) return false
    console.error(`[tutor] could not resume session ${this.sessionId}; starting a fresh one`)
    this.sessionId = null
    this.onSessionId('')
    const msg = this.lastMessage
    this.start(this.model, this.effort)
    this.queue!.push(msg)
    return true
  }

  private handle(m: SDKMessage) {
    if (m.type === 'system' && m.subtype === 'init') {
      // remember it, but only save it once a question has actually been answered: a session
      // that never got a message has no transcript and can't be resumed later
      if (m.session_id) this.liveSessionId = m.session_id
      return
    }
    if (m.type === 'stream_event') {
      if (m.parent_tool_use_id) return
      const ev = m.event
      if (ev.type === 'message_start' && this.timing) this.timing.steps++
      if (ev.type === 'content_block_start') {
        const b = ev.content_block
        if (b.type === 'thinking' || b.type === 'redacted_thinking') this.emit?.({ type: 'status', text: 'Thinking' })
        else if (b.type === 'tool_use' || b.type === 'mcp_tool_use') {
          const name = String(b.name).replace(/^mcp__canvas__/, '')
          this.timing?.tools.push(`${name}@${((Date.now() - this.timing.t0) / 1000).toFixed(1)}`)
          this.emit?.({ type: 'status', text: TOOL_STATUS[name] ?? 'Working' })
        } else if (b.type === 'text') {
          this.emit?.({ type: 'status', text: 'Answering' })
          if (this.wroteText) this.emit?.({ type: 'text', delta: '\n\n' })
        }
      } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        if (this.timing && !this.timing.firstText) this.timing.firstText = Date.now()
        this.wroteText = true
        this.emit?.({ type: 'text', delta: ev.delta.text })
      }
      return
    }
    if (m.type === 'system' && m.subtype === 'api_retry') {
      const auth = m.error === 'authentication_failed'
      this.emit?.({ type: 'status', text: auth ? "Can't sign in to Claude, retrying" : `Claude is busy, retrying (attempt ${m.attempt})` })
      return
    }
    if (m.type === 'assistant' && m.message.model === '<synthetic>') {
      // Errors (auth failures, rate limits) arrive as a synthetic assistant message, not a stream.
      const text = m.message.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ').trim()
      this.syntheticError = text || 'Claude could not answer.'
      return
    }
    if (m.type === 'result') {
      if (this.syntheticError) {
        const msg = this.syntheticError
        this.syntheticError = null
        this.endTurn(/auth|log ?in|token|401/i.test(msg) ? `${msg} — the Claude token on the server may be invalid; run deploy/set-secrets.sh again.` : msg)
      } else if (m.subtype === 'success') {
        this.gotResult = true
        if (this.liveSessionId && this.liveSessionId !== this.sessionId) {
          this.sessionId = this.liveSessionId
          this.onSessionId(this.liveSessionId)
        }
        if (!this.wroteText) this.emit?.({ type: 'error', message: 'Claude finished without replying. Try asking again.' })
        this.emit?.({ type: 'done', sessionId: this.sessionId })
        this.endTurn()
      } else {
        this.endTurn(`Claude stopped early (${m.subtype}).`)
      }
    }
  }

  private endTurn(error?: string) {
    if (!this.finishTurn) return
    if (this.timing) {
      const t = this.timing
      const s = (ms: number) => (ms / 1000).toFixed(1) + 's'
      console.log(
        `[turn] ${this.model}/${this.effort} total=${s(Date.now() - t.t0)} firstText=${t.firstText ? s(t.firstText - t.t0) : '-'} steps=${t.steps} tools=[${t.tools.join(' ')}]${t.cold ? ' cold-start' : ''}${error ? ' error=' + JSON.stringify(error.slice(0, 80)) : ''}`,
      )
      this.timing = null
    }
    if (error) this.emit?.({ type: 'error', message: error })
    const f = this.finishTurn
    this.finishTurn = null
    this.emit = null
    this.busy = false
    f()
  }

  async ask(input: AskInput, emit: (e: TutorEvent) => void): Promise<void> {
    if (this.busy) throw new Error('Still answering the previous question')
    this.busy = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    try {
      const cold = !this.q || this.model !== input.model || this.effort !== input.effort
      if (cold) {
        emit({ type: 'status', text: 'Starting tutor' })
        this.start(input.model, input.effort)
      }
      this.timing = { t0: Date.now(), steps: 0, tools: [], firstText: 0, cold }
      this.emit = emit
      this.snapshot = input.snapshot
      this.mdOp = input.mdOp
      this.view = input.view
      this.wroteText = false
      this.syntheticError = null
      emit({ type: 'status', text: 'Thinking' })
      const text = { type: 'text' as const, text: `${input.context}\n\nStudent: ${input.text}` }
      const content = input.image
        ? [{ type: 'image' as const, source: { type: 'base64' as const, media_type: input.image.mediaType, data: input.image.data } }, text]
        : [text]
      const done = new Promise<void>((r) => (this.finishTurn = r))
      this.lastMessage = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
      this.queue!.push(this.lastMessage)
      await done
    } catch (e) {
      this.busy = false
      this.emit = null
      throw e
    } finally {
      this.idleTimer = setTimeout(() => this.close(), IDLE_MS)
    }
  }

  /** Start Claude Code ahead of the first question so it doesn't pay the startup cost. No tokens are used. */
  warm(model: string, effort: Effort) {
    if (this.busy) return
    if (!this.q || this.model !== model || this.effort !== effort) this.start(model, effort)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.close(), IDLE_MS)
  }

  /** Stop the current answer. The turn ends right away and Claude Code restarts on the same
   *  conversation, so a stuck interrupt or a late result from the stopped turn can't hold up or
   *  end the next question. */
  async interrupt() {
    if (!this.busy) return
    this.endTurn('Stopped.')
    this.busy = false // also covers a turn that hadn't reached Claude yet
    this.start(this.model, this.effort)
  }

  close() {
    this.queue?.close()
    try {
      this.q?.close()
    } catch {}
    this.q = null
    this.queue = null
  }

  reset() {
    this.close()
    this.sessionId = null
  }
}
