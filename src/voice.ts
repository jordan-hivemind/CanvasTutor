// Speech in (Web Speech recognition) and speech out (speechSynthesis).
import { sendCrash } from './ErrorBoundary'

/** The message for a failed mic start. Also logged on the server, so failures on the iPad can be looked into. */
function micError(name: string, detail = ''): string {
  sendCrash(new Error(`mic ${name} ${detail}`.trim()), 'mic')
  if (name === 'NotAllowedError' || name === 'not-allowed') return 'Microphone access was blocked. Allow it in the browser settings.'
  return `The microphone couldn't start (${name}). Try again?`
}

type Rec = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

function getRecCtor(): (new () => Rec) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const canListen = () => getRecCtor() !== null
export const canSpeak = () => 'speechSynthesis' in window

/**
 * Tap-to-start / tap-to-stop dictation. Safari ends recognition on its own after pauses,
 * so we transparently restart until the user stops.
 */
export class Dictation {
  private rec: Rec | null = null
  private finalText = ''
  private interim = ''
  private active = false
  private onUpdate: (text: string) => void
  private onError: (msg: string) => void

  constructor(onUpdate: (text: string) => void, onError: (msg: string) => void) {
    this.onUpdate = onUpdate
    this.onError = onError
  }

  get text() {
    return (this.finalText + ' ' + this.interim).replace(/\s+/g, ' ').trim()
  }

  start() {
    const Ctor = getRecCtor()
    if (!Ctor) return this.onError('Speech recognition is not supported in this browser. Try Safari, Chrome, or Edge.')
    this.finalText = ''
    this.interim = ''
    this.active = true
    this.spawn(Ctor)
  }

  private spawn(Ctor: new () => Rec) {
    const rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = navigator.language || 'en-US'
    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) this.finalText += ' ' + r[0].transcript
        else interim += r[0].transcript
      }
      this.interim = interim
      this.onUpdate(this.text)
    }
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return
      this.active = false
      this.onError(e.error === 'not-allowed' ? micError(e.error, 'speech recognition') : `Speech recognition error: ${e.error}`)
    }
    rec.onend = () => {
      if (this.interim) {
        this.finalText += ' ' + this.interim
        this.interim = ''
      }
      if (this.active && this.rec === rec) {
        try {
          this.spawn(Ctor)
        } catch {}
      }
    }
    this.rec = rec
    rec.start()
  }

  /** Stop and resolve with the final transcript once the recogniser flushes. */
  stop(): Promise<string> {
    this.active = false
    const rec = this.rec
    if (!rec) return Promise.resolve(this.text)
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(this.text), 1200)
      rec.onend = () => {
        clearTimeout(t)
        if (this.interim) this.finalText += ' ' + this.interim
        this.interim = ''
        resolve(this.text)
      }
      rec.stop()
    })
  }

  cancel() {
    this.active = false
    this.rec?.abort()
    this.rec = null
  }
}

/**
 * Records audio and has the server transcribe it with Whisper. Works in any browser that can
 * record audio (including Firefox-based ones without built-in speech recognition).
 */
export class ServerDictation {
  private rec: MediaRecorder | null = null
  private chunks: Blob[] = []
  private stream: MediaStream | null = null
  private onError: (msg: string) => void
  private mic: { id: string; label: string }
  private cancelled = false

  constructor(onError: (msg: string) => void, mic: { id: string; label: string } = { id: '', label: '' }) {
    this.onError = onError
    this.mic = mic
  }

  async start() {
    const base = { echoCancellation: true, noiseSuppression: true }
    try {
      const deviceId = await findMic(this.mic)
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base })
    } catch (e) {
      if ((e as Error).name === 'OverconstrainedError' || (e as Error).name === 'NotFoundError') {
        // the chosen mic isn't plugged in: fall back to the default one
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({ audio: base })
        } catch (e2) {
          return this.onError(micError((e2 as Error).name, (e2 as Error).message))
        }
      } else return this.onError(micError((e as Error).name, (e as Error).message))
    }
    // cancelled while the mic was still opening
    if (this.cancelled) return this.stream?.getTracks().forEach((t) => t.stop())
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t))
    this.chunks = []
    this.rec = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined)
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data)
    this.rec.start(250)
  }

  /** Stop recording and resolve with the transcript. */
  async stop(): Promise<string> {
    const rec = this.rec
    if (!rec) return ''
    await new Promise<void>((resolve) => {
      rec.onstop = () => resolve()
      rec.stop()
    })
    this.stream?.getTracks().forEach((t) => t.stop())
    const blob = new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' })
    this.rec = null
    if (blob.size < 2000) return ''
    const r = await fetch('/api/stt', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type }, body: blob })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.error ?? `Transcription failed (${r.status})`)
    return String(body.text ?? '').trim()
  }

  cancel() {
    this.cancelled = true
    try {
      this.rec?.stop()
    } catch {}
    this.stream?.getTracks().forEach((t) => t.stop())
    this.rec = null
  }
}

/** The chosen microphone's current id (ids can change between sessions, so match by name too). */
async function findMic(mic: { id: string; label: string }): Promise<string> {
  if (!mic.id && !mic.label) return ''
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
  return (inputs.find((d) => d.deviceId === mic.id) ?? inputs.find((d) => mic.label && d.label === mic.label))?.deviceId ?? mic.id
}

/** This device's microphones. Names are hidden until the site has microphone access, so ask once if needed. */
export async function listMics(askAccess: boolean): Promise<{ id: string; label: string }[]> {
  let inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
  if (askAccess && inputs.every((d) => !d.label)) {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true })
    s.getTracks().forEach((t) => t.stop())
    inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
  }
  return inputs.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
}

export const canRecord = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

// ---------- speech out ----------
export function listVoices(): SpeechSynthesisVoice[] {
  if (!canSpeak()) return []
  return speechSynthesis.getVoices().filter((v) => v.lang.startsWith(navigator.language.split('-')[0]) || v.lang.startsWith('en'))
}

export function defaultVoice(): SpeechSynthesisVoice | undefined {
  const vs = listVoices()
  const rank = (v: SpeechSynthesisVoice) =>
    (/(premium|enhanced|natural|neural)/i.test(v.name) ? 4 : 0) + (/(Samantha|Ava|Zoe|Evan|Nathan|Aria|Jenny|Google US English)/.test(v.name) ? 2 : 0) + (v.localService ? 1 : 0)
  return vs.sort((a, b) => rank(b) - rank(a))[0]
}

let speakingToken = 0

export function speak(text: string, opts: { voiceName?: string; rate?: number; onEnd?: () => void }) {
  if (!canSpeak() || !text.trim()) return opts.onEnd?.()
  stopSpeaking()
  const token = ++speakingToken
  const voice = listVoices().find((v) => v.name === opts.voiceName) ?? defaultVoice()
  // Split into sentences: long utterances get cut off in some browsers.
  const parts = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text]
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p.trim())
    if (voice) u.voice = voice
    u.rate = opts.rate ?? 1.05
    if (i === parts.length - 1) u.onend = () => token === speakingToken && opts.onEnd?.()
    speechSynthesis.speak(u)
  })
}

export function stopSpeaking() {
  speakingToken++
  if (canSpeak()) speechSynthesis.cancel()
}
