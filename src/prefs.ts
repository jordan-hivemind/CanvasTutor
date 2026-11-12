// Settings that follow the student to every device (kept on the server). A copy is kept on the
// device so the last known value applies instantly at startup.
import { useEffect, useState } from 'react'
import type { Glyph } from './glyphs'

export type MatchStrength = 'light' | 'medium' | 'strong' | 'full'
export type Prefs = { neaten: boolean; matchLetters: boolean; matchStrength: MatchStrength; convertInk: boolean }
const DEFAULTS: Prefs = { neaten: false, matchLetters: false, matchStrength: 'medium', convertInk: false }
const KEY = 'ct-prefs'

const listeners = new Set<(p: Prefs) => void>()
let current: Prefs = (() => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return DEFAULTS
  }
})()
const publish = (p: Prefs) => {
  current = p
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {}
  listeners.forEach((f) => f(p))
}
let fetched = false

export function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  const [p, setP] = useState(current)
  useEffect(() => {
    listeners.add(setP)
    if (!fetched) {
      fetched = true
      fetch('/api/prefs', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((v) => v && publish({ ...DEFAULTS, ...v }))
        .catch(() => (fetched = false))
    }
    return () => void listeners.delete(setP)
  }, [])
  const set = (patch: Partial<Prefs>) => {
    publish({ ...current, ...patch })
    fetch('/api/prefs', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).catch(() => {})
  }
  return [p, set]
}

// ---- samples of the student's handwriting (for recognising characters) ----

export type Sample = Glyph & { id: string; basis?: boolean }
let samplesCache: Sample[] = []
const sampleListeners = new Set<(s: Sample[]) => void>()
let samplesLoaded = false
const setAll = (s: Sample[]) => {
  samplesCache = s
  sampleListeners.forEach((f) => f(s))
}

export function useSamples(enabled: boolean) {
  const [s, setS] = useState(samplesCache)
  useEffect(() => {
    sampleListeners.add(setS)
    if (enabled && !samplesLoaded) {
      samplesLoaded = true
      fetch('/api/handwriting', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((v) => v && setAll(v.samples))
        .catch(() => (samplesLoaded = false))
    }
    return () => void sampleListeners.delete(setS)
  }, [enabled])
  return s
}

async function post(body: unknown) {
  const r = await fetch('/api/handwriting', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error('Saving the sample failed')
  setAll((await r.json()).samples)
}
export const addSample = (ch: string, strokes: { x: number; y: number }[][]) => post({ add: { ch, strokes } })
export const removeSample = (id: string) => post({ remove: id })
