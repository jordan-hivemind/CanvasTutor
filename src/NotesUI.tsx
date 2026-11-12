// Notes navigation UI: sidebar tree, quick switcher, context menu, and the folder/move/trash dialogs.
import { useEffect, useMemo, useRef, useState } from 'react'
import { flatFolders, flatNotes, notesApi, noteName, YEAR, type NoteKind, type SearchResult, type TrashEntry, type TreeNode } from './notesApi'
import { peekFolder, prefetchFolder, setFolderCache } from './noteCache'

export const kindIcon = (k: NoteKind) => (k === 'canvas' ? '🎨' : '📝')

function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
function store(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {}
}

export type MenuTarget = { type: 'folder'; path: string } | { type: 'note'; id: string; path: string; kind: NoteKind } | { type: 'root'; path: string }

/** Long-press (touch/pen) or right-click opens the context menu. */
function useMenuHandlers(open: (x: number, y: number) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  return {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      open(e.clientX, e.clientY)
    },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse') return
      fired.current = false
      start.current = { x: e.clientX, y: e.clientY }
      timer.current = setTimeout(() => {
        fired.current = true
        open(e.clientX, e.clientY)
      }, 550)
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10 && timer.current) clearTimeout(timer.current)
    },
    onPointerUp: () => timer.current && clearTimeout(timer.current),
    onPointerCancel: () => timer.current && clearTimeout(timer.current),
    /** true if this tap was the end of a long-press (so don't also open the item) */
    consumed: () => {
      const f = fired.current
      fired.current = false
      return f
    },
  }
}

// ---------------------------------------------------------------- sidebar

export function Sidebar(props: {
  tree: TreeNode[]
  trash: TrashEntry[]
  currentId: string | null
  recents: string[]
  year: string | null
  setYear: (y: string) => void
  expanded: Set<string>
  toggle: (path: string) => void
  onOpen: (id: string) => void
  onMenu: (t: MenuTarget, x: number, y: number) => void
  onCreate: (kind: NoteKind | 'folder', folder: string) => void
  onTrash: () => void
  onClose?: () => void
}) {
  const [filter, setFilter] = useState('')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const years = useMemo(() => props.tree.filter((n) => n.type === 'folder' && YEAR.test(n.name)).map((n) => n.name).sort().reverse(), [props.tree])
  const yearNode = props.tree.find((n): n is Extract<TreeNode, { type: 'folder' }> => n.type === 'folder' && n.name === props.year)
  const others = props.tree.filter((n) => !(n.type === 'folder' && YEAR.test(n.name)))
  const notesById = useMemo(() => new Map(flatNotes(props.tree).map((n) => [n.id, n])), [props.tree])

  useEffect(() => {
    if (!filter.trim()) return setResults(null)
    const t = setTimeout(() => notesApi.search(filter).then((r) => setResults(r.results)).catch(() => {}), 150)
    return () => clearTimeout(t)
  }, [filter])

  return (
    <nav className="sidebar">
      <div className="sb-head">
        <select className="sb-year" value={props.year ?? ''} onChange={(e) => (e.target.value === '__new__' ? props.onCreate('folder', '') : props.setYear(e.target.value))}>
          {!props.year && <option value="">No school year yet</option>}
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
          <option value="__new__">＋ New school year…</option>
        </select>
        {props.year && (
          <button
            className="sb-icon"
            title="School year: About, Tutor memory, rename…"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              props.onMenu({ type: 'folder', path: props.year! }, r.left, r.bottom + 4)
            }}
          >
            ⋯
          </button>
        )}
        {props.onClose && (
          <button className="sb-icon" title="Close" onClick={props.onClose}>
            ✕
          </button>
        )}
      </div>
      <input className="sb-filter" placeholder="Search notes…" value={filter} onChange={(e) => setFilter(e.target.value)} />

      <div className="sb-scroll">
        {results ? (
          <div className="sb-section">
            {results.length === 0 && <p className="muted small sb-pad">No matches.</p>}
            {results.map((r) => (
              <button key={r.id} data-note={r.id} className={`sb-result ${r.id === props.currentId ? 'current' : ''}`} onClick={() => props.onOpen(r.id)}>
                <span>
                  {kindIcon(r.kind)} {r.name}
                </span>
                <small>{r.path.split('/').slice(0, -1).join(' › ')}</small>
                {r.snippet && <small className="sb-snippet">{r.snippet}</small>}
              </button>
            ))}
          </div>
        ) : (
          <>
            {props.recents.length > 0 && (
              <div className="sb-section">
                <div className="sb-label">Recent</div>
                {props.recents
                  .map((id) => notesById.get(id))
                  .filter(Boolean)
                  .slice(0, 5)
                  .map((n) => (
                    <NoteRow key={'r' + n!.id} n={n!} {...props} depth={0} showPath />
                  ))}
              </div>
            )}
            <div className="sb-section">
              <div className="sb-label">
                Classes
                {props.year && (
                  <button className="sb-add" title={`New class in ${props.year}`} onClick={() => props.onCreate('folder', props.year!)}>
                    ＋
                  </button>
                )}
              </div>
              {!yearNode && <p className="muted small sb-pad">Create a school year to get started.</p>}
              {yearNode?.children.map((n) => <TreeRow key={n.path} n={n} depth={0} {...props} />)}
              {yearNode && !yearNode.children.length && <p className="muted small sb-pad">No classes yet: tap ＋ to add one.</p>}
            </div>
            {others.length > 0 && (
              <div className="sb-section">
                <div className="sb-label">Other</div>
                {others.map((n) => (
                  <TreeRow key={n.path} n={n} depth={0} {...props} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <div className="sb-foot">
        <button onClick={props.onTrash}>🗑️ Trash{props.trash.length ? ` (${props.trash.length})` : ''}</button>
      </div>
    </nav>
  )
}

type RowProps = Parameters<typeof Sidebar>[0] & { depth: number }

function TreeRow(props: RowProps & { n: TreeNode }) {
  const { n } = props
  return n.type === 'note' ? <NoteRow {...props} n={n} /> : <FolderRow {...props} n={n} />
}

function FolderRow(props: RowProps & { n: Extract<TreeNode, { type: 'folder' }> }) {
  const { n } = props
  const open = props.expanded.has(n.path)
  const menu = useMenuHandlers((x, y) => props.onMenu({ type: 'folder', path: n.path }, x, y))
  const [adding, setAdding] = useState<{ x: number; y: number } | null>(null)
  return (
    <>
      <div className="sb-row folder" style={{ paddingLeft: 8 + props.depth * 14 }} {...menu}>
        <button className="sb-main" onClick={() => !menu.consumed() && props.toggle(n.path)}>
          <span className="sb-caret">{open ? '▾' : '▸'}</span> {n.name}
          {n.hasInfo && <span className="sb-info" title="Has About / tutor memory">ⓘ</span>}
        </button>
        <button
          className="sb-more sb-plus"
          title={`New note or canvas in ${n.name}`}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setAdding({ x: r.left, y: r.bottom + 4 })
          }}
        >
          ＋
        </button>
        {adding && (
          <ContextMenu
            x={adding.x}
            y={adding.y}
            onClose={() => setAdding(null)}
            items={[
              { label: '📝 New note', run: () => props.onCreate('md', n.path) },
              { label: '🎨 New canvas', run: () => props.onCreate('canvas', n.path) },
            ]}
          />
        )}
        <button className="sb-more" title="More" onClick={(e) => props.onMenu({ type: 'folder', path: n.path }, e.clientX, e.clientY)}>
          ⋯
        </button>
      </div>
      {open && (
        <>
          {n.children.map((c) => (
            <TreeRow key={c.path} {...props} n={c} depth={props.depth + 1} />
          ))}
          {!n.children.length && (
            <div className="sb-empty" style={{ paddingLeft: 30 + props.depth * 14 }}>
              <button onClick={() => props.onCreate('md', n.path)}>＋ note</button>
              <button onClick={() => props.onCreate('canvas', n.path)}>＋ canvas</button>
            </div>
          )}
        </>
      )}
    </>
  )
}

function NoteRow(props: RowProps & { n: Extract<TreeNode, { type: 'note' }>; showPath?: boolean }) {
  const { n } = props
  const menu = useMenuHandlers((x, y) => props.onMenu({ type: 'note', id: n.id, path: n.path, kind: n.kind }, x, y))
  return (
    <div className={`sb-row note ${n.id === props.currentId ? 'current' : ''}`} style={{ paddingLeft: 8 + props.depth * 14 }} {...menu}>
      <button className="sb-main" data-note={n.id} onClick={() => !menu.consumed() && props.onOpen(n.id)}>
        <span className="sb-kind">{kindIcon(n.kind)}</span> {n.name}
        {props.showPath && <small className="sb-path">{n.path.split('/').slice(1, -1).join(' › ')}</small>}
      </button>
      <button className="sb-more" title="More" onClick={(e) => props.onMenu({ type: 'note', id: n.id, path: n.path, kind: n.kind }, e.clientX, e.clientY)}>
        ⋯
      </button>
    </div>
  )
}

// ---------------------------------------------------------------- context menu

export type MenuItem = { label: string; run: () => void; danger?: boolean; disabled?: boolean; hint?: string } | '-'

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ x: Math.min(x, innerWidth - r.width - 8), y: Math.min(y, innerHeight - r.height - 8) })
  }, [x, y])
  return (
    <div className="ctx-bg" onMouseDown={(e) => e.preventDefault()} onClick={onClose} onContextMenu={(e) => (e.preventDefault(), onClose())}>
      <div className="ctx" ref={ref} style={{ left: pos.x, top: pos.y }} onClick={(e) => e.stopPropagation()}>
        {items.map((it, i) =>
          it === '-' ? (
            <div key={i} className="ctx-sep" />
          ) : (
            <button
              key={i}
              className={it.danger ? 'danger' : ''}
              disabled={it.disabled}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onClose()
                it.run()
              }}
            >
              {it.label}
              {it.hint && <span className="ctx-hint">{it.hint}</span>}
            </button>
          ),
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- quick switcher

export function QuickSwitcher({ tree, recents, onOpen, onClose }: { tree: TreeNode[]; recents: string[]; onOpen: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [server, setServer] = useState<SearchResult[]>([])
  const [sel, setSel] = useState(0)
  const all = useMemo(() => flatNotes(tree), [tree])
  useEffect(() => {
    if (!q.trim()) return setServer([])
    const t = setTimeout(() => notesApi.search(q).then((r) => setServer(r.results)).catch(() => {}), 120)
    return () => clearTimeout(t)
  }, [q])
  const items = useMemo(() => {
    if (!q.trim()) {
      const byId = new Map(all.map((n) => [n.id, n]))
      const rec = recents.map((id) => byId.get(id)).filter(Boolean) as typeof all
      const rest = [...all].filter((n) => !recents.includes(n.id)).sort((a, b) => b.updated.localeCompare(a.updated))
      return [...rec, ...rest].slice(0, 30).map((n) => ({ id: n.id, name: n.name, path: n.path, kind: n.kind, snippet: '' }))
    }
    return server
  }, [q, server, all, recents])
  useEffect(() => setSel(0), [q])
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="switcher" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Find a note by name or what's in it…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(items.length - 1, s + 1)))
            else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(0, s - 1)))
            else if (e.key === 'Enter' && items[sel]) onOpen(items[sel].id)
            else if (e.key === 'Escape') onClose()
          }}
        />
        <div className="switcher-list">
          {!q.trim() && <div className="sb-label">Recent &amp; latest</div>}
          {items.map((r, i) => (
            <button key={r.id} data-note={r.id} className={`sb-result ${i === sel ? 'current' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => onOpen(r.id)}>
              <span>
                {kindIcon(r.kind)} {r.name}
              </span>
              <small>{r.path.split('/').slice(0, -1).join(' › ') || 'Top level'}</small>
              {r.snippet && <small className="sb-snippet">{r.snippet}</small>}
            </button>
          ))}
          {q.trim() && !items.length && <p className="muted small sb-pad">No matches.</p>}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- dialogs

function Modal({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>{title}</h3>
          <button className="card-x static" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

/** About (the folder's system prompt) or Tutor memory, with what it inherits shown for context. */
export function FolderInfoDialog({ path, field, onClose, onError }: { path: string; field: 'about' | 'memory'; onClose: () => void; onError: (e: unknown) => void }) {
  const [value, setValue] = useState<string | null>(null)
  const [inherited, setInherited] = useState<{ folder: string; text: string }[]>([])
  const [saving, setSaving] = useState(false)
  const dirty = useRef(false)
  useEffect(() => {
    // show the cached copy (usually fetched when the menu opened) right away, then the fresh one
    const cached = peekFolder(path)
    cached?.then((i) => setValue((v) => v ?? i[field])).catch(() => {})
    prefetchFolder(path, true)
    peekFolder(path)!
      .then((i) => !dirty.current && setValue(i[field]))
      .catch(onError)
    const parents = path.split('/').slice(0, -1).map((_, i, arr) => arr.slice(0, i + 1).join('/'))
    for (const p of parents) prefetchFolder(p)
    Promise.all(parents.map((p) => peekFolder(p)!.then((i) => ({ folder: p, text: i[field] }))))
      .then((r) => setInherited(r.filter((x) => x.text.trim())))
      .catch(() => {})
  }, [path, field, onError])
  const name = path.split('/').pop()
  const isAbout = field === 'about'
  return (
    <Modal title={`${isAbout ? 'About' : 'Tutor memory'}: ${name}`} onClose={onClose} wide>
      <p className="muted small">
        {isAbout
          ? 'Tell the tutor about this folder: the class, teacher, textbook, what you are studying, how you like to be taught. Everything inside this folder (classes, subfolders, notes) uses it, on top of what its parent folders say.'
          : 'What the tutor remembers about this folder. It adds to this itself as you work (things you find hard, conventions your teacher uses…), and notes inside this folder see it. You can edit or clear it.'}
      </p>
      {inherited.length > 0 && (
        <details className="inherited">
          <summary>Also applies here, from parent folders ({inherited.length})</summary>
          {inherited.map((i) => (
            <div key={i.folder}>
              <strong>{i.folder}</strong>
              <pre>{i.text}</pre>
            </div>
          ))}
        </details>
      )}
      {value === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <textarea className="info-text" value={value} onChange={(e) => ((dirty.current = true), setValue(e.target.value))} placeholder={isAbout ? 'e.g. AP Physics C: Mechanics with Mr. Lee. Textbook: Halliday 10th ed. Tests are mostly free-response.' : '(empty)'} rows={12} />
      )}
      <div className="btns" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
        <button onClick={onClose}>Cancel</button>
        <button
          className="primary"
          disabled={value === null || saving}
          onClick={async () => {
            setSaving(true)
            try {
              setFolderCache(path, await notesApi.setFolderInfo(path, { [field]: value ?? '' }))
              onClose()
            } catch (e) {
              onError(e)
              setSaving(false)
            }
          }}
        >
          Save
        </button>
      </div>
    </Modal>
  )
}

export function MoveDialog({ path, tree, onMove, onClose }: { path: string; tree: TreeNode[]; onMove: (to: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const folders = useMemo(() => [''].concat(flatFolders(tree)).filter((f) => f !== path && !f.startsWith(path + '/')), [tree, path])
  const shown = folders.filter((f) => f.toLowerCase().includes(q.toLowerCase()))
  const here = path.split('/').slice(0, -1).join('/')
  return (
    <Modal title={`Move "${noteName(path)}"`} onClose={onClose}>
      <input className="sb-filter" autoFocus placeholder="Find a folder…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="move-list">
        {shown.map((f) => (
          <button key={f || '(top)'} disabled={f === here} onClick={() => onMove(f)} style={{ paddingLeft: 10 + (f ? f.split('/').length - 1 : 0) * 14 }}>
            📁 {f ? f.split('/').pop() : 'Top level'}
            {f && f.includes('/') && <small> {f.split('/').slice(0, -1).join(' › ')}</small>}
            {f === here && <small> (current)</small>}
          </button>
        ))}
      </div>
    </Modal>
  )
}

export function TrashDialog({ trash, onRestore, onPurge, onClose }: { trash: TrashEntry[]; onRestore: (id: string) => void; onPurge: (t: TrashEntry) => void; onClose: () => void }) {
  return (
    <Modal title="Trash" onClose={onClose}>
      {trash.length === 0 ? <p className="muted">The trash is empty.</p> : <p className="muted small">Items are deleted for good after 30 days.</p>}
      {trash.map((t) => (
        <div key={t.id} className="trash-row">
          <span>
            {t.kind === 'folder' ? '📁' : kindIcon(t.kind)} {t.name}
            <small className="muted"> from {t.from.split('/').slice(0, -1).join(' › ') || 'top level'} · {daysLeft(t.at)}</small>
          </span>
          <button onClick={() => onRestore(t.id)}>Restore</button>
          <button className="danger" onClick={() => onPurge(t)}>
            Delete forever
          </button>
        </div>
      ))}
    </Modal>
  )
}

export { stored, store }

const daysLeft = (at: string) => {
  const d = Math.max(0, Math.ceil(30 - (Date.now() - Date.parse(at)) / 86_400_000))
  return d <= 1 ? 'deleted within a day' : `${d} days left`
}
