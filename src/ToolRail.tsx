// Touch-friendly tool controls: a side rail with the everyday tools, and a top-corner
// button that opens every other tool.
import { useEffect, useRef, useState } from 'react'
import { GeoShapeGeoStyle, useValue, type Editor } from 'tldraw'
import { importWorksheets } from './importer'
import { useDismiss } from './dismiss'

const I = {
  draw: (
    <path d="M4 20l1.2-4.6L16.5 4.1a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8 4 20zM14.5 6.1l3.4 3.4" />
  ),
  eraser: (
    <path d="M8.5 20H20M5.2 15.2l8.6-8.6a2 2 0 0 1 2.8 0l2.8 2.8a2 2 0 0 1 0 2.8L13 18.6a4 4 0 0 1-2.8 1.2H8.6a2 2 0 0 1-1.4-.6l-2-2a2 2 0 0 1 0-2.8zM9.5 10.9l5.6 5.6" />
  ),
  select: <path d="M5 3.5l13 7.2-5.6 1.6 3.4 6.3-2.5 1.3-3.4-6.3-4.2 4.1z" />,
  undo: <path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />,
  redo: <path d="M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />,
  more: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </>
  ),
}

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

/** Single-key shortcuts for tablet express keys (F13+ keys nothing else uses). */
export const EXPRESS_KEYS: Record<string, { label: string; run: (editor: Editor) => void }> = {
  F14: { label: 'Draw', run: (e) => e.setCurrentTool('draw') },
  F15: { label: 'Eraser (tap) / erase while held', run: (e) => e.setCurrentTool('eraser') },
  F16: { label: 'Undo', run: (e) => e.undo() },
  F17: { label: 'Redo', run: (e) => e.redo() },
  F18: { label: 'Select / move', run: (e) => e.setCurrentTool('select') },
}

const ERASER_KEY = 'F15'
const HOLD_MS = 350

export function ToolRail({ editor }: { editor: Editor }) {
  const tool = useValue('tool', () => editor.getCurrentToolId(), [editor])
  const canUndo = useValue('canUndo', () => editor.getCanUndo(), [editor])
  const canRedo = useValue('canRedo', () => editor.getCanRedo(), [editor])

  useEffect(() => {
    // Eraser key: tap to switch to the eraser; hold to erase only while it's held.
    let eraserDown: { at: number; previous: string } | null = null
    const onKey = (ev: KeyboardEvent) => {
      const k = EXPRESS_KEYS[ev.key]
      if (!k) return
      ev.preventDefault()
      ev.stopPropagation()
      if (ev.repeat) return
      if (ev.key === ERASER_KEY) {
        const previous = editor.getCurrentToolId()
        eraserDown = { at: Date.now(), previous: previous === 'eraser' ? 'draw' : previous }
      }
      k.run(editor)
    }
    const onKeyUp = (ev: KeyboardEvent) => {
      if (ev.key !== ERASER_KEY || !eraserDown) return
      ev.preventDefault()
      const held = Date.now() - eraserDown.at > HOLD_MS
      const previous = eraserDown.previous
      eraserDown = null
      if (held && editor.getCurrentToolId() === 'eraser') {
        editor.complete() // finish the stroke being erased before switching
        editor.setCurrentTool(previous)
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    window.addEventListener('keyup', onKeyUp, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true })
      window.removeEventListener('keyup', onKeyUp, { capture: true })
    }
  }, [editor])

  return (
    <div className="tool-rail">
      <button className={`rail-btn ${tool === 'draw' ? 'active' : ''}`} title="Draw (D or F14)" onClick={() => editor.setCurrentTool('draw')}>
        <Icon>{I.draw}</Icon>
      </button>
      <button className={`rail-btn ${tool === 'select' ? 'active' : ''}`} title="Select and move (V or F18)" onClick={() => editor.setCurrentTool('select')}>
        <Icon>{I.select}</Icon>
      </button>
      <button className={`rail-btn ${tool === 'eraser' ? 'active' : ''}`} title="Eraser (E or F15)" onClick={() => editor.setCurrentTool('eraser')}>
        <Icon>{I.eraser}</Icon>
      </button>
      <div className="rail-sep" />
      <button className="rail-btn" title="Undo (Ctrl+Z or F16)" disabled={!canUndo} onClick={() => editor.undo()}>
        <Icon>{I.undo}</Icon>
      </button>
      <button className="rail-btn" title="Redo (Ctrl+Shift+Z or F17)" disabled={!canRedo} onClick={() => editor.redo()}>
        <Icon>{I.redo}</Icon>
      </button>
    </div>
  )
}

type MoreTool = { id: string; label: string; emoji: string; geo?: 'rectangle' | 'ellipse' | 'triangle' }
const MORE_TOOLS: MoreTool[] = [
  { id: 'select', label: 'Select', emoji: '👆' },
  { id: 'hand', label: 'Move view', emoji: '✋' },
  { id: 'highlight', label: 'Highlighter', emoji: '🖍️' },
  { id: 'laser', label: 'Laser', emoji: '🔴' },
  { id: 'text', label: 'Text', emoji: '🔤' },
  { id: 'note', label: 'Sticky note', emoji: '🗒️' },
  { id: 'arrow', label: 'Arrow', emoji: '↗️' },
  { id: 'line', label: 'Line', emoji: '📏' },
  { id: 'geo', label: 'Rectangle', emoji: '⬜', geo: 'rectangle' },
  { id: 'geo', label: 'Ellipse', emoji: '⚪', geo: 'ellipse' },
  { id: 'geo', label: 'Triangle', emoji: '🔺', geo: 'triangle' },
  { id: 'frame', label: 'Frame', emoji: '🖼️' },
]

export function MoreToolsButton({ editor, onMessage }: { editor: Editor; onMessage: (msg: string) => void }) {
  const [open, setOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const tool = useValue('tool', () => editor.getCurrentToolId(), [editor])
  const geo = useValue('geo', () => editor.getStyleForNextShape(GeoShapeGeoStyle), [editor])
  const otherActive = tool !== 'draw' && tool !== 'eraser' && tool !== 'select'
  const isActive = (t: MoreTool) => tool === t.id && (!t.geo || geo === t.geo)
  return (
    <>
      <button className={`more-btn ${otherActive ? 'active' : ''}`} title="More tools" onClick={() => setOpen((o) => !o)}>
        <Icon>{I.more}</Icon>
        <span>Tools</span>
      </button>
      {open && (
        <div className="more-bg">
          <MorePanel onClose={() => setOpen(false)}>
            {MORE_TOOLS.map((t) => (
              <button
                key={t.label}
                className={`more-item ${isActive(t) ? 'active' : ''}`}
                onClick={() => {
                  if (t.geo) editor.setStyleForNextShapes(GeoShapeGeoStyle, t.geo)
                  editor.setCurrentTool(t.id)
                  setOpen(false)
                }}
              >
                <span className="more-emoji">{t.emoji}</span>
                {t.label}
              </button>
            ))}
            <button
              className="more-item wide"
              onClick={() => {
                setOpen(false)
                fileInput.current?.click()
              }}
            >
              <span className="more-emoji">📥</span>
              Import worksheet (PDF or photo)
            </button>
          </MorePanel>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,image/*"
        multiple
        hidden
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (!files.length) return
          try {
            const n = await importWorksheets(editor, files, onMessage)
            onMessage(`Added ${n} page${n === 1 ? '' : 's'}. They're locked so you can write on top; right-click (or long-press) → Unlock to move them.`)
          } catch (err) {
            onMessage(`Couldn't import that file: ${err instanceof Error ? err.message : err}`)
          }
        }}
      />
    </>
  )
}

function MorePanel({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, onClose, '.more-btn') // the Tools button itself toggles the panel
  return (
    <div className="more-panel" ref={ref}>
      {children}
    </div>
  )
}
