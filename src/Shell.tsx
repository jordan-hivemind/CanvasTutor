// The notes app: sidebar + the open note (canvas or markdown) with the tutor.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { dialog } from './dialogs'
import { prefetchFolder, prefetchNote } from './noteCache'
import { AuthError } from './api'
import { ContextMenu, FolderInfoDialog, MoveDialog, QuickSwitcher, Sidebar, TrashDialog, stored, store, type MenuTarget } from './NotesUI'
import { flatNotes, notesApi, noteName, YEAR, type NoteKind, type TrashEntry, type TreeNode } from './notesApi'
import { Tutor } from './Tutor'

const WIDE = () => innerWidth >= 900

export function Shell({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [tree, setTree] = useState<TreeNode[] | null>(null)
  const [trash, setTrash] = useState<TrashEntry[]>([])
  const [currentId, setCurrentId] = useState<string | null>(() => new URLSearchParams(location.search).get('note') ?? stored<string | null>('ct-last-note', null))
  const [back, setBack] = useState<string[]>([])
  const [forward, setForward] = useState<string[]>([])
  const [recents, setRecents] = useState<string[]>(() => stored('ct-recents', []))
  const [year, setYearState] = useState<string | null>(() => stored('ct-year', null))
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(stored<string[]>('ct-expanded', [])))
  const [sidebar, setSidebar] = useState(WIDE)
  // the top bar can be hidden for more room (remembered on this device); closing the sidebar hides it
  const [barHidden, setBarHiddenState] = useState(() => {
    try {
      return localStorage.getItem('ct-bar-hidden') === '1'
    } catch {
      return false
    }
  })
  const setBarHidden = useCallback((h: boolean) => {
    setBarHiddenState(h)
    try {
      localStorage.setItem('ct-bar-hidden', h ? '1' : '0')
    } catch {}
  }, [])
  const sidebarWas = useRef(sidebar)
  useEffect(() => {
    if (sidebarWas.current && !sidebar) setBarHidden(true)
    sidebarWas.current = sidebar
  }, [sidebar, setBarHidden])
  const [switcher, setSwitcher] = useState(false)
  const [menu, setMenu] = useState<{ t: MenuTarget; x: number; y: number } | null>(null)
  const [info, setInfo] = useState<{ path: string; field: 'about' | 'memory' } | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [trashed, setTrashed] = useState<{ id: string; name: string } | null>(null)

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof AuthError) return onLoggedOut()
      setToast(e instanceof Error ? e.message : String(e))
    },
    [onLoggedOut],
  )
  useEffect(() => {
    if (!trashed) return
    const t = setTimeout(() => setTrashed(null), 8000)
    return () => clearTimeout(t)
  }, [trashed])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 4500)
    return () => clearTimeout(t)
  }, [toast])

  // ---------- tree, kept live across devices ----------
  const reload = useCallback(
    () =>
      notesApi
        .tree()
        .then((r) => {
          setTree(r.tree)
          setTrash(r.trash)
        })
        .catch(fail),
    [fail],
  )
  useEffect(() => {
    reload()
    let es: EventSource | null = null
    let t: ReturnType<typeof setTimeout> | null = null
    const connect = () => {
      es = new EventSource('/api/events')
      es.onmessage = () => {
        if (t) clearTimeout(t)
        t = setTimeout(reload, 150)
      }
    }
    connect()
    const onVis = () => {
      if (document.visibilityState !== 'visible') return
      reload()
      if (!es || es.readyState === EventSource.CLOSED) connect()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      es?.close()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [reload])

  const notes = useMemo(() => (tree ? flatNotes(tree) : []), [tree])
  const current = notes.find((n) => n.id === currentId) ?? null
  const years = useMemo(() => (tree ?? []).filter((n) => n.type === 'folder' && YEAR.test(n.name)).map((n) => n.name).sort().reverse(), [tree])

  // ---------- prefetch, so opening things feels instant ----------
  const kindOf = useRef(new Map<string, NoteKind>())
  kindOf.current = new Map(notes.map((n) => [n.id, n.kind]))
  useEffect(() => {
    // anything with data-note: start loading it on hover/press (before the click lands)
    const onIntent = (e: Event) => {
      const id = (e.target as HTMLElement | null)?.closest?.('[data-note]')?.getAttribute('data-note')
      const kind = id && kindOf.current.get(id)
      if (id && kind) prefetchNote(kind, id)
    }
    document.addEventListener('pointerover', onIntent, { passive: true })
    document.addEventListener('pointerdown', onIntent, { passive: true })
    document.addEventListener('focusin', onIntent)
    return () => {
      document.removeEventListener('pointerover', onIntent)
      document.removeEventListener('pointerdown', onIntent)
      document.removeEventListener('focusin', onIntent)
    }
  }, [])
  // the few most recent notes load in the background once the app is idle
  const warmed = useRef(false)
  useEffect(() => {
    if (warmed.current || !notes.length) return
    const t = setTimeout(() => {
      warmed.current = true
      for (const id of recents.slice(0, 5)) {
        const k = kindOf.current.get(id)
        if (k && id !== currentId) prefetchNote(k, id)
      }
    }, 1500)
    return () => clearTimeout(t)
  }, [notes, recents, currentId])
  // a folder's menu is open: its About/memory will likely be wanted next
  useEffect(() => {
    if (menu?.t.type !== 'folder') return
    const parts = menu.t.path.split('/')
    parts.forEach((_, i) => prefetchFolder(parts.slice(0, i + 1).join('/')))
  }, [menu])

  // default year: the one you picked last on this device, else the newest
  useEffect(() => {
    if (!tree) return
    if (!year || !years.includes(year)) setYearState(years[0] ?? null)
  }, [tree, years, year])
  const setYear = (y: string) => {
    setYearState(y)
    store('ct-year', y)
  }

  // ---------- navigation ----------
  const open = useCallback(
    (id: string, how: 'push' | 'back' | 'forward' = 'push') => {
      setCurrentId((prev) => {
        if (prev && prev !== id && how === 'push') {
          setBack((b) => [...b.slice(-50), prev])
          setForward([])
        }
        return id
      })
      setRecents((r) => {
        const next = [id, ...r.filter((x) => x !== id)].slice(0, 15)
        store('ct-recents', next)
        return next
      })
      store('ct-last-note', id)
      history.replaceState(null, '', `?note=${encodeURIComponent(id)}`)
      if (!WIDE()) setSidebar(false)
      setSwitcher(false)
    },
    [],
  )
  // reveal the open note in the tree (switch year + expand its folders)
  useEffect(() => {
    if (!current) return
    const parts = current.path.split('/')
    if (YEAR.test(parts[0]) && parts[0] !== year) setYear(parts[0])
    setExpanded((s) => {
      const next = new Set(s)
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join('/'))
      store('ct-expanded', [...next])
      return next
    })
  }, [current?.path])
  // open something sensible on first load
  useEffect(() => {
    if (!tree || current || !notes.length || currentId) return
    // on a new device (nothing recent): the latest note in the newest school year, so that year is selected
    const latest = notes.filter((n) => n.path.startsWith(years[0] + '/')).sort((a, b) => b.updated.localeCompare(a.updated))[0]
    const id = recents.find((r) => notes.some((n) => n.id === r)) ?? latest?.id
    if (id) open(id)
  }, [tree])

  const goBack = () => {
    const prev = back[back.length - 1]
    if (!prev) return
    setBack((b) => b.slice(0, -1))
    if (currentId) setForward((f) => [...f, currentId])
    open(prev, 'back')
  }
  const goForward = () => {
    const next = forward[forward.length - 1]
    if (!next) return
    setForward((f) => f.slice(0, -1))
    if (currentId) setBack((b) => [...b, currentId])
    open(next, 'forward')
  }
  const toggle = (path: string) =>
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      store('ct-expanded', [...next])
      return next
    })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSwitcher((s) => !s)
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  // ---------- actions ----------
  const create = async (kind: NoteKind | 'folder', folder: string) => {
    try {
      if (kind === 'folder') {
        const isYearLevel = !folder
        const name = await dialog.prompt(isYearLevel ? 'New school year' : folder.includes('/') ? 'New subfolder' : `New class in ${folder}`, {
          placeholder: isYearLevel ? 'e.g. 2027-2028' : 'Name',
          ok: 'Create',
        })
        if (!name) return
        const r = await notesApi.createFolder(folder, name)
        if (isYearLevel) setYear(r.path)
        else setExpanded((s) => new Set(s).add(folder).add(r.path))
        return
      }
      const d = new Date()
      const today = `${d.getMonth() + 1}-${d.getDate()}-${String(d.getFullYear()).slice(2)}`
      const name = await dialog.prompt(kind === 'canvas' ? 'New canvas' : 'New note', { value: today, ok: 'Create' })
      if (name === null) return
      const r = await notesApi.createNote(folder, name, kind)
      await reload()
      setExpanded((s) => new Set(s).add(folder))
      open(r.id)
    } catch (e) {
      fail(e)
    }
  }
  const run = (p: Promise<unknown>) => p.then(reload).catch(fail)

  const menuItems = (t: MenuTarget) => {
    if (t.type === 'note')
      return [
        { label: 'Open', run: () => open(t.id) },
        {
          label: 'Rename…',
          run: async () => {
            const name = await dialog.prompt('Rename note', { value: noteName(t.path), ok: 'Rename' })
            if (name) run(notesApi.rename(t.path, name))
          },
        },
        { label: 'Move…', run: () => setMoving(t.path) },
        { label: 'Duplicate', run: () => notesApi.duplicate(t.id).then((r) => (reload(), open(r.id))).catch(fail) },
        '-' as const,
        { label: 'Move to trash', danger: true, run: () => moveToTrash(t.path) },
      ]
    const path = t.path
    const isYear = !path.includes('/')
    return [
      { label: '＋ New note', run: () => create('md', path) },
      { label: '＋ New canvas', run: () => create('canvas', path) },
      { label: isYear ? '＋ New class' : '＋ New subfolder', run: () => create('folder', path) },
      '-' as const,
      { label: 'Edit About…', run: () => setInfo({ path, field: 'about' }) },
      { label: 'Tutor memory…', run: () => setInfo({ path, field: 'memory' }) },
      '-' as const,
      {
        label: 'Rename…',
        run: async () => {
          const name = await dialog.prompt('Rename folder', { value: path.split('/').pop(), ok: 'Rename' })
          if (name)
            notesApi
              .rename(path, name)
              .then((r) => {
                if (isYear && year === path) setYear(r.path)
                reload()
              })
              .catch(fail)
        },
      },
      ...(isYear ? [] : [{ label: 'Move…', run: () => setMoving(path) }]),
      {
        label: 'Move to trash',
        danger: true,
        run: async () => {
          const ok = await dialog.confirm(`Move "${path.split('/').pop()}" to the trash?`, { message: 'Everything inside it goes too. You can restore it from Trash.', ok: 'Move to trash', danger: true })
          if (ok) moveToTrash(path)
        },
      },
    ]
  }

  const moveToTrash = (path: string) =>
    notesApi
      .trash(path)
      .then((r) => {
        setTrashed({ id: r.id, name: noteName(path.split('/').pop()!) })
        return reload()
      })
      .catch(fail)

  /** [[wikilink]] targets: a note with that name (closest to the current note first), or offer to create it. */
  const openByName = async (name: string) => {
    const target = name.trim().toLowerCase()
    const here = current ? current.path.split('/').slice(0, -1).join('/') : ''
    const matches = notes.filter((n) => n.name.toLowerCase() === target || n.path.replace(/\.(md|tldr)$/, '').toLowerCase().endsWith('/' + target))
    if (matches.length) {
      const score = (p: string) => p.split('/').filter((seg, i) => here.split('/')[i] === seg).length
      return open([...matches].sort((a, b) => score(b.path) - score(a.path))[0].id)
    }
    if (await dialog.confirm(`Create "${name}"?`, { message: `There's no note with that name yet. It will be created in ${here || 'the top level'}.`, ok: 'Create note' }))
      notesApi
        .createNote(here, name, 'md')
        .then((r) => reload().then(() => open(r.id)))
        .catch(fail)
  }

  // ---------- render ----------
  const crumbs = current ? current.path.split('/') : []
  const nav = (
    <>
      <button className="corner-btn" title="Notes" onClick={() => setSidebar((s) => !s)}>
        ☰
      </button>
      <button className="corner-btn nav-btn" title="Back" disabled={!back.length} onClick={goBack}>
        ‹
      </button>
      <button className="corner-btn nav-btn" title="Forward" disabled={!forward.length} onClick={goForward}>
        ›
      </button>
      <div className="crumbs">
        {crumbs.map((c, i) =>
          i < crumbs.length - 1 ? (
            <button
              key={i}
              className="crumb"
              onClick={(e) => {
                const folder = crumbs.slice(0, i + 1).join('/')
                if (YEAR.test(crumbs[0])) setYear(crumbs[0])
                setSidebar(true)
                if (i > 0) setExpanded((s) => new Set(s).add(folder))
                setMenu({ t: { type: 'folder', path: folder }, x: e.clientX, y: e.clientY + 16 })
              }}
            >
              {c}
            </button>
          ) : (
            <button
              key={i}
              className="crumb last"
              title="Rename"
              onClick={async () => {
                const name = await dialog.prompt('Rename note', { value: noteName(current!.path), ok: 'Rename' })
                if (name) run(notesApi.rename(current!.path, name))
              }}
            >
              {noteName(c)}
            </button>
          ),
        )}
      </div>
    </>
  )

  return (
    <div className={`shell ${sidebar ? 'with-sidebar' : ''}`}>
      {sidebar && tree && (
        <>
          {!WIDE() && <div className="sb-backdrop" onClick={() => setSidebar(false)} />}
          <Sidebar
            tree={tree}
            trash={trash}
            currentId={currentId}
            recents={recents}
            year={year}
            setYear={setYear}
            expanded={expanded}
            toggle={toggle}
            onOpen={open}
            onMenu={(t, x, y) => setMenu({ t, x, y })}
            onCreate={create}
            onTrash={() => setTrashOpen(true)}
            onClose={WIDE() ? undefined : () => setSidebar(false)}
          />
        </>
      )}
      <main className="main">
        {current ? (
          <Tutor key={current.id} note={current} nav={nav} onSearch={() => setSwitcher(true)} onOpenLink={openByName} onLoggedOut={onLoggedOut} barHidden={barHidden} setBarHidden={setBarHidden} />
        ) : (
          <div className="empty-main">
            <div className="topbar">
              <div className="topbar-nav">{nav}</div>
            </div>
            <div className="empty-msg">
              {tree === null ? (
                <p className="muted">Loading your notes…</p>
              ) : currentId && notes.length ? (
                <p className="muted">That note was moved to the trash or deleted. Pick another from the sidebar.</p>
              ) : (
                <>
                  <h2>Your notes</h2>
                  <p className="muted">Organize by school year, then class. Each class can hold notes, canvases and subfolders.</p>
                  <div className="btns" style={{ justifyContent: 'center' }}>
                    {year ? (
                      <>
                        <button className="primary" onClick={() => create('folder', year)}>
                          ＋ New class in {year}
                        </button>
                      </>
                    ) : (
                      <button className="primary" onClick={() => create('folder', '')}>
                        ＋ New school year
                      </button>
                    )}
                    <button onClick={() => setSwitcher(true)}>🔍 Find a note</button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </main>

      {switcher && tree && <QuickSwitcher tree={tree} recents={recents} onOpen={open} onClose={() => setSwitcher(false)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.t)} onClose={() => setMenu(null)} />}
      {info && <FolderInfoDialog path={info.path} field={info.field} onClose={() => (setInfo(null), reload())} onError={fail} />}
      {moving && tree && (
        <MoveDialog
          path={moving}
          tree={tree}
          onClose={() => setMoving(null)}
          onMove={(to) => {
            setMoving(null)
            run(notesApi.move(moving, to))
          }}
        />
      )}
      {trashOpen && (
        <TrashDialog
          trash={trash}
          onClose={() => setTrashOpen(false)}
          onRestore={(id) => run(notesApi.restore(id))}
          onPurge={async (t) => {
            if (await dialog.confirm(`Delete "${t.name}" forever?`, { message: "This can't be undone.", ok: 'Delete forever', danger: true })) run(notesApi.purge(t.id))
          }}
        />
      )}
      {trashed && (
        <div className="toast toast-actions">
          <span>Moved "{trashed.name}" to Trash</span>
          <button
            onClick={() => {
              const id = trashed.id
              setTrashed(null)
              run(notesApi.restore(id))
            }}
          >
            Undo
          </button>
          <button onClick={() => (setTrashed(null), setTrashOpen(true))}>Open Trash</button>
        </div>
      )}
      {toast && (
        <div className="toast" onClick={() => setToast('')}>
          {toast}
        </div>
      )}
    </div>
  )
}
