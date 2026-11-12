// Single-user password login with a long-lived signed cookie.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

const COOKIE = 'ct_auth'
const MAX_AGE_S = 400 * 24 * 3600 // browsers cap cookies at 400 days

export class Auth {
  private secret: Buffer
  private attempts = new Map<string, number[]>()
  private password: string

  constructor(dataDir: string, password: string) {
    this.password = password
    const p = join(dataDir, 'secret.key')
    if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString('hex'), { mode: 0o600 })
    this.secret = Buffer.from(readFileSync(p, 'utf8').trim(), 'hex')
  }

  private sign(payload: string) {
    return createHmac('sha256', this.secret).update(payload).digest('base64url')
  }

  isAuthed(req: IncomingMessage): boolean {
    const raw = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='))
    if (!raw) return false
    const [exp, sig] = raw.slice(COOKIE.length + 1).split('.')
    if (!exp || !sig || Number(exp) < Date.now() / 1000) return false
    const want = Buffer.from(this.sign(exp))
    const got = Buffer.from(sig)
    return want.length === got.length && timingSafeEqual(want, got)
  }

  /** Returns false if rate-limited or wrong. */
  tryLogin(req: IncomingMessage, res: ServerResponse, password: string, secure: boolean): 'ok' | 'wrong' | 'limited' {
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '?').split(',')[0].trim()
    const now = Date.now()
    const recent = (this.attempts.get(ip) ?? []).filter((t) => now - t < 10 * 60 * 1000)
    if (recent.length >= 8) return 'limited'
    const a = createHmac('sha256', this.secret).update(password).digest()
    const b = createHmac('sha256', this.secret).update(this.password).digest()
    if (!this.password || !timingSafeEqual(a, b)) {
      recent.push(now)
      this.attempts.set(ip, recent)
      return 'wrong'
    }
    this.attempts.delete(ip)
    const exp = String(Math.floor(now / 1000) + MAX_AGE_S)
    res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${this.sign(exp)}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`)
    return 'ok'
  }

  logout(res: ServerResponse) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`)
  }
}
