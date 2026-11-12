// Whisper speech-to-text via a long-lived Python worker (only if configured).
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PythonWorker } from './checkers.ts'

const PYTHON = process.env.STT_PYTHON ?? process.env.TTS_PYTHON
const MODEL = process.env.WHISPER_MODEL ?? 'small.en'
const MODEL_DIR = process.env.WHISPER_DIR
const SCRIPT = [join(import.meta.dirname, 'stt.py'), join(import.meta.dirname, '..', 'server', 'stt.py')].find((p) => existsSync(p))

export const sttAvailable = !!(PYTHON && MODEL_DIR && SCRIPT)
const worker = sttAvailable ? new PythonWorker('whisper', PYTHON!, [SCRIPT!, MODEL, MODEL_DIR!], 60_000) : null

export async function transcribe(audio: Buffer, contentType: string, tmpDir: string): Promise<string> {
  if (!worker) throw new Error('Speech recognition is not set up on this server')
  mkdirSync(tmpDir, { recursive: true })
  const ext = contentType.includes('mp4') || contentType.includes('aac') ? 'mp4' : contentType.includes('ogg') ? 'ogg' : contentType.includes('wav') ? 'wav' : 'webm'
  const path = join(tmpDir, `${randomUUID()}.${ext}`)
  writeFileSync(path, audio)
  try {
    const r = await worker.call({ path })
    if (!r.ok) throw new Error(String(r.error))
    return String(r.text ?? '')
  } finally {
    try {
      unlinkSync(path)
    } catch {}
  }
}

/** Load the model at startup so the first question isn't slow (transcribes 0.3s of silence). */
export function warmStt(tmpDir: string) {
  if (!worker) return
  const samples = 4800
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + samples * 2, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24)
  wav.writeUInt32LE(32000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(samples * 2, 40)
  transcribe(wav, 'audio/wav', tmpDir).catch((e) => console.error('[whisper] warm-up failed', e))
}
