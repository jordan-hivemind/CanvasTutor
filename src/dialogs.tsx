// In-app replacements for window.alert / confirm / prompt (which look out of place and are
// blocked or awkward on iPad). Call them from anywhere; <DialogHost/> renders the current one.
import { useEffect, useRef, useState } from 'react'

type Dialog =
  | { kind: 'alert'; title: string; message?: string; resolve: (v: void) => void }
  | { kind: 'confirm'; title: string; message?: string; ok: string; danger: boolean; resolve: (v: boolean) => void }
  | { kind: 'prompt'; title: string; message?: string; value: string; ok: string; placeholder?: string; resolve: (v: string | null) => void }

let queue: Dialog[] = []
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((l) => l())
const push = (d: Dialog) => {
  queue = [...queue, d]
  changed()
}

export const dialog = {
  alert: (title: string, message?: string) => new Promise<void>((resolve) => push({ kind: 'alert', title, message, resolve })),
  confirm: (title: string, opts: { message?: string; ok?: string; danger?: boolean } = {}) =>
    new Promise<boolean>((resolve) => push({ kind: 'confirm', title, message: opts.message, ok: opts.ok ?? 'OK', danger: !!opts.danger, resolve })),
  /** Resolves to the trimmed text, or null if cancelled or left empty. */
  prompt: (title: string, opts: { value?: string; ok?: string; placeholder?: string; message?: string } = {}) =>
    new Promise<string | null>((resolve) =>
      push({ kind: 'prompt', title, message: opts.message, value: opts.value ?? '', ok: opts.ok ?? 'OK', placeholder: opts.placeholder, resolve }),
    ),
}

export function DialogHost() {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((n) => n + 1)
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
  const d = queue[0]
  if (!d) return null
  const close = (value: unknown) => {
    queue = queue.slice(1)
    ;(d.resolve as (v: unknown) => void)(value)
    changed()
  }
  return <DialogBox key={queue.length + d.title} d={d} close={close} />
}

function DialogBox({ d, close }: { d: Dialog; close: (v: unknown) => void }) {
  const [text, setText] = useState(d.kind === 'prompt' ? d.value : '')
  const input = useRef<HTMLInputElement>(null)
  const okBtn = useRef<HTMLButtonElement>(null)
  const cancelValue = d.kind === 'confirm' ? false : d.kind === 'prompt' ? null : undefined
  const ok = () => close(d.kind === 'confirm' ? true : d.kind === 'prompt' ? text.trim() || null : undefined)
  useEffect(() => {
    if (d.kind === 'prompt') {
      input.current?.focus()
      input.current?.select()
    } else okBtn.current?.focus()
  }, [d.kind])
  return (
    <div className="modal-bg dialog-bg" onClick={() => close(cancelValue)} onKeyDown={(e) => e.key === 'Escape' && close(cancelValue)}>
      <div className="modal dialog" role="dialog" aria-modal="true" aria-label={d.title} onClick={(e) => e.stopPropagation()}>
        <h3>{d.title}</h3>
        {d.message && <p className="dialog-msg">{d.message}</p>}
        {d.kind === 'prompt' && (
          <input
            ref={input}
            className="dialog-input"
            value={text}
            placeholder={d.placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), ok())}
          />
        )}
        <div className="dialog-actions">
          {d.kind !== 'alert' && <button onClick={() => close(cancelValue)}>Cancel</button>}
          <button ref={okBtn} className={d.kind === 'confirm' && d.danger ? 'danger' : 'primary'} disabled={d.kind === 'prompt' && !text.trim()} onClick={ok}>
            {d.kind === 'alert' ? 'OK' : d.ok}
          </button>
        </div>
      </div>
    </div>
  )
}
