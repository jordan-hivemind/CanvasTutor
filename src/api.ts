import type { CanvasOp } from './canvas'
import type { MdOp } from './mdOps'

export type TutorEvent =
  | { type: 'status'; text: string }
  | { type: 'text'; delta: string }
  | { type: 'canvas'; op: CanvasOp }
  | { type: 'snapshot'; id: string; region?: 'page' | { x: number; y: number; w: number; h: number } | { note: string } }
  | { type: 'mdop'; id: string; op: MdOp }
  | { type: 'done'; sessionId: string | null }
  | { type: 'error'; message: string }

export class AuthError extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
  // on the login call itself a 401 means a wrong password, not a lost session
  if (r.status === 401 && path !== '/api/login') throw new AuthError('Not logged in')
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`)
  return body as T
}

export const api = {
  me: () => call<{ ok: true }>('/api/me'),
  login: (password: string) => call<{ ok: true }>('/api/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => call('/api/logout', { method: 'POST' }),
  history: (noteId: string) => call<{ history: { at: string; question: string; reply: string }[] }>(`/api/history?note=${encodeURIComponent(noteId)}`),
  reset: (noteId: string) => call('/api/reset', { method: 'POST', body: JSON.stringify({ noteId }) }),
  snapshot: (body: { id: string; image?: { data: string; mediaType: string }; context?: string; error?: string }) =>
    call('/api/snapshot', { method: 'POST', body: JSON.stringify(body) }),
  opResult: (id: string, result: { ok: boolean; message: string }) => call('/api/op-result', { method: 'POST', body: JSON.stringify({ id, ...result }) }),
  warm: (noteId: string, model: string, effort: string) => call('/api/warm', { method: 'POST', body: JSON.stringify({ noteId, model, effort }) }),
  cancel: (noteId: string) => call('/api/cancel', { method: 'POST', body: JSON.stringify({ noteId }) }),
}

/** POST a question and stream server-sent events back. */
export async function ask(body: Record<string, unknown>, onEvent: (e: TutorEvent) => void, signal?: AbortSignal) {
  const r = await fetch('/api/ask', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (r.status === 401) throw new AuthError('Not logged in')
  if (!r.ok || !r.body) {
    const b = await r.json().catch(() => ({}))
    throw new Error(b.error ?? `Request failed (${r.status})`)
  }
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += value
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i)
      buf = buf.slice(i + 2)
      for (const line of chunk.split('\n')) if (line.startsWith('data: ')) onEvent(JSON.parse(line.slice(6)))
    }
  }
}

/** Split a streamed reply into its spoken part (<say>…</say>) and on-screen part. */
/**
 * Split a reply into the spoken part (<say>…</say>) and the on-screen part.
 * Sometimes the tutor answers, uses a tool, then writes a revised answer with a second <say>
 * block: the screen then shows only the final version (`shownSay` + `display`), while speech
 * keeps the first <say> (`say`), which has usually been spoken already.
 */
export function parseReply(raw: string): { say: string; sayDone: boolean; display: string; shownSay: string } {
  // a tag still streaming in at the very end ("<sa", "</sa") isn't text yet
  const strip = (s: string) => s.replace(/<\/?s?a?y?>?$/, '').trim()
  const parts = raw.split('<say>')
  if (parts.length === 1) {
    // Tolerate a missing tag: everything is on-screen text.
    return { say: '', sayDone: false, display: strip(raw), shownSay: '' }
  }
  const blocks = parts.slice(1).map((p) => {
    const c = p.indexOf('</say>')
    return c < 0 ? { say: strip(p), done: false, rest: '' } : { say: p.slice(0, c).trim(), done: true, rest: p.slice(c + 6) }
  })
  const first = blocks[0]
  const last = blocks[blocks.length - 1]
  // with one block, text written before it still counts; with several, only the final version shows
  const display = strip(blocks.length === 1 ? parts[0] + last.rest : last.rest)
  return { say: first.say, sayDone: first.done, display, shownSay: last.say }
}
