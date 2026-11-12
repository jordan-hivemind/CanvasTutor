import { useEffect, useState } from 'react'

export type Settings = {
  voiceInput: boolean
  typeInput: boolean
  speakReplies: boolean
  showText: boolean
  speechInput: 'auto' | 'whisper' | 'browser'
  voiceEngine: 'kokoro' | 'browser'
  kokoroVoice: string
  voiceName: string
  rate: number
  model: 'opus' | 'sonnet' | 'haiku'
  effort: 'low' | 'medium' | 'high'
  /** microphone on this device ('' = system default); the label is a fallback, as ids can change */
  micId: string
  micLabel: string
  /** canvases: only the pencil draws; fingers move the board and select */
  pencilMode: boolean
}

const DEFAULTS: Settings = {
  voiceInput: true,
  typeInput: true,
  speakReplies: true,
  showText: true,
  speechInput: 'auto',
  voiceEngine: 'kokoro',
  kokoroVoice: 'af_heart',
  voiceName: '',
  rate: 1.05,
  model: 'opus',
  effort: 'medium',
  micId: '',
  micLabel: '',
  pencilMode: false,
}

const KEY = 'canvas-tutor-settings'

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return DEFAULTS
  }
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [s, setS] = useState(load)
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s))
    } catch {}
  }, [s])
  return [s, (patch) => setS((prev) => ({ ...prev, ...patch }))]
}
