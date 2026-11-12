import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Tldraw, type Editor, type TLComponents, type TLShapeId } from 'tldraw'
import { EXPRESS_KEYS, MoreToolsButton, ToolRail } from './ToolRail'
import { useShiftZoom } from './shiftZoom'
import { usePencilMode } from './pencilMode'
import { usePenDoubleTapMenu } from './penMenu'
import { captureOtherCanvas } from './otherCanvas'
import { assetStore } from './assetStore'
import { useNeatening } from './neaten'
import { InkFix, useInkConversion } from './convertInk'
import { usePrefs, useSamples, type Prefs } from './prefs'
import { TeachPad } from './TeachPad'
import { ErrorBoundary } from './ErrorBoundary'
import { useCameraMemory } from './cameraMemory'
import { useDismiss } from './dismiss'
import { useBoardSync } from './boardSync'
import { Plot3DShapeUtil } from './Plot3DShape'
import { CollapsibleStylePanel } from './StylePanel'
import { Placeable, useControlLayout } from './placement'
import { MarkdownNote, type MdApi } from './MarkdownNote'
import type { Comment } from './mdOps'
import type { NoteKind } from './notesApi'
import { api, ask, AuthError, parseReply } from './api'
import { applyOp, captureView, clearAiMarks, followNewContent } from './canvas'
import { renderMarkdown, speakable } from './markdown'
import { LicenseNotice } from './LicenseNotice'
import { useSettings, type Settings } from './settings'
import { SentenceFeeder, setRecording, Speaker, unlockAudio } from './speaker'
import { canListen, canRecord, canSpeak, Dictation, listMics, listVoices, ServerDictation, stopSpeaking } from './voice'

type Phase = 'idle' | 'listening' | 'transcribing' | 'thinking'
type Exchange = { question: string; raw: string; error?: string }

const LICENSE = import.meta.env.VITE_TLDRAW_LICENSE_KEY as string | undefined

// The bottom toolbar is replaced by our side rail + Tools button; notes live in the sidebar.
const SHAPE_UTILS = [Plot3DShapeUtil]
const TLDRAW_COMPONENTS: TLComponents = { Toolbar: null, QuickActions: null, PageMenu: null, HelpMenu: null, ActionsMenu: null, MainMenu: null, StylePanel: CollapsibleStylePanel }

/** Spoken part as the opening paragraph, then the on-screen part (skipping the spoken part if it's repeated). */
function joinReply(say: string, display: string): string {
  if (!say) return display
  if (!display || display.includes(say)) return display || say
  return `${say}\n\n${display}`
}

/** Tells Claude which outputs the student has on, so nothing important ends up only in a hidden one. */
/** Open comment threads, so the tutor can see and answer them. */
function commentsContext(comments: Comment[]): string {
  const open = comments.filter((c) => !c.resolved)
  if (!open.length) return ''
  const lines = open.map((c) => {
    const rs = c.replies.map((r) => `\n    ${r.author}: ${r.text}`).join('')
    return `- [${c.id}] on "${c.quote.slice(0, 200)}" — ${c.author}: ${c.text}${rs}`
  })
  return `\n\n[Open comments]\n${lines.join('\n')}`
}

function outputNote(s: Settings): string {
  if (s.speakReplies && s.showText) return ''
  if (!s.showText && s.speakReplies)
    return '\n[Output] The student has on-screen text turned OFF and only hears the <say> part. Put everything important in <say>. Only simple math can be spoken, so write any non-trivial expression on the board with your tools and refer to it in <say>.'
  if (!s.speakReplies && s.showText) return '\n[Output] Speech is OFF: the student only reads. The <say> part is shown as the first paragraph of the text, so don\'t repeat it after </say>.'
  return '\n[Output] Both speech and on-screen text are OFF; the student only sees the board. Communicate through what you write and draw on the board.'
}

const KOKORO_VOICES: [string, string][] = [
  ['af_heart', 'Heart (US, warm)'],
  ['af_bella', 'Bella (US)'],
  ['af_nicole', 'Nicole (US, soft)'],
  ['af_sarah', 'Sarah (US)'],
  ['am_michael', 'Michael (US)'],
  ['am_fenrir', 'Fenrir (US)'],
  ['am_puck', 'Puck (US)'],
  ['bf_emma', 'Emma (UK)'],
  ['bm_george', 'George (UK)'],
  ['bm_fable', 'Fable (UK)'],
]

/**
 * One open note: the canvas (tldraw) or markdown editor, plus the tutor around it: ask box, mic,
 * reply card, voice, history and settings. `nav` is the sidebar/back/breadcrumb part of the top bar.
 */
export function Tutor({
  note,
  nav,
  onSearch,
  onOpenLink,
  onLoggedOut,
  barHidden,
  setBarHidden,
}: {
  barHidden: boolean
  setBarHidden: (h: boolean) => void
  note: { id: string; kind: NoteKind; path: string }
  nav: React.ReactNode
  onSearch: () => void
  onOpenLink: (name: string) => void
  onLoggedOut: () => void
}) {
  const noteId = note.id
  const [editor, setEditor] = useState<Editor | null>(null)
  const mdText = useRef('')
  const mdApi = useRef<MdApi | null>(null)
  const [settings, setSettings] = useSettings()
  const [phase, setPhase] = useState<Phase>('idle')
  const busyRef = useRef(false)
  const commentQueue = useRef<Comment[]>([])
  const pumpComments = useRef<() => void>(() => {})
  const [replying, setReplying] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [startedAt, setStartedAt] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [transcript, setTranscript] = useState('')
  const [current, setCurrent] = useState<Exchange | null>(null)
  const [cardOpen, setCardOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<Exchange[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [placing, setPlacing] = useState(false)
  const controls = useControlLayout()
  const [typed, setTyped] = useState('')
  const [speaking, setSpeaking] = useState(false)
  const [toast, setToast] = useState('')
  const dictation = useRef<Dictation | ServerDictation | null>(null)
  const [caps, setCaps] = useState({ tts: false, stt: false })
  const speakerRef = useRef<Speaker | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const isCanvas = note.kind === 'canvas'

  // elapsed-time ticker while working
  useEffect(() => {
    if (phase === 'idle') return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [phase])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 5000)
    return () => clearTimeout(t)
  }, [toast])

  const handleError = useCallback(
    (e: unknown) => {
      if (e instanceof AuthError) return onLoggedOut()
      setToast(e instanceof Error ? e.message : String(e))
    },
    [onLoggedOut],
  )

  // ---------- board persistence ----------
  useBoardSync(isCanvas ? editor : null, isCanvas ? noteId : null, handleError)
  useShiftZoom(isCanvas ? editor : null)
  usePencilMode(isCanvas ? editor : null, settings.pencilMode)
  usePenDoubleTapMenu(isCanvas ? editor : null)
  const [prefs, setPrefs] = usePrefs()
  const samples = useSamples(isCanvas && prefs.matchLetters)
  useNeatening(isCanvas ? editor : null, { on: prefs.neaten, match: prefs.matchLetters, strength: prefs.matchStrength, samples })
  const [justConverted, setJustConverted] = useState<TLShapeId | null>(null)
  useInkConversion(isCanvas ? editor : null, prefs.convertInk, noteId, setJustConverted, handleError)
  const [teaching, setTeaching] = useState(false)
  useCameraMemory(isCanvas ? editor : null, isCanvas ? noteId : null)

  useEffect(() => {
    fetch('/api/capabilities', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then(setCaps)
      .catch(() => {})
  }, [])

  // start Claude in the background for this note so the first question is faster
  useEffect(() => {
    api.warm(noteId, settings.model, settings.effort).catch(() => {})
  }, [noteId, settings.model, settings.effort])

  // load this note's conversation
  useEffect(() => {
    setCurrent(null)
    setCardOpen(false)
    api
      .history(noteId)
      .then((r) => setHistory(r.history.map((h) => ({ question: h.question, raw: h.reply }))))
      .catch(handleError)
  }, [noteId, handleError])

  // ---------- asking ----------
  const submit = useCallback(
    async (text: string, extraContext = '', opts: { quiet?: boolean } = {}) => {
      if ((isCanvas && !editor) || !text.trim() || busyRef.current) return
      busyRef.current = true
      const quiet = !!opts.quiet // comment threads: the answer goes in the thread, no card or voice
      stopAudio()
      setPhase('thinking')
      setStatus(isCanvas ? 'Looking at your board' : 'Reading your note')
      setStartedAt(Date.now())
      setNow(Date.now())
      const ex: Exchange = { question: text.trim(), raw: '' }
      setCurrent({ ...ex })
      if (!quiet) setCardOpen(true)
      // speak the <say> part sentence by sentence while it streams in
      let feeder: SentenceFeeder | null = null
      const say = (t: string, final: boolean) => {
        if (quiet || !settings.speakReplies || !t) return
        if (!feeder) {
          const sp = new Speaker({
            engine: settings.voiceEngine,
            kokoroVoice: settings.kokoroVoice,
            browserVoice: settings.voiceName,
            rate: settings.rate,
            onEnd: () => {
              if (speakerRef.current === sp) setSpeaking(false)
            },
          })
          speakerRef.current = sp
          feeder = new SentenceFeeder(sp)
          setSpeaking(true)
        }
        feeder.update(t, final)
      }
      const abort = new AbortController()
      abortRef.current = abort
      try {
        // canvas: a picture of the board; markdown: the note's text
        const view = isCanvas && editor ? await captureView(editor) : null
        const context = (view ? view.context : `[Markdown note content]\n${mdText.current.slice(0, 60000) || '(empty note)'}${commentsContext(mdApi.current?.comments() ?? [])}`) + extraContext
        // tutor edits to the note run one at a time, in order
        let mdChain = Promise.resolve()
        // what the tutor added this turn, so the view can follow it if it wrote off-screen
        const added: string[] = []
        let movedView = false
        await ask(
          {
            noteId,
            text: ex.question,
            image: view?.image,
            context: context + outputNote(settings),
            view: view?.view,
            model: settings.model,
            effort: settings.effort,
          },
          (e) => {
            if (e.type === 'status') setStatus(e.text)
            else if (e.type === 'canvas') {
              if (!editor) return
              applyOp(editor, e.op)
              if (e.op.op === 'view') movedView = true
              else if ('id' in e.op) added.push(e.op.id)
            }
            else if (e.type === 'mdop') {
              mdChain = mdChain.then(async () => {
                const md = mdApi.current
                const result = md ? await md.applyOp(e.op).catch((err) => ({ ok: false, message: String(err) })) : { ok: false, message: 'The note is not open in the editor.' }
                await api.opResult(e.id, result).catch(() => {})
              })
            } else if (e.type === 'snapshot' && e.region && typeof e.region === 'object' && 'note' in e.region) {
              // another canvas, for read_note: rendered without opening it (works from markdown notes too)
              captureOtherCanvas(e.region.note, SHAPE_UTILS, LICENSE)
                .then((v) => api.snapshot({ id: e.id, image: v.image, context: v.context }))
                .catch((err) => api.snapshot({ id: e.id, error: String(err) }).catch(() => {}))
            } else if (e.type === 'snapshot') {
              if (!editor) return void api.snapshot({ id: e.id, error: 'This note has no board' }).catch(() => {})
              // Claude wants to look at the board again (e.g. to check its own marks).
              const region = e.region as Exclude<typeof e.region, { note: string }>
              setTimeout(() => {
                captureView(editor, region)
                  .then((v) => api.snapshot({ id: e.id, image: v.image, context: v.context }))
                  .catch((err) => api.snapshot({ id: e.id, error: String(err) }).catch(() => {}))
              }, 300) // let freshly added images render first
            }
            else if (e.type === 'text') {
              ex.raw += e.delta
              setCurrent({ ...ex })
              const p = parseReply(ex.raw)
              if (p.say) say(p.say, p.sayDone)
            } else if (e.type === 'error') {
              ex.error = e.message
              setCurrent({ ...ex })
            }
          },
          abort.signal,
        )
        const p = parseReply(ex.raw)
        say(p.say || speakable(p.display), true)
        if (editor && added.length && !movedView) setTimeout(() => followNewContent(editor, added), 300)
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          ex.error = e instanceof Error ? e.message : String(e)
          setCurrent({ ...ex })
          setCardOpen(true)
          handleError(e)
        }
      } finally {
        abortRef.current = null
        busyRef.current = false
        setPhase('idle')
        setTimeout(() => pumpComments.current(), 0)
        setHistory((h) => (ex.raw ? [...h, { ...ex }] : h))
      }
    },
    [editor, isCanvas, noteId, phase, settings, handleError],
  )

  /** Every new comment or reply goes to the tutor, one at a time; it answers in the thread. */
  function askAboutComment(c: Comment) {
    commentQueue.current.push(c)
    pumpComments.current()
  }
  pumpComments.current = () => {
    if (busyRef.current) return
    const c = commentQueue.current.shift()
    if (!c) return setReplying(null)
    const last = c.replies.length ? c.replies[c.replies.length - 1] : c
    setReplying(c.id)
    void submit(
      last.text,
      `\n\n[The student wrote this in comment thread ${c.id} (on "${c.quote.slice(0, 200)}"). Answer with reply_comment on that thread. Keep your main reply to one short <say> sentence, since the answer belongs in the thread. Edit the note too only if they asked for that.]`,
      { quiet: true },
    ).finally(() => setReplying((r) => (r === c.id ? null : r)))
  }

  function stopAudio() {
    speakerRef.current?.stop()
    speakerRef.current = null
    stopSpeaking()
    setSpeaking(false)
  }

  // Tapping anywhere outside the ask box closes the keyboard. The board swallows taps, so on touch
  // screens the browser wouldn't do this by itself.
  const askBox = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const box = askBox.current
      if (box && document.activeElement === box && !(e.target instanceof Node && box.form?.contains(e.target))) box.blur()
    }
    window.addEventListener('pointerdown', down, true)
    return () => window.removeEventListener('pointerdown', down, true)
  }, [])

  const cancel = () => {
    api.cancel(noteId).catch(() => {})
    setTimeout(() => abortRef.current?.abort(), 1500)
  }

  // ---------- mic ----------
  // bumped by cancelMic so a transcription that's still running is thrown away
  const micRun = useRef(0)
  const cancelMic = () => {
    micRun.current++
    dictation.current?.cancel()
    dictation.current = null
    setTranscript('')
    setPhase('idle')
  }

  // the mic only needs the record-capable audio mode while listening
  useEffect(() => {
    if (phase !== 'listening') setRecording(false)
  }, [phase])

  // Escape cancels while talking
  useEffect(() => {
    if (phase !== 'listening' && phase !== 'transcribing') return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && cancelMic()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase])

  const toggleMic = async () => {
    if (phase === 'thinking' || phase === 'transcribing') return
    unlockAudio()
    if (phase === 'listening') {
      const d = dictation.current
      dictation.current = null
      const run = micRun.current
      let text = ''
      // recording has stopped; the server is turning it into text
      if (d instanceof ServerDictation) setPhase('transcribing')
      try {
        text = (await d?.stop()) ?? ''
      } catch (e) {
        if (run === micRun.current) setToast(e instanceof Error ? e.message : String(e))
      }
      if (run !== micRun.current) return // cancelled while transcribing
      setTranscript('')
      setPhase('idle')
      if (text) submit(text)
      else setToast("I didn't catch anything. Try again?")
      return
    }
    stopAudio()
    const onErr = (msg: string) => {
      setToast(msg)
      setPhase('idle')
      dictation.current = null
    }
    // Whisper on the server works in every browser; the browser's own recogniser shows words live.
    // a chosen microphone needs recording (the browser's own recogniser always uses the default mic)
    const useWhisper = caps.stt && canRecord() && (settings.speechInput === 'whisper' || (settings.speechInput === 'auto' && (!canListen() || !!settings.micId)))
    if (!useWhisper && !canListen()) return onErr("This browser can't do speech recognition, and the server's Whisper isn't available. Try typing instead.")
    const d = useWhisper ? new ServerDictation(onErr, { id: settings.micId, label: settings.micLabel }) : new Dictation(setTranscript, onErr)
    dictation.current = d
    setTranscript(useWhisper ? 'Recording… tap the mic when you\'re done' : '')
    setPhase('listening')
    setRecording(true)
    d.start()
  }

  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000))
  const parsed = current ? parseReply(current.raw) : null
  // With speech off, the spoken sentence would otherwise never reach the student, so show it too.
  const shown = parsed ? (settings.speakReplies ? parsed.display || parsed.shownSay : joinReply(parsed.shownSay, parsed.display)) : ''

  return (
    <div className={`app ${barHidden ? 'bar-hidden' : ''}`}>
      {barHidden ? (
        <button className="show-bar" title="Show the top bar" onClick={() => setBarHidden(false)}>
          ▾
        </button>
      ) : (
      <div className="topbar">
        <div className="topbar-nav">{nav}</div>
        <div className="topbar-actions">
          <button className="corner-btn" title="Search notes (Ctrl+K)" onClick={onSearch}>
            🔍
          </button>
          <button className="corner-btn" title="This note's conversation" onClick={() => setHistoryOpen(true)}>
            🕘
          </button>
          {current && !cardOpen && settings.showText && (
            <button className="corner-btn" title="Show last reply" onClick={() => setCardOpen(true)}>
              💬
            </button>
          )}
          <button className="corner-btn" title="Settings" onClick={() => setSettingsOpen(true)}>
            ⚙️
          </button>
          <button className="corner-btn hide-bar" title="Hide this bar for more room" onClick={() => setBarHidden(true)}>
            ⌃
          </button>
        </div>
      </div>
      )}

      <div className="note-area">
        {isCanvas ? (
          <>
            <Tldraw
              key={noteId}
              licenseKey={LICENSE}
              components={TLDRAW_COMPONENTS}
              shapeUtils={SHAPE_UTILS}
              assets={assetStore}
              onMount={(e) => {
                setEditor(e)
                e.setCurrentTool('draw')
                if (import.meta.env.DEV) (window as unknown as { editor: Editor }).editor = e
              }}
            />
            {editor && (
              <>
                <ToolRail editor={editor} />
                <MoreToolsButton editor={editor} onMessage={setToast} />
                <InkFix editor={editor} recent={justConverted} onRecent={setJustConverted} onError={handleError} />
              </>
            )}
            <LicenseNotice licenseKey={LICENSE} />
          </>
        ) : (
          <MarkdownNote
            key={noteId}
            id={noteId}
            onText={(t) => (mdText.current = t)}
            onError={handleError}
            onOpenLink={onOpenLink}
            apiRef={mdApi}
            replying={replying}
            onAskTutor={askAboutComment}
          />
        )}
      </div>

      {/* status + reply card, top centre */}
      <div className="top-stack">
        {phase !== 'idle' && (
          <div className={`pill ${phase}`}>
            <span className="dot" />
            {phase === 'listening' ? (
              <>
                <span className="pill-text">{transcript || 'Listening… tap the mic when you\'re done'}</span>
                <button className="pill-btn" onClick={cancelMic} title="Discard what you said (Esc)">
                  Cancel
                </button>
              </>
            ) : phase === 'transcribing' ? (
              <>
                <span className="pill-text">Transcribing…</span>
                <button className="pill-btn" onClick={cancelMic} title="Discard what you said (Esc)">
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span className="pill-text">
                  {status}… <span className="secs">{elapsed}s</span>
                </span>
                <button className="pill-btn" onClick={cancel}>
                  Stop
                </button>
              </>
            )}
          </div>
        )}
        {speaking && phase === 'idle' && (
          <div className="pill speaking">
            <span className="pill-text">🔊 Speaking</span>
            <button
              className="pill-btn"
              onClick={stopAudio}
            >
              Mute
            </button>
          </div>
        )}
        {settings.showText && cardOpen && current && (shown || current.error) && (
          <SwipeCard onDismiss={() => setCardOpen(false)}>
            <div className="card-q">{current.question}</div>
            {shown && <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(shown) }} />}
            {current.error && <div className="card-err">{current.error}</div>}
          </SwipeCard>
        )}
      </div>

      {/* ask box + mic: default bottom right, movable per device (Settings → Move mic & ask box) */}
      {(settings.typeInput || placing) && (
        <Placeable id="ask" className="ask-slot" spot={controls.layout.ask} placing={placing} onPlace={controls.place}>
          <form
            className="type-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (!typed.trim()) return
              unlockAudio()
              const t = typed
              setTyped('')
              submit(t)
            }}
          >
            <textarea
              value={typed}
              rows={1}
              ref={(el) => {
                askBox.current = el
                // grow with the text (up to ~6 lines, then scroll)
                if (!el) return
                el.style.height = 'auto'
                el.style.height = Math.min(el.scrollHeight + 2, 150) + 'px' // + border
              }}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter is a new line; on touch keyboards Return is a new line (send with ➤)
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !matchMedia('(pointer: coarse)').matches) {
                  e.preventDefault()
                  e.currentTarget.form?.requestSubmit()
                }
              }}
              placeholder="Ask anything…"
              disabled={phase === 'thinking' || phase === 'transcribing'}
            />
            {typed.trim() && (
              <button type="submit" className="type-send" title="Send" disabled={phase === 'thinking' || phase === 'transcribing'}>
                ➤
              </button>
            )}
          </form>
        </Placeable>
      )}
      {(settings.voiceInput || placing) && (
        <Placeable id="mic" className="mic-slot" spot={controls.layout.mic} placing={placing} onPlace={controls.place}>
          <button className={`mic ${phase}`} onClick={toggleMic} disabled={phase === 'thinking' || phase === 'transcribing'} title={phase === 'listening' ? 'Done talking' : 'Talk'}>
            {phase === 'listening' ? '■' : '🎤'}
          </button>
        </Placeable>
      )}
      {placing && (
        <div className="placing-bar">
          <span>Drag the mic and the ask box where you want them on this device.</span>
          <button onClick={controls.reset}>Reset</button>
          <button className="primary" onClick={() => setPlacing(false)}>
            Done
          </button>
        </div>
      )}

      {toast && (
        <div className="toast" onClick={() => setToast('')}>
          {toast}
        </div>
      )}

      {historyOpen && (
        <Drawer title="This note's conversation" onClose={() => setHistoryOpen(false)}>
          {history.length === 0 && <p className="muted">Nothing yet.</p>}
          {[...history].reverse().map((h, i) => {
            const p = parseReply(h.raw)
            return (
              <div className="hist" key={i}>
                <div className="card-q">{h.question}</div>
                <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(joinReply(p.shownSay, p.display)) }} />
              </div>
            )
          })}
        </Drawer>
      )}

      {teaching && (
        <ErrorBoundary
          fallback={(err) => (
            <div className="modal-bg dialog-bg" onClick={() => setTeaching(false)}>
              <div className="modal dialog" onClick={(e) => e.stopPropagation()}>
                <p className="dialog-msg">The handwriting pad hit an error: {err.message}</p>
                <div className="dialog-actions">
                  <button className="primary" onClick={() => setTeaching(false)}>
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}
        >
          <TeachPad onClose={() => setTeaching(false)} />
        </ErrorBoundary>
      )}
      {settingsOpen && (
        <SettingsDrawer
          settings={settings}
          set={setSettings}
          prefs={prefs}
          setPrefs={setPrefs}
          onTeach={() => {
            setSettingsOpen(false)
            setTeaching(true)
          }}
          onClose={() => setSettingsOpen(false)}
          onClearMarks={isCanvas ? () => editor && clearAiMarks(editor) : undefined}
          onPlaceControls={() => {
            setSettingsOpen(false)
            setPlacing(true)
          }}
          onNewConversation={async () => {
            await api.reset(noteId).catch(handleError)
            setCurrent(null)
            setHistory([])
            setToast('Started a fresh conversation for this note.')
          }}
          onLogout={async () => {
            await api.logout().catch(() => {})
            onLoggedOut()
          }}
        />
      )}
    </div>
  )
}

/** Reply card: swipe up or sideways to dismiss. Long replies scroll; swipe up on the handle bar to dismiss those. */
function SwipeCard({ children, onDismiss }: { children: React.ReactNode; onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [off, setOff] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [scrollable, setScrollable] = useState(false)
  const drag = useRef<{ x: number; y: number; id: number; axis: 'x' | 'y' | null; fromHandle: boolean; off: { x: number; y: number } } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (el) setScrollable(el.scrollHeight > el.clientHeight + 2)
  })

  const leave = (to: { x: number; y: number }) => {
    setDragging(false)
    setOff(to)
    setTimeout(onDismiss, 180)
  }
  const reset = () => {
    drag.current = null
    setDragging(false)
    setOff({ x: 0, y: 0 })
  }

  return (
    <div
      ref={ref}
      className={`card${dragging ? ' dragging' : ''}`}
      style={{
        transform: `translate(${off.x}px, ${off.y}px)`,
        opacity: 1 - Math.min(0.85, Math.max(Math.abs(off.x) / 300, -off.y / 160)),
        transition: dragging ? 'none' : undefined,
        touchAction: scrollable ? 'pan-y' : 'none',
      }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('button')) return
        const fromHandle = !!(e.target as HTMLElement).closest('.card-handle')
        if (fromHandle) e.preventDefault() // no text selection when grabbing the handle
        drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId, axis: null, fromHandle, off: { x: 0, y: 0 } }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d || d.id !== e.pointerId) return
        const dx = e.clientX - d.x
        const dy = e.clientY - d.y
        if (!d.axis) {
          if (Math.hypot(dx, dy) < 8) return
          d.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
          // on a scrolling card, vertical drags scroll the text unless they start on the handle
          if (d.axis === 'y' && scrollable && !d.fromHandle) {
            drag.current = null
            return
          }
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          setDragging(true)
        }
        window.getSelection()?.removeAllRanges() // a swipe shouldn't leave text selected
        d.off = d.axis === 'x' ? { x: dx, y: 0 } : { x: 0, y: dy < 0 ? dy : dy * 0.15 }
        setOff(d.off)
      }}
      onPointerUp={() => {
        const d = drag.current
        drag.current = null
        if (d?.axis === 'x' && Math.abs(d.off.x) > 90) leave({ x: Math.sign(d.off.x) * 600, y: 0 })
        else if (d?.axis === 'y' && d.off.y < -45) leave({ x: 0, y: -400 })
        else reset()
      }}
      onPointerCancel={reset}
    >
      <div className="card-handle" />
      <button className="card-x" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
      {children}
    </div>
  )
}


function Drawer({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, onClose)
  return (
    <div className="drawer-bg">
      <div className="drawer" ref={ref}>
        <div className="drawer-head">
          <h3>{title}</h3>
          <button className="card-x static" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  )
}

function SettingsDrawer(props: {
  settings: Settings
  set: (p: Partial<Settings>) => void
  prefs: Prefs
  setPrefs: (p: Partial<Prefs>) => void
  onTeach: () => void
  onClose: () => void
  onClearMarks?: () => void
  onPlaceControls: () => void
  onNewConversation: () => void
  onLogout: () => void
}) {
  const { settings: s, set } = props
  const [voices, setVoices] = useState(listVoices)
  useEffect(() => {
    if (!canSpeak()) return
    const f = () => setVoices(listVoices())
    speechSynthesis.addEventListener('voiceschanged', f)
    return () => speechSynthesis.removeEventListener('voiceschanged', f)
  }, [])
  const Toggle = ({ k, label, note }: { k: 'voiceInput' | 'typeInput' | 'speakReplies' | 'showText' | 'pencilMode'; label: string; note?: string }) => (
    <label className="row">
      <span>
        {label}
        {note && <small>{note}</small>}
      </span>
      <input type="checkbox" checked={s[k]} onChange={(e) => set({ [k]: e.target.checked })} />
    </label>
  )
  return (
    <Drawer title="Settings" onClose={props.onClose}>
      <h4>You → tutor</h4>
      <Toggle k="voiceInput" label="Talk (mic button)" />
      <label className="row">
        <span>
          Speech recognition<small>Whisper runs on your server and works in any browser; the browser's own shows words as you speak</small>
        </span>
        <select value={s.speechInput} onChange={(e) => set({ speechInput: e.target.value as Settings['speechInput'] })}>
          <option value="auto">Automatic</option>
          <option value="whisper">Whisper (server)</option>
          <option value="browser" disabled={!canListen()}>This browser{canListen() ? '' : ' (not supported here)'}</option>
        </select>
      </label>
      {canRecord() && <MicPicker id={s.micId} label={s.micLabel} onPick={(m) => set({ micId: m.id, micLabel: m.label })} />}
      <Toggle k="typeInput" label="Type" />
      <div className="btns" style={{ marginTop: 10 }}>
        <button onClick={props.onPlaceControls}>Move mic &amp; ask box…</button>
      </div>
      <p className="muted small">Positions are saved separately on each device.</p>
      <h4>Canvas</h4>
      <Toggle
        k="pencilMode"
        label="Apple Pencil mode"
        note="Only the pencil draws. One finger moves the board, two fingers zoom, and tapping something the tutor made selects it so you can drag it. Double-tap with the pencil for the right-click menu. Saved on this device."
      />
      <label className="row">
        <span>
          Convert handwriting to text
          <small>When you pause, what you just wrote becomes typed text, or typeset math (integrals, limits, Greek letters and all). Tap it to pick another reading, edit it, or turn it back into ink. Applies on all your devices.</small>
        </span>
        <input type="checkbox" checked={props.prefs.convertInk} onChange={(e) => props.setPrefs({ convertInk: e.target.checked })} />
      </label>
      <label className="row">
        <span>
          Neaten handwriting
          <small>Straightens lines, cleans up letters and closes loops that almost meet, while keeping your handwriting. Curves in graphs stay curved. Applies on all your devices.</small>
        </span>
        <input type="checkbox" checked={props.prefs.neaten} onChange={(e) => props.setPrefs({ neaten: e.target.checked })} />
      </label>
      <label className="row">
        <span>
          Match letters and symbols
          <small>Recognises what you wrote from samples of your handwriting and moves it partway toward a clean version. Quick strokes get more help than slow, careful ones. Applies on all your devices.</small>
        </span>
        <input type="checkbox" checked={props.prefs.matchLetters} onChange={(e) => props.setPrefs({ matchLetters: e.target.checked })} />
      </label>
      {props.prefs.matchLetters && (
        <>
          <label className="row">
            <span>How far to move it</span>
            <select value={props.prefs.matchStrength} onChange={(e) => props.setPrefs({ matchStrength: e.target.value as Prefs['matchStrength'] })}>
              <option value="light">A little</option>
              <option value="medium">Halfway</option>
              <option value="strong">Most of the way</option>
              <option value="full">All the way</option>
            </select>
          </label>
          <div className="btns" style={{ marginTop: 6 }}>
            <button onClick={props.onTeach}>Teach my handwriting…</button>
          </div>
        </>
      )}
      <h4>Tutor → you</h4>
      <Toggle k="speakReplies" label="Speak replies out loud" />
      <Toggle k="showText" label="Show replies as text" />
      <label className="row">
        <span>
          Voice engine<small>Kokoro runs on your server and sounds more natural</small>
        </span>
        <select value={s.voiceEngine} onChange={(e) => set({ voiceEngine: e.target.value as Settings['voiceEngine'] })}>
          <option value="kokoro">Kokoro</option>
          <option value="browser">This device's voices</option>
        </select>
      </label>
      {s.voiceEngine === 'kokoro' ? (
        <label className="row">
          <span>Voice</span>
          <select value={s.kokoroVoice} onChange={(e) => set({ kokoroVoice: e.target.value })}>
            {KOKORO_VOICES.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="row">
          <span>Voice</span>
          <select value={s.voiceName} onChange={(e) => set({ voiceName: e.target.value })}>
            <option value="">Automatic</option>
            {voices.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="row">
        <span>Speaking speed</span>
        <input type="range" min={0.7} max={1.6} step={0.05} value={s.rate} onChange={(e) => set({ rate: Number(e.target.value) })} />
      </label>
      <button
        className="link"
        onClick={() => {
          unlockAudio()
          const sp = new Speaker({ engine: s.voiceEngine, kokoroVoice: s.kokoroVoice, browserVoice: s.voiceName, rate: s.rate })
          sp.push("Hi! This is how I sound. Let's work through it together.")
          sp.end()
        }}
      >
        Test voice
      </button>
      {s.voiceEngine === 'browser' && <p className="muted small">On iPad, nicer voices can be downloaded in Settings → Accessibility → Spoken Content → Voices.</p>}
      <h4>Brain</h4>
      <label className="row">
        <span>
          Model<small>Opus is smartest; Sonnet and Haiku are faster</small>
        </span>
        <select value={s.model} onChange={(e) => set({ model: e.target.value as Settings['model'] })}>
          <option value="opus">Opus</option>
          <option value="sonnet">Sonnet</option>
          <option value="haiku">Haiku</option>
        </select>
      </label>
      <label className="row">
        <span>
          Effort<small>Higher = more careful, slower</small>
        </span>
        <select value={s.effort} onChange={(e) => set({ effort: e.target.value as Settings['effort'] })}>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </label>
      <h4>Tablet express keys</h4>
      <p className="muted small">
        {Object.entries(EXPRESS_KEYS)
          .map(([key, k]) => `${key}: ${k.label}`)
          .join(' · ')}
      </p>
      <h4>This note</h4>
      <div className="btns">
        {props.onClearMarks && <button onClick={props.onClearMarks}>Clear tutor's marks</button>}
        <button onClick={props.onNewConversation}>New conversation</button>
      </div>
      <h4>Account</h4>
      <div className="btns">
        <button onClick={props.onLogout}>Sign out of this device</button>
      </div>
    </Drawer>
  )
}

/** Pick which microphone to use on this device (saved per device, like all settings). */
function MicPicker({ id, label, onPick }: { id: string; label: string; onPick: (m: { id: string; label: string }) => void }) {
  const [mics, setMics] = useState<{ id: string; label: string }[] | null>(null)
  const [err, setErr] = useState('')
  const load = (ask: boolean) =>
    listMics(ask)
      .then((m) => (setMics(m), setErr('')))
      .catch(() => setErr('Allow microphone access to see the list.'))
  useEffect(() => {
    void load(false)
  }, [])
  const named = !!mics?.some((m) => !/^Microphone \d+$/.test(m.label))
  const missing = id && mics && named && !mics.some((m) => m.id === id || m.label === label)
  return (
    <>
      <label className="row">
        <span>
          Microphone<small>Saved on this device only</small>
        </span>
        {named ? (
          <select
            value={mics!.some((m) => m.id === id) ? id : (mics!.find((m) => m.label === label)?.id ?? (id ? '__missing' : ''))}
            onChange={(e) => onPick(e.target.value ? mics!.find((m) => m.id === e.target.value)! : { id: '', label: '' })}
          >
            <option value="">System default</option>
            {missing && <option value="__missing">{label || 'Saved microphone'} (not connected)</option>}
            {mics!.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        ) : (
          <button onClick={() => void load(true)}>{label ? `${label} · change…` : 'Choose…'}</button>
        )}
      </label>
      {err && <p className="muted small">{err}</p>}
    </>
  )
}
