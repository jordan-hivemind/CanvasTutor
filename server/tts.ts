// Kokoro text-to-speech via a long-lived Python worker (only if configured).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PythonWorker } from './checkers.ts'

const PYTHON = process.env.TTS_PYTHON
const DIR = process.env.KOKORO_DIR
const SCRIPT = [join(import.meta.dirname, 'tts.py'), join(import.meta.dirname, '..', 'server', 'tts.py')].find((p) => existsSync(p))

export const ttsAvailable = !!(PYTHON && DIR && SCRIPT && existsSync(join(DIR, 'kokoro-v1.0.onnx')))

const worker = ttsAvailable ? new PythonWorker('kokoro', PYTHON!, [SCRIPT!, join(DIR!, 'kokoro-v1.0.onnx'), join(DIR!, 'voices-v1.0.bin')], 30_000) : null

export async function synthesize(text: string, voice: string, speed: number): Promise<Buffer> {
  if (!worker) throw new Error('Kokoro is not set up on this server')
  const r = await worker.call({ text, voice, speed })
  if (!r.ok) throw new Error(String(r.error))
  return Buffer.from(String(r.wav), 'base64')
}

/** Load the model at startup so the first reply isn't slow. */
export function warmTts() {
  if (worker) synthesize('Ready.', 'af_heart', 1).catch((e) => console.error('[kokoro] warm-up failed', e))
}
