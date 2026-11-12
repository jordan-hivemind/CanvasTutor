// Speaks a reply sentence by sentence as it streams in, using the server's Kokoro voice
// (falls back to the browser's built-in voices).
import { listVoices, defaultVoice } from './voice'

let ctx: AudioContext | null = null

/**
 * Safety net for math symbols that slip into spoken text: the voice reads them badly
 * (e.g. "a_2 - b_1" comes out as "1a minus 1b"), so turn the common ones into words.
 */
export function speechSafe(text: string): string {
  return text
    .replace(/\$+/g, '')
    .replace(/\\(?:frac|dfrac)\{([^{}]*)\}\{([^{}]*)\}/g, '$1 over $2')
    .replace(/\\([a-zA-Z]+)/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/(\w)\^2\b/g, '$1 squared')
    .replace(/(\w)\^3\b/g, '$1 cubed')
    .replace(/\^\(([^()]*)\)\s*\/\s*(\w+)/g, ' to the $1, all over $2')
    .replace(/\^\(([^()]*)\)/g, ' to the $1,')
    .replace(/\^/g, ' to the ')
    .replace(/([A-Za-z])(?:([₀-₉]+)|_(\d+))/g, (_, v: string, uni?: string, plain?: string) => `${v} sub ${plain ?? uni!.replace(/[₀-₉]/g, (c) => String(c.charCodeAt(0) - 0x2080))}`)
    .replace(/\)\s*\/\s*(\w+)/g, ') all over $1')
    .replace(/\b(\d+)\s*\/\s*(\d+)\b/g, '$1 over $2')
    .replace(/\s*\(\s*/g, ', ')
    .replace(/\s*\)/g, ',')
    .replace(/(\b[a-z0-9]\b)\s*[-−]\s*(?=\b[a-z0-9]\b)/gi, '$1 minus ') // only between single symbols, not in prose
    .replace(/(^|[\s,])[-−](?=\d)/g, '$1minus ')
    .replace(/\s*=\s*/g, ' equals ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/,+\s*([,.!?])/g, '$1')
    .replace(/^,\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * iPhone/iPad mute web audio when the ringer is off, unless the page says it plays media (like a video
 * site does). Safari 17+. 'playback' can't use the mic, so recording switches to 'play-and-record'
 * (which also plays with the ringer off) and back.
 */
export function setAudioSession(type: 'playback' | 'play-and-record') {
  try {
    const s = (navigator as Navigator & { audioSession?: { type: string } }).audioSession
    if (s && s.type !== type) s.type = type
  } catch {}
}
let recording = false
export function setRecording(on: boolean) {
  recording = on
  setAudioSession(on ? 'play-and-record' : 'playback')
}
const playThroughSilentMode = () => {
  if (!recording) setAudioSession('playback')
}
playThroughSilentMode()

/** Call from a user gesture (tap) so iPad Safari allows audio that starts later. */
export function unlockAudio() {
  playThroughSilentMode()
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    const b = ctx.createBuffer(1, 1, 22050)
    const s = ctx.createBufferSource()
    s.buffer = b
    s.connect(ctx.destination)
    s.start()
  } catch {}
}

export type SpeakerOptions = {
  engine: 'kokoro' | 'browser'
  kokoroVoice: string
  browserVoice: string
  rate: number
  onEnd?: () => void
}

export class Speaker {
  private opts: SpeakerOptions
  private stopped = false
  private ended = false
  private chain: Promise<void> = Promise.resolve()
  private pending = 0
  private current: AudioBufferSourceNode | null = null

  constructor(opts: SpeakerOptions) {
    this.opts = opts
  }

  push(text: string) {
    const t = speechSafe(text)
    if (!t || this.stopped) return
    this.pending++
    // start synthesising right away (in parallel), play in order
    // a failed Kokoro request falls back to the device's voice for that sentence
    const audio = this.opts.engine === 'kokoro' ? this.fetchKokoro(t).catch(() => null) : Promise.resolve(null)
    this.chain = this.chain.then(async () => {
      if (this.stopped) return
      const buf = await audio
      if (this.stopped) return
      if (buf) await this.playBuffer(buf)
      else await this.speakBrowser(t)
    }).finally(() => {
      this.pending--
      this.maybeEnd()
    })
  }

  /** No more text is coming. */
  end() {
    this.ended = true
    this.maybeEnd()
  }

  stop() {
    this.stopped = true
    try {
      this.current?.stop()
    } catch {}
    if ('speechSynthesis' in window) speechSynthesis.cancel()
  }

  private maybeEnd() {
    if (this.ended && this.pending === 0 && !this.stopped) {
      this.stopped = true
      this.opts.onEnd?.()
    }
  }

  private async fetchKokoro(text: string): Promise<AudioBuffer> {
    const r = await fetch('/api/tts', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: this.opts.kokoroVoice, speed: this.opts.rate }),
    })
    if (!r.ok) throw new Error(`TTS ${r.status}`)
    ctx ??= new AudioContext()
    return ctx.decodeAudioData(await r.arrayBuffer())
  }

  private playBuffer(buf: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      if (!ctx || this.stopped) return resolve()
      if (ctx.state === 'suspended') void ctx.resume()
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      src.onended = () => resolve()
      this.current = src
      src.start()
    })
  }

  private speakBrowser(text: string): Promise<void> {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) return resolve()
      const u = new SpeechSynthesisUtterance(text)
      const v = listVoices().find((x) => x.name === this.opts.browserVoice) ?? defaultVoice()
      if (v) u.voice = v
      u.rate = this.opts.rate
      u.onend = () => resolve()
      u.onerror = () => resolve()
      speechSynthesis.speak(u)
    })
  }
}

/**
 * Feeds a growing <say> text to a Speaker in natural chunks: whole sentences,
 * merged until they're long enough to sound fluent.
 */
export class SentenceFeeder {
  private sent = 0
  private speaker: Speaker
  constructor(speaker: Speaker) {
    this.speaker = speaker
  }

  update(text: string, final: boolean) {
    let rest = text.slice(this.sent)
    for (;;) {
      const m = rest.match(/^([\s\S]*?[.!?;:])(\s+)(?=\S)/)
      if (!m) break
      let chunk = m[1]
      let used = m[0].length
      // merge short sentences with the next one when possible
      while (chunk.length < 40) {
        const next = rest.slice(used).match(/^([\s\S]*?[.!?;:])(\s+)(?=\S)/)
        if (!next) break
        chunk += ' ' + next[1]
        used += next[0].length
      }
      if (chunk.length < 40 && !final) break
      this.speaker.push(chunk)
      this.sent += used
      rest = text.slice(this.sent)
    }
    if (final) {
      if (rest.trim()) this.speaker.push(rest)
      this.sent = text.length
      this.speaker.end()
    }
  }
}
