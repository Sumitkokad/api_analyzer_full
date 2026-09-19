import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/* ==========================================================================
   ProductTourModal — API Analyzer Interactive Showcase  (v2, narration-driven)
   --------------------------------------------------------------------------
   WHAT CHANGED vs. v1
   --------------------------------------------------------------------------
   v1 drove the whole tour from a fixed clock (6.5s per scene). Speech
   synthesis needs ~10-11s to read those narrations, so `speechSynthesis.cancel()`
   fired mid-sentence every time a scene boundary was crossed → clipped audio.

   v2 inverts the ownership:
     • The NARRATION is the clock. A scene advances only when
          (a) the voice reported `onend` (or the watchdog proved it finished),
          (b) a minimum dwell elapsed, and
          (c) a short "tail hold" passed so the last syllable breathes.
     • A watchdog timer guarantees the tour can NEVER stall if a browser
       swallows the `onend` event (a well-known Chrome/Safari quirk).
     • A token guard makes sure a cancelled utterance can never mark a
       freshly started scene as "done".
     • The progress bar uses a soft asymptotic curve, so it keeps creeping
       forward smoothly and never jumps backwards when a scene runs long.
     • Muted / unsupported-speech mode falls back to a comfortable reading
       dwell so the tour still flows.
     • All motion softened: gentler Ken-Burns, no blur-in, longer fades.

   Class names are 100% preserved (.modal-backdrop, .video-modal-card,
   .real-video-wrapper, .video-chapters, .modal-footer, …) so the drop-in
   replacement keeps working with your existing modal CSS.
   ========================================================================== */

/* --------------------------------------------------------------------------
   Timing constants — tune the feel of the whole tour here
   -------------------------------------------------------------------------- */
const MIN_DWELL = 3.2        // absolute floor a scene stays on screen (seconds @1x)
const SILENT_DWELL = 8.5     // scene length when narration is muted / unavailable
const TAIL_HOLD = 0.7        // quiet breathing room after the voice stops
const SPEECH_WPS = 2.6       // approx. words-per-second of a natural voice @ rate 1
const WATCHDOG_SLACK = 1.9   // safety multiplier if `onend` is never delivered
const WATCHDOG_EXTRA = 4     // extra seconds added to the watchdog
const SPEECH_RATE_BASE = 0.98
const SPEECH_RATE_MIN = 0.82
const SPEECH_RATE_MAX = 1.35

/* ==========================================================================
   Scene script
   ========================================================================== */
const TOUR_SCENES = [
  {
    id: 'ingest',
    stage: 'STAGE 01',
    tag: 'Contract Input',
    title: 'Start with two API contracts',
    detail:
      'Load baseline production and staging specifications side by side. The workspace highlights structural schema differences before analysis begins.',
    narration:
      "Let's start with two versions of the API contract. API Analyzer loads the baseline production specification alongside the proposed staging branch to prepare the exact diff.",
    render: SceneIngest,
  },
  {
    id: 'ast',
    stage: 'STAGE 02',
    tag: 'AST Processing',
    title: 'Analyze every structural change',
    detail:
      'The deterministic engine parses both documents and traverses every path, parameter, and schema node without relying on LLM guessing.',
    narration:
      'Next, the deterministic AST engine parses endpoints, parameters, and schemas structurally, pinpointing exact property changes without any guessing.',
    render: SceneAst,
  },
  {
    id: 'classify',
    stage: 'STAGE 03',
    tag: 'Rules Engine',
    title: 'Determine compatibility impact',
    detail:
      'Deterministic compatibility rules classify changes into breaking or safe. The rule engine is authoritative and cannot be overridden by AI.',
    narration:
      'Those changes are evaluated against deterministic compatibility rules, instantly separating breaking modifications from backwards-compatible additions.',
    render: SceneClassify,
  },
  {
    id: 'ai',
    stage: 'STAGE 04',
    tag: 'LLM Analysis',
    title: 'Understand downstream impact with AI',
    detail:
      'Once a breaking change is detected, AI explains why it breaks consumers, isolates vulnerable SDKs, and formulates remediation guidance.',
    narration:
      'Once a risk is detected, the AI engine explains the downstream impact, identifies vulnerable client SDKs, and formulates clear remediation advice backed by RAG evidence.',
    render: SceneAi,
  },
  {
    id: 'release',
    stage: 'STAGE 05',
    tag: 'CI/CD Gate',
    title: 'Review the audit and move toward release',
    detail:
      'Every comparison run is stored for auditability, enabling automated CI/CD release gate decisions before code merges into production.',
    narration:
      'Finally, the comparison is recorded in the audit history and verified by automated CI/CD release gates, giving your team confidence before deploying to production.',
    render: SceneRelease,
  },
]

/* --------------------------------------------------------------------------
   Speech length estimation — used for the progress bar and the watchdog
   -------------------------------------------------------------------------- */
function estimateSpeechSeconds(text, rate = 1) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length
  return words / (SPEECH_WPS * Math.max(0.5, rate))
}

/**
 * Per-scene nominal duration (used ONLY for the progress bar geometry and the
 * seek mapping — the real runtime is always dictated by the voice).
 */
function sceneNominalDuration(scene) {
  return Math.max(MIN_DWELL, estimateSpeechSeconds(scene.narration, 1)) + TAIL_HOLD
}

const SCENE_DURATIONS = TOUR_SCENES.map(sceneNominalDuration)
const SCENE_STARTS = SCENE_DURATIONS.reduce((acc, d, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + SCENE_DURATIONS[i - 1])
  return acc
}, [])
const TOTAL_DURATION = SCENE_DURATIONS.reduce((a, b) => a + b, 0)

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

/* ==========================================================================
   Component
   ========================================================================== */
export default function ProductTourModal({ onClose, onStartCompare }) {
  const [sceneIndex, setSceneIndex] = useState(0)
  const [sceneElapsed, setSceneElapsed] = useState(0)
  const [isPlaying, setIsPlaying] = useState(true)
  const [isFinished, setIsFinished] = useState(false)
  const [muted, setMuted] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [cycle, setCycle] = useState(0)
  const [hoverPct, setHoverPct] = useState(null)

  /* ---- refs: the animation loop reads these, never stale closures ---- */
  const sceneIndexRef = useRef(0)
  const sceneElapsedRef = useRef(0)
  const isPlayingRef = useRef(true)
  const mutedRef = useRef(false)
  const speedRef = useRef(1)

  const speechDoneRef = useRef(false)      // has the current narration finished?
  const speechDoneAtRef = useRef(0)        // sceneElapsed value when it finished
  const speechTokenRef = useRef(0)         // guards against stale utterance callbacks
  const watchdogRef = useRef(null)
  const selectedVoiceRef = useRef(null)

  const rafRef = useRef(null)
  const lastFrameRef = useRef(null)
  const progressTrackRef = useRef(null)
  const mountedRef = useRef(true)

  const ttsAvailable =
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.SpeechSynthesisUtterance === 'function'

  /* ------------------------------------------------------------------
     Voice selection — highest quality natural voice available
     ------------------------------------------------------------------ */
  useEffect(() => {
    if (!ttsAvailable) return undefined

    const chooseVoice = () => {
      let voices = []
      try {
        voices = window.speechSynthesis.getVoices() || []
      } catch {
        return
      }
      if (!voices.length) return

      const preferredNames = [
        'Natural', 'Google US English', 'Google UK English Female',
        'Samantha', 'Aria', 'Jenny', 'Michelle', 'Daniel', 'Karen',
      ]
      const natural = voices.find(
        (v) => v.lang && v.lang.startsWith('en') && preferredNames.some((n) => v.name.includes(n))
      )
      selectedVoiceRef.current =
        natural ||
        voices.find((v) => v.lang === 'en-US') ||
        voices.find((v) => v.lang && v.lang.startsWith('en')) ||
        voices[0]
    }

    chooseVoice()
    try {
      window.speechSynthesis.addEventListener('voiceschanged', chooseVoice)
    } catch {
      /* older browsers */
    }
    return () => {
      try {
        window.speechSynthesis.removeEventListener('voiceschanged', chooseVoice)
      } catch {
        /* noop */
      }
    }
  }, [ttsAvailable])

  /* ------------------------------------------------------------------
     Speech primitives
     ------------------------------------------------------------------ */
  const stopSpeech = useCallback(() => {
    // Bump the token first so any in-flight utterance callback is ignored.
    speechTokenRef.current += 1
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current)
      watchdogRef.current = null
    }
    if (!ttsAvailable) return
    try {
      window.speechSynthesis.cancel()
    } catch {
      /* noop */
    }
  }, [ttsAvailable])

  /**
   * Start (or restart) the narration for a scene.
   * Marks `speechDoneRef` immediately when narration is not in play, so the
   * scene can retire after its minimum dwell.
   */
  const startScene = useCallback(
    (index) => {
      stopSpeech()
      const token = speechTokenRef.current

      speechDoneRef.current = false
      speechDoneAtRef.current = 0

      const scene = TOUR_SCENES[index]
      if (!scene) return

      const narrationActive = ttsAvailable && !mutedRef.current && isPlayingRef.current

      if (!narrationActive) {
        // Muted or unsupported: the silent dwell governs the scene length.
        speechDoneRef.current = true
        speechDoneAtRef.current = 0
        return
      }

      const rate = Math.min(
        SPEECH_RATE_MAX,
        Math.max(SPEECH_RATE_MIN, SPEECH_RATE_BASE * speedRef.current)
      )

      let utterance
      try {
        utterance = new window.SpeechSynthesisUtterance(scene.narration)
      } catch {
        speechDoneRef.current = true
        return
      }

      if (selectedVoiceRef.current) utterance.voice = selectedVoiceRef.current
      utterance.rate = rate
      utterance.pitch = 1
      utterance.volume = 1

      const settle = () => {
        if (speechTokenRef.current !== token) return // a newer scene took over
        if (speechDoneRef.current) return
        speechDoneRef.current = true
        speechDoneAtRef.current = sceneElapsedRef.current
        if (watchdogRef.current) {
          clearTimeout(watchdogRef.current)
          watchdogRef.current = null
        }
      }

      utterance.onend = settle
      utterance.onerror = settle

      // Watchdog: guarantees forward motion even if `onend` never arrives.
      const estimated = estimateSpeechSeconds(scene.narration, rate)
      watchdogRef.current = setTimeout(
        settle,
        (estimated * WATCHDOG_SLACK + WATCHDOG_EXTRA) * 1000
      )

      try {
        const synth = window.speechSynthesis
        if (synth.speaking || synth.pending) synth.cancel()
        // A micro-delay lets Chrome flush the cancel before accepting the
        // next utterance (prevents silently swallowed speech).
        window.setTimeout(() => {
          if (!mountedRef.current || speechTokenRef.current !== token) return
          try {
            synth.speak(utterance)
          } catch {
            settle()
          }
        }, 40)
      } catch {
        settle()
      }
    },
    [stopSpeech, ttsAvailable]
  )

  /* ------------------------------------------------------------------
     Master animation clock — advances sceneElapsed only.
     Scene retirement is decided here, from speech state.
     ------------------------------------------------------------------ */
  useEffect(() => {
    isPlayingRef.current = isPlaying

    if (!isPlaying) {
      lastFrameRef.current = null
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      return undefined
    }

    let cancelled = false

    const step = (now) => {
      if (cancelled) return

      if (lastFrameRef.current == null) lastFrameRef.current = now
      // Clamp dt so a backgrounded tab does not fast-forward the tour.
      const dt = Math.min(0.2, Math.max(0, (now - lastFrameRef.current) / 1000))
      lastFrameRef.current = now

      const idx = sceneIndexRef.current
      const t = sceneElapsedRef.current + dt * speedRef.current

      const narrationActive = ttsAvailable && !mutedRef.current
      const minDwell = narrationActive ? MIN_DWELL : SILENT_DWELL

      const canRetire =
        speechDoneRef.current &&
        t >= minDwell &&
        t >= speechDoneAtRef.current + (narrationActive ? TAIL_HOLD : 0)

      if (canRetire) {
        if (idx >= TOUR_SCENES.length - 1) {
          // ---- tour complete -------------------------------------------
          sceneElapsedRef.current = t
          setSceneElapsed(t)
          setIsPlaying(false)
          isPlayingRef.current = false
          setIsFinished(true)
          stopSpeech()
          return
        }

        // ---- advance ---------------------------------------------------
        const next = idx + 1
        sceneIndexRef.current = next
        sceneElapsedRef.current = 0
        setSceneIndex(next)
        setSceneElapsed(0)
        setCycle((c) => c + 1)
        startScene(next)
        rafRef.current = requestAnimationFrame(step)
        return
      }

      sceneElapsedRef.current = t
      setSceneElapsed(t)
      rafRef.current = requestAnimationFrame(step)
    }

    rafRef.current = requestAnimationFrame(step)

    return () => {
      cancelled = true
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      lastFrameRef.current = null
    }
  }, [isPlaying, startScene, stopSpeech, ttsAvailable])

  /* ------------------------------------------------------------------
     Narration follows play/pause state
     ------------------------------------------------------------------ */
  useEffect(() => {
    if (!isPlaying) return undefined
    startScene(sceneIndexRef.current)
    return () => stopSpeech()
  }, [isPlaying, startScene, stopSpeech])

  /* ------------------------------------------------------------------
     Unmount cleanup
     ------------------------------------------------------------------ */
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      speechTokenRef.current += 1
      if (watchdogRef.current) clearTimeout(watchdogRef.current)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (ttsAvailable) {
        try {
          window.speechSynthesis.cancel()
        } catch {
          /* noop */
        }
      }
    }
  }, [ttsAvailable])

  /* ------------------------------------------------------------------
     Transport controls
     ------------------------------------------------------------------ */
  const pause = useCallback(() => {
    setIsPlaying(false)
    isPlayingRef.current = false
    stopSpeech()
  }, [stopSpeech])

  const resetToStart = useCallback(() => {
    stopSpeech()
    sceneIndexRef.current = 0
    sceneElapsedRef.current = 0
    setSceneIndex(0)
    setSceneElapsed(0)
    setIsFinished(false)
    setCycle((c) => c + 1)
  }, [stopSpeech])

  const play = useCallback(() => {
    if (isFinished) resetToStart()
    setIsPlaying(true)
    isPlayingRef.current = true
  }, [isFinished, resetToStart])

  const toggle = useCallback(() => {
    if (isPlayingRef.current) pause()
    else play()
  }, [pause, play])

  /** Jump to a scene. Handles both "already playing" and "resume" paths. */
  const goToScene = useCallback(
    (index) => {
      const clamped = Math.max(0, Math.min(TOUR_SCENES.length - 1, index))
      stopSpeech()
      sceneIndexRef.current = clamped
      sceneElapsedRef.current = 0
      setSceneIndex(clamped)
      setSceneElapsed(0)
      setIsFinished(false)
      setCycle((c) => c + 1)

      if (isPlayingRef.current) {
        // isPlaying will not change → the effect will not re-fire, so speak here.
        startScene(clamped)
      } else {
        setIsPlaying(true)
        isPlayingRef.current = true
      }
    },
    [startScene, stopSpeech]
  )

  const goToSceneAtTime = useCallback(
    (seconds) => {
      let idx = 0
      for (let i = 0; i < TOUR_SCENES.length; i += 1) {
        if (seconds >= SCENE_STARTS[i]) idx = i
      }
      goToScene(idx)
    },
    [goToScene]
  )

  const handleClose = useCallback(() => {
    stopSpeech()
    setIsPlaying(false)
    isPlayingRef.current = false
    if (onClose) onClose()
  }, [onClose, stopSpeech])

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current
    mutedRef.current = next
    setMuted(next)

    if (next) {
      // Silence now → let the scene finish on its minimum dwell.
      stopSpeech()
      speechDoneRef.current = true
      speechDoneAtRef.current = sceneElapsedRef.current
    } else if (isPlayingRef.current) {
      // Speak the current scene from the top so nothing is half-heard.
      startScene(sceneIndexRef.current)
    }
  }, [startScene, stopSpeech])

  const handleSpeedChange = useCallback((value) => {
    speedRef.current = value
    setSpeed(value)
  }, [])

  /* ------------------------------------------------------------------
     Progress bar geometry (soft, monotonic, never jumps backwards)
     ------------------------------------------------------------------ */
  const activeIndex = sceneIndex
  const scene = TOUR_SCENES[activeIndex]
  const sceneNominal = SCENE_DURATIONS[activeIndex]

  // Asymptotic sub-progress: smooth, monotonic, ~93% at the nominal duration,
  // so a scene that runs long simply creeps instead of stalling.
  const subProgress =
    sceneElapsed <= 0 ? 0 : 1 - Math.exp(-sceneElapsed / (sceneNominal / 2.6))

  const overallProgress = Math.min(
    100,
    ((SCENE_STARTS[activeIndex] + subProgress * sceneNominal) / TOTAL_DURATION) * 100
  )
  const displayElapsed = (overallProgress / 100) * TOTAL_DURATION

  /* ------------------------------------------------------------------
     Seek bar interaction
     ------------------------------------------------------------------ */
  const handleSeekClick = (event) => {
    if (!progressTrackRef.current) return
    const rect = progressTrackRef.current.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    goToSceneAtTime(pct * TOTAL_DURATION)
  }

  const handleSeekMouseMove = (event) => {
    if (!progressTrackRef.current) return
    const rect = progressTrackRef.current.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    setHoverPct(pct)
  }

  /* ------------------------------------------------------------------
     Keyboard shortcuts
     ------------------------------------------------------------------ */
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleClose()
      } else if (e.key === ' ' || e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        toggle()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        goToScene(activeIndex + 1)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goToScene(activeIndex - 1)
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault()
        toggleMute()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeIndex, goToScene, handleClose, toggle, toggleMute])

  const SceneComponent = scene.render

  return (
    <div
      className="modal-backdrop tour-modal-fadein"
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
      aria-label="API Analyzer product tour"
    >
      <div className="video-modal-card tour-modal-elevated" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <div className="modal-title-wrap">
            <span className="live-indicator">
              <span className="pulse-dot" />
              PRODUCT TOUR
            </span>
            <h3>How to use API Analyzer</h3>
          </div>
          <div className="tour-header-actions">
            <button
              type="button"
              className="tour-icon-btn"
              onClick={toggleMute}
              aria-label={muted ? 'Unmute narration' : 'Mute narration'}
              title={muted ? 'Unmute narration (M)' : 'Mute narration (M)'}
            >
              {muted ? <IconVolumeOff /> : <IconVolumeOn />}
            </button>
            <button type="button" className="close-btn" onClick={handleClose} aria-label="Close product tour">
              <IconClose />
            </button>
          </div>
        </div>

        {/* Animated Stage */}
        <div className={`real-video-wrapper tour-stage ${!isPlaying ? 'tour-paused' : ''}`}>
          <div key={`${activeIndex}-${cycle}`} className="tour-scene tour-scene-active">
            <div className={`tour-kenburns tour-kb-dir-${(activeIndex % 5) + 1}`}>
              <SceneComponent progress={Math.min(1, sceneElapsed / Math.max(sceneNominal, 1))} />
            </div>

            <div className="tour-scrim" />

            <div className="tour-caption-bar">
              <div className="tour-caption-meta">
                <span className="tour-kicker">{scene.stage}</span>
                <span className="tour-tag-pill">{scene.tag}</span>
              </div>
              <h4>{scene.title}</h4>
              <p>{scene.detail}</p>
            </div>
          </div>

          {!isPlaying && (
            <button
              type="button"
              className="large-video-play"
              onClick={play}
              aria-label={isFinished ? 'Replay tour' : 'Play tour'}
            >
              <IconPlayLarge />
            </button>
          )}

          <div className="video-badge">
            <IconSparkles />
            AI-assisted contract diffing
          </div>
        </div>

        {/* Controls */}
        <div className="real-video-controls">
          <div
            ref={progressTrackRef}
            className="real-video-progress"
            onClick={handleSeekClick}
            onMouseMove={handleSeekMouseMove}
            onMouseLeave={() => setHoverPct(null)}
            role="slider"
            aria-label="Tour progress"
            aria-valuemin={0}
            aria-valuemax={Math.round(TOTAL_DURATION)}
            aria-valuenow={Math.round(displayElapsed)}
            tabIndex={0}
          >
            {SCENE_STARTS.map((startTime, idx) => (
              <span
                key={TOUR_SCENES[idx].id}
                className="tour-timeline-pip"
                style={{ left: `${(startTime / TOTAL_DURATION) * 100}%` }}
              />
            ))}
            <div className="real-video-progress-fill" style={{ width: `${overallProgress}%` }} />
            <div className="tour-timeline-handle" style={{ left: `${overallProgress}%` }} />

            {hoverPct !== null && (
              <div className="tour-timeline-tooltip" style={{ left: `${hoverPct * 100}%` }}>
                {formatTime(hoverPct * TOTAL_DURATION)}
              </div>
            )}
          </div>

          <div className="real-video-control-row">
            <div className="control-left">
              <button
                type="button"
                className="player-btn primary-player-btn"
                onClick={toggle}
                title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
                aria-label={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? <IconPause /> : <IconPlay />}
              </button>
              <button
                type="button"
                className="player-btn tour-step-btn"
                onClick={() => goToScene(activeIndex - 1)}
                title="Previous chapter"
                aria-label="Previous chapter"
                disabled={activeIndex === 0}
              >
                ‹‹
              </button>
              <button
                type="button"
                className="player-btn tour-step-btn"
                onClick={() => goToScene(activeIndex + 1)}
                title="Next chapter"
                aria-label="Next chapter"
                disabled={activeIndex === TOUR_SCENES.length - 1}
              >
                ››
              </button>
              <span className="video-time">
                <strong>{formatTime(displayElapsed)}</strong>
                <span className="tour-time-slash">/</span>
                <span>{formatTime(TOTAL_DURATION)}</span>
              </span>
            </div>

            <div className="control-right">
              <div className="speed-selector" role="group" aria-label="Playback rate">
                {[1, 1.25, 1.5].map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`speed-pill ${speed === s ? 'active' : ''}`}
                    onClick={() => handleSpeedChange(s)}
                  >
                    {s}x
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Chapters */}
        <div className="video-chapters" role="tablist" aria-label="Tour sections">
          {TOUR_SCENES.map((s, index) => {
            const isCurrent = index === activeIndex
            const isCompleted = index < activeIndex || (isFinished && index === TOUR_SCENES.length - 1)
            return (
              <button
                type="button"
                key={s.id}
                role="tab"
                aria-selected={isCurrent}
                className={`tour-chapter-btn ${isCurrent ? 'active' : ''} ${isCompleted ? 'completed' : ''}`}
                onClick={() => goToScene(index)}
              >
                <div className="tour-ch-head">
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <small>{isCurrent ? 'Active' : isCompleted ? 'Passed' : ''}</small>
                </div>
                <strong>{s.tag}</strong>
              </button>
            )
          })}
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <p className="footer-tip">
            <IconSparkles />
            Learn the workflow, then run your own API audit.
          </p>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={handleClose}>
              Close
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                handleClose()
                if (onStartCompare) onStartCompare()
              }}
            >
              Launch Comparison Workspace →
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ==========================================================================
   SCENE MOCKUPS — high-fidelity replicas of the API Analyzer interface
   ========================================================================== */

function reveal(index, base = 0.05) {
  return { animationDelay: `${base + index * 0.18}s` }
}

// Scene 1: Contract Input
function SceneIngest() {
  return (
    <div className="tour-device-frame">
      <DeviceChrome label="Workspace / API Analyzer — Compare API Contracts" />
      <div className="tour-device-inner">
        <div className="tour-view-header">
          <div>
            <h3 className="tour-view-title">Compare API Contracts</h3>
            <p className="tour-view-sub">Paste or load two OpenAPI snapshots and run a deterministic diff.</p>
          </div>
          <button type="button" className="primary tour-pulse-btn tour-fade-in" style={reveal(0)}>
            Run Comparison →
          </button>
        </div>

        <div className="panel tour-fade-in" style={reveal(1)}>
          <div className="editor-header">
            <h3>Contract comparison</h3>
          </div>
          <div className="tour-editor-grid">
            <div className="tour-spec-box">
              <div className="tour-spec-tag-row">
                <span className="tour-spec-title">Old API</span>
                <span className="spec-badge-label">v1</span>
              </div>
              <pre className="tour-code-block">{`openapi: 3.0.3
paths:
  /payments:
    post:
      requestBody:
        required: false
      responses:
        "200":
          schema:
            amount: number`}</pre>
            </div>

            <div className="tour-spec-box">
              <div className="tour-spec-tag-row">
                <span className="tour-spec-title">New API</span>
                <span className="spec-badge-label">v2</span>
              </div>
              <pre className="tour-code-block">{`openapi: 3.0.3
paths:
  /payments:
    post:
      requestBody:
        `}<span className="tour-code-diff-red">required: true</span>{`
      responses:
        "200":
          schema:
            `}<span className="tour-code-diff-red">amount: integer</span></pre>
            </div>
          </div>
        </div>

        <div className="tour-info-box tour-fade-in" style={reveal(2)}>
          <strong>Deterministic engine</strong> compares endpoints, parameters, request bodies and response
          schemas. No LLM guessing is required to detect structural changes.
        </div>
      </div>
    </div>
  )
}

// Scene 2: AST Processing
function SceneAst() {
  const pipeline = [
    { type: 'ENDPOINT', val: '/payments' },
    { type: 'METHOD', val: 'POST' },
    { type: 'PAYLOAD', val: 'requestBody' },
    { type: 'CONSTRAINT', val: 'required: true', hot: true },
    { type: 'SCHEMA', val: 'amount: integer', hot: true },
  ]

  return (
    <div className="tour-device-frame">
      <DeviceChrome label="AST Engine — Structural Property Traversal" />
      <div className="tour-device-inner">
        <div className="tour-view-header">
          <div>
            <h3 className="tour-view-title">AST Tree Diffing Engine</h3>
            <p className="tour-view-sub">
              Deconstructing OpenAPI schemas and constraints into deterministic AST nodes.
            </p>
          </div>
          <span className="status-pill ok tour-fade-in" style={reveal(0)}>
            <IconSparkles /> 142 Nodes Verified
          </span>
        </div>

        <div className="tour-node-pipeline tour-fade-in" style={reveal(1)}>
          {pipeline.map((p, idx) => (
            <div key={p.val} className="tour-pipeline-step">
              <div className={`tour-ast-card ${p.hot ? 'is-flagged' : ''}`}>
                <span className="tour-ast-kind">{p.type}</span>
                <strong className="tour-ast-id">{p.val}</strong>
              </div>
              {idx < pipeline.length - 1 && <span className="tour-pipeline-arrow">→</span>}
            </div>
          ))}
        </div>

        <div className="panel tour-fade-in" style={reveal(2)}>
          <div className="tour-scanline-wrap">
            <div className="diff-row removed">
              <span className="diff-marker">−</span>
              <code>paths./payments.post.requestBody.required: false</code>
            </div>
            <div className="diff-row added">
              <span className="diff-marker">+</span>
              <code>paths./payments.post.requestBody.required: true</code>
            </div>
            <div className="diff-row modified">
              <span className="diff-marker">~</span>
              <code>paths./payments.post.responses.200.schema.amount: number → integer</code>
            </div>
            <div className="tour-scanline" />
          </div>
        </div>

        <div className="tour-node-trail tour-fade-in" style={reveal(3)}>
          <span>POST /payments</span>
          <span className="tour-arrow">→</span>
          <span>requestBody</span>
          <span className="tour-arrow">→</span>
          <span className="tour-node-hot">schema constraint narrowed</span>
        </div>
      </div>
    </div>
  )
}

// Scene 3: Breaking Change Review
function SceneClassify() {
  const items = [
    { endpoint: '/payments', type: 'required parameter added', breaking: true },
    { endpoint: '/payments', type: 'response field changed type', breaking: true },
    { endpoint: '/customers', type: 'optional field added', breaking: false },
    { endpoint: '/orders', type: 'new endpoint added', breaking: false },
  ]

  return (
    <div className="tour-device-frame">
      <DeviceChrome label="Workspace / API Analyzer — Breaking Change Review" />
      <div className="tour-device-inner">
        <div className="tour-view-header">
          <div>
            <h3 className="tour-view-title">Breaking Change Review</h3>
            <p className="tour-view-sub">Every change is classified by deterministic compatibility rules.</p>
          </div>
        </div>

        <div className="panel tour-fade-in" style={reveal(0)}>
          <div className="tour-review-top-bar">
            <strong>6 detected changes</strong>
            <div className="filter-tabs">
              <span className="tour-pill-filter tour-filter-breaking">2 BREAKING</span>
              <span className="tour-pill-filter tour-filter-safe">4 SAFE</span>
            </div>
          </div>

          <div className="change-list">
            {items.map((item, i) => (
              <article
                key={item.endpoint + item.type}
                className={`change-item ${item.breaking ? 'is-breaking' : 'is-safe'} tour-fade-in`}
                style={reveal(i + 1)}
              >
                <div className="change-heading">
                  <div className="change-title-group">
                    <span className="change-endpoint">{item.endpoint}</span>
                    <span className="change-meta-pill">{item.type}</span>
                  </div>
                  <span className={`badge ${item.breaking ? 'badge-breaking' : 'badge-safe'}`}>
                    {item.breaking ? 'BREAKING' : 'SAFE'}
                  </span>
                </div>
              </article>
            ))}
          </div>

          <div className="tour-banner-warning tour-fade-in" style={reveal(5)}>
            <IconAlertTriangle />
            <span>
              <strong>Rule engine is authoritative.</strong> AI is used to explain impact, not to override
              classification.
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// Scene 4: AI Impact Analysis
function SceneAi() {
  return (
    <div className="tour-device-frame">
      <DeviceChrome label="Workspace / API Analyzer — AI Impact Analysis" />
      <div className="tour-device-inner">
        <div className="tour-view-header">
          <div>
            <h3 className="tour-view-title">AI Impact Analysis</h3>
            <p className="tour-view-sub">
              The deterministic result is enriched with context, affected components and remediation guidance.
            </p>
          </div>
        </div>

        <div className="analysis-box tour-fade-in" style={reveal(0)}>
          <div className="analysis-header">
            <div className="tour-ai-target-title">
              <span className="tour-ai-idx">#4</span>
              <strong>POST /payments</strong>
            </div>
            <span className="badge badge-breaking tour-breaking-high">BREAKING • HIGH</span>
          </div>

          <div className="analysis-section tour-fade-in" style={reveal(1)}>
            <span className="analysis-label">Why it breaks</span>
            <p>
              The request body changed from optional to required. Existing clients that omit the body can now
              receive validation errors.
            </p>
          </div>

          <div className="analysis-section tour-fade-in" style={reveal(2)}>
            <span className="analysis-label">Affected components</span>
            <div className="component-row">
              <span className="component-pill">Checkout SDK</span>
              <span className="component-pill">Mobile client</span>
              <span className="component-pill">Payment worker</span>
              <span className="component-pill">Contract tests</span>
            </div>
          </div>

          <div className="analysis-section tour-fade-in" style={reveal(3)}>
            <span className="analysis-label">Recommendation</span>
            <p className="recommendation-text">
              Roll out with backward compatibility, update consumers first, then enforce the new requirement in
              a versioned release.
            </p>
          </div>

          <div className="tour-rag-evidence tour-fade-in" style={reveal(4)}>
            <div className="tour-rag-title">
              <IconSparkles /> RAG evidence
            </div>
            <div className="tour-rag-text">
              Retrieved: API change policy • Payments SDK migration guide • release checklist
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// Scene 5: History & Release Gate
function SceneRelease() {
  const auditRows = [
    { id: '#12', project: 'Payments API', total: '6 diffs', status: 'completed' },
    { id: '#11', project: 'Orders API', total: '3 diffs', status: 'completed' },
    { id: '#10', project: 'Customers API', total: '5 diffs', status: 'completed' },
  ]

  return (
    <div className="tour-device-frame">
      <DeviceChrome label="Workspace / API Analyzer — History & Jobs" />
      <div className="tour-device-inner">
        <div className="tour-view-header">
          <div>
            <h3 className="tour-view-title">History & Jobs</h3>
            <p className="tour-view-sub">
              Every comparison run is stored for auditability and follow-up analysis.
            </p>
          </div>
        </div>

        <div className="panel tour-fade-in" style={reveal(0)}>
          <div className="editor-header">
            <h3>Comparison Audit History</h3>
          </div>
          <div className="table-list">
            <div className="tour-table-head-row">
              <span>ID</span>
              <span>PROJECT</span>
              <span>TOTAL CHANGES</span>
              <span>STATUS</span>
              <span>ACTION</span>
            </div>
            {auditRows.map((row, i) => (
              <div
                className={`history-row ${i === 0 ? 'is-active-audit' : ''} tour-fade-in`}
                key={row.id}
                style={reveal(i + 1)}
              >
                <span className="history-id">{row.id}</span>
                <strong className="history-project">{row.project}</strong>
                <span className="history-metrics">{row.total}</span>
                <span className="badge badge-safe">{row.status}</span>
                <button type="button" className="tour-link-btn">
                  View Details →
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="panel tour-job-panel tour-fade-in" style={reveal(4)}>
          <div className="tour-job-line">
            <span className="tour-job-name">Job #4</span>
            <span className="tour-job-target">Payments API / comparison #12</span>
            <div className="job-progress-track">
              <div className="job-progress-fill tour-gate-fill" />
            </div>
            <span className="tour-job-score">100</span>
            <span className="badge badge-safe">completed</span>
          </div>

          <div className="tour-gate-banner">
            <div className="tour-gate-label">
              <IconShieldCheck /> CI/CD Gate Verified — Backward Compatibility Verified
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function DeviceChrome({ label }) {
  return (
    <div className="tour-chrome">
      <div className="tour-chrome-dots">
        <span className="tour-chrome-dot tour-chrome-dot-r" />
        <span className="tour-chrome-dot tour-chrome-dot-y" />
        <span className="tour-chrome-dot tour-chrome-dot-g" />
      </div>
      <span className="tour-chrome-label">{label}</span>
      <span className="tour-chrome-pill">PROD</span>
    </div>
  )
}

/* ==========================================================================
   Minimal self-contained SVG icons
   ========================================================================== */

function IconClose() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function IconPlay() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  )
}

function IconPlayLarge() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  )
}

function IconPause() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  )
}

function IconSparkles() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.912 5.885L20 10.8l-4.5 4.385L16.564 21 12 17.585 7.436 21l1.064-5.815L4 10.8l6.088-1.915L12 3z" />
    </svg>
  )
}

function IconShieldCheck() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  )
}

function IconVolumeOn() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="4 9 8 9 12 5 12 19 8 15 4 15 4 9" fill="currentColor" />
      <path d="M16.5 8.5a5 5 0 0 1 0 7" />
      <path d="M19 6a9 9 0 0 1 0 12" />
    </svg>
  )
}

function IconVolumeOff() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="4 9 8 9 12 5 12 19 8 15 4 15 4 9" fill="currentColor" />
      <line x1="17" y1="8" x2="23" y2="14" />
      <line x1="23" y1="8" x2="17" y2="14" />
    </svg>
  )
}

function IconAlertTriangle() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}