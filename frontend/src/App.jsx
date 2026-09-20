import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const API_BASE =
  import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000/api';

const sampleOldSpec = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Users API', version: '1.0.0' },
  paths: {
    '/users': {
      get: {
        summary: 'List users',
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
        ],
        responses: {
          200: {
            description: 'Users list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string' }, name: { type: 'string' } },
                  required: ['id', 'name'],
                },
              },
            },
          },
        },
      },
    },
  },
}, null, 2)

const sampleNewSpec = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Users API', version: '2.0.0' },
  paths: {
    '/users': {
      get: {
        summary: 'List users',
        parameters: [
          { name: 'limit', in: 'query', required: true, schema: { type: 'integer', minimum: 1, maximum: 100 } },
        ],
        responses: {
          200: {
            description: 'Users list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string' }, full_name: { type: 'string' } },
                  required: ['id', 'full_name'],
                },
              },
            },
          },
        },
      },
    },
  },
}, null, 2)

const WORKFLOW_STEPS = [
  {
    title: '1. Ingest OpenAPI Contracts',
    label: 'Upload or Paste Specs',
    detail: 'Provide two OpenAPI/Swagger JSON specifications: the baseline production contract and your staging branch.',
    tag: 'Contract Input',
    duration: 6,
  },
  {
    title: '2. AST Tree Diffing Engine',
    label: 'Semantic Comparison',
    detail: 'The engine parses both documents, builds an AST graph, and traverses every path, query param, and JSON schema.',
    tag: 'AST Processing',
    duration: 6,
  },
  {
    title: '3. Deterministic Classification',
    label: 'Breaking Change Detection',
    detail: 'Rule-based evaluation flags removed fields, narrowed constraints, or newly required parameters as Breaking.',
    tag: 'Rules Engine',
    duration: 6,
  },
  {
    title: '4. Generative AI Impact Engine',
    label: 'AI Reasoning & Root Cause',
    detail: 'An LLM analyzes real-world downstream consumer impact and recommends remediation strategies for your team.',
    tag: 'LLM Analysis',
    duration: 7,
  },
  {
    title: '5. Automated Release Decision',
    label: 'Audit & CI/CD Gating',
    detail: 'Export reports, push to GitHub Actions PR checkouts, and confidently deploy backwards-compatible APIs.',
    tag: 'CI/CD Gate',
    duration: 5,
  },
]

const RUN_STEPS = [
  { key: 'project', label: 'Provisioning project context' },
  { key: 'specs', label: 'Parsing and persisting specifications' },
  { key: 'comparison', label: 'Detecting differences & AI assessment' },
]

function readSession() {
  try {
    const token = localStorage.getItem('apiAnalyzerToken')
    const rawUser = localStorage.getItem('apiAnalyzerUser')
    return { token, user: rawUser ? JSON.parse(rawUser) : null }
  } catch {
    return { token: null, user: null }
  }
}

function normalizeList(data) {
  if (Array.isArray(data)) return data
  return data?.results || []
}

export default function App() {
  const [session, setSession] = useState(readSession)
  const [route, setRoute] = useState(() => window.location.hash.replace('#/', '') || 'dashboard')
  const [projects, setProjects] = useState([])
  const [comparisons, setComparisons] = useState([])
  const [jobs, setJobs] = useState([])
  const [activeComparison, setActiveComparison] = useState(null)
  const [notice, setNotice] = useState({ text: '', type: 'info' })
  const [loading, setLoading] = useState(false)
  const [runPhase, setRunPhase] = useState(null)
  const [demoModalOpen, setDemoModalOpen] = useState(false)
  const authed = Boolean(session.token)

  useEffect(() => {
    const onHash = () => {
      const current = window.location.hash.replace('#/', '') || 'dashboard'
      setRoute(current)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const showNotice = (text, type = 'info') => {
    setNotice({ text, type })
    if (type !== 'error') {
      window.setTimeout(() => setNotice({ text: '', type: 'info' }), 6000)
    }
  }

  const apiFetch = useCallback(async (path, options = {}) => {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) }
    if (session.token) headers.Authorization = `Token ${session.token}`

    const response = await fetch(`${API_BASE}${path}`, { ...options, headers })

    if (response.status === 204) return null

    const data = await response.json().catch(() => ({}))

    if (!response.ok) {
      let errorMsg = `Request failed with status ${response.status}.`

      if (typeof data === 'string' && data.trim()) {
        errorMsg = data
      } else if (data?.detail) {
        errorMsg = String(data.detail)
      } else if (data && typeof data === 'object') {
        const messages = []

        Object.entries(data).forEach(([field, value]) => {
          if (Array.isArray(value)) {
            messages.push(`${field}: ${value.join(' ')}`)
          } else if (value && typeof value === 'object') {
            messages.push(`${field}: ${JSON.stringify(value)}`)
          } else if (value) {
            messages.push(`${field}: ${value}`)
          }
        })

        if (messages.length) {
          errorMsg = messages.join(' | ')
        }
      }

      throw new Error(errorMsg)
    }

    return data
  }, [session.token])

  const refreshData = useCallback(async () => {
    setLoading(true)
    try {
      const [projectData, comparisonData, jobData] = await Promise.all([
        apiFetch('/projects/'),
        apiFetch('/comparisons/'),
        apiFetch('/analysis-jobs/'),
      ])
      setProjects(normalizeList(projectData))
      const nextComparisons = normalizeList(comparisonData)
      setComparisons(nextComparisons)
      setJobs(normalizeList(jobData))
      setActiveComparison((current) => {
        if (!current && nextComparisons.length) return nextComparisons[0]
        if (current) {
          const matched = nextComparisons.find((c) => String(c.id) === String(current.id))
          return matched || nextComparisons[0] || null
        }
        return null
      })
    } catch (error) {
      showNotice(error.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [apiFetch])

  useEffect(() => {
    if (!authed) return undefined
    const refreshTimer = window.setTimeout(refreshData, 0)
    return () => window.clearTimeout(refreshTimer)
  }, [authed, refreshData])

  async function handleAuth(mode, payload) {
    setLoading(true)
    setNotice({ text: '', type: 'info' })
    try {
      const data = await apiFetch(`/auth/${mode}/`, { method: 'POST', body: JSON.stringify(payload) })
      localStorage.setItem('apiAnalyzerToken', data.token)
      localStorage.setItem('apiAnalyzerUser', JSON.stringify(data.user))
      setSession({ token: data.token, user: data.user })
      window.location.hash = '#/dashboard'
      showNotice(`Signed in successfully as ${data.user?.username || 'user'}.`, 'success')
    } catch (error) {
      showNotice(error.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  async function handleLogout() {
    try {
      await apiFetch('/auth/logout/', { method: 'POST' })
    } catch {
      // Clear local session state even if remote revocation failed
    }
    localStorage.removeItem('apiAnalyzerToken')
    localStorage.removeItem('apiAnalyzerUser')
    setSession({ token: null, user: null })
    setProjects([])
    setComparisons([])
    setJobs([])
    setActiveComparison(null)
    window.location.hash = '#/login'
    showNotice('You have been logged out.', 'info')
  }

  async function runComparison(form) {
    setLoading(true)
    setNotice({ text: '', type: 'info' })
    setRunPhase('project')

    try {
      let projectId = form.projectId

      // Reuse an existing project when the user has not explicitly selected one.
      // This prevents duplicate-project 500 errors for repeated audits.
      if (!projectId) {
        const requestedName = String(form.projectName || '').trim()

        const existingProject = projects.find(
          (project) =>
            String(project.name || '').trim().toLowerCase() ===
            requestedName.toLowerCase()
        )

        if (existingProject) {
          projectId = existingProject.id
        } else {
          if (!requestedName) {
            throw new Error('Project name is required.')
          }

          const project = await apiFetch('/projects/', {
            method: 'POST',
            body: JSON.stringify({
              name: requestedName,
              description: 'Created from OpenAPI Analyzer pipeline.',
            }),
          })

          projectId = project.id

          setProjects((current) => {
            const alreadyExists = current.some(
              (item) => String(item.id) === String(project.id)
            )
            return alreadyExists ? current : [...current, project]
          })
        }
      }

      setRunPhase('specs')

      let oldContent
      let newContent

      try {
        oldContent = JSON.parse(form.oldSpec)
      } catch {
        throw new Error('Baseline specification is not valid JSON.')
      }

      try {
        newContent = JSON.parse(form.newSpec)
      } catch {
        throw new Error('Proposed specification is not valid JSON.')
      }

      const oldSpec = await apiFetch('/specifications/', {
        method: 'POST',
        body: JSON.stringify({
          project: projectId,
          name: form.oldName,
          version:
            form.oldVersion ||
            oldContent.info?.version ||
            '1.0.0',
          content: oldContent,
          raw_text: form.oldSpec,
        }),
      })

      const newSpec = await apiFetch('/specifications/', {
        method: 'POST',
        body: JSON.stringify({
          project: projectId,
          name: form.newName,
          version:
            form.newVersion ||
            newContent.info?.version ||
            '2.0.0',
          content: newContent,
          raw_text: form.newSpec,
        }),
      })

      setRunPhase('comparison')

      const comparison = await apiFetch('/comparisons/', {
        method: 'POST',
        body: JSON.stringify({
          project: projectId,
          old_specification: oldSpec.id,
          new_specification: newSpec.id,
        }),
      })

      setActiveComparison(comparison)

      showNotice(
        'Comparison completed successfully! Results and AI analysis are ready below.',
        'success'
      )

      await refreshData()
      window.location.hash = '#/dashboard'
    } catch (error) {
      console.error('Compatibility audit failed:', error)
      showNotice(error.message, 'error')
    } finally {
      setLoading(false)
      setRunPhase(null)
    }
  }


  async function createJob(comparisonId) {
    const comparison = comparisons.find((item) => String(item.id) === String(comparisonId))
    if (!comparison) return
    setLoading(true)
    try {
      const job = await apiFetch('/analysis-jobs/', {
        method: 'POST',
        body: JSON.stringify({ project: comparison.project, comparison: comparison.id }),
      })
      showNotice(`Deep analysis job #${job.id} initialized.`, 'success')
      await refreshData()
    } catch (error) {
      showNotice(error.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  if (!authed && route !== 'register') {
    return (
      <AuthPage
        mode="login"
        loading={loading}
        notice={notice}
        onSubmit={handleAuth}
        onOpenVideo={() => setDemoModalOpen(true)}
      />
    )
  }

  if (!authed && route === 'register') {
    return (
      <AuthPage
        mode="register"
        loading={loading}
        notice={notice}
        onSubmit={handleAuth}
        onOpenVideo={() => setDemoModalOpen(true)}
      />
    )
  }

  const latestComparison = activeComparison || comparisons[0]

  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: IconDashboard },
    { id: 'compare', label: 'New Compare', icon: IconCompare },
    { id: 'history', label: 'History', icon: IconHistory, badge: comparisons.length },
    { id: 'jobs', label: 'AI Jobs', icon: IconJobs, badge: jobs.length },
    { id: 'github', label: 'GitHub CI', icon: IconGithub },
    { id: 'demo', label: 'Product Demo', icon: IconPlayCircle },
  ]

  return (
    <div className="app-shell">
      {/* Sidebar Navigation */}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <IconMark />
          </div>
          <div className="brand-text">
            <strong>API Analyzer</strong>
            <small>v2.4 · Enterprise</small>
          </div>
        </div>

        <nav className="nav-menu">
          <div className="nav-group-title">WORKSPACE</div>
          {navItems.map(({ id, label, icon: Icon, badge }) => (
            <a
              key={id}
              href={`#/${id}`}
              className={route === id ? 'active' : ''}
            >
              <Icon />
              <span>{label}</span>
              {typeof badge === 'number' && badge > 0 && (
                <span className="nav-count">{badge}</span>
              )}
            </a>
          ))}
        </nav>

        <div className="sidebar-promo">
          <div className="promo-badge">
            <IconSparkles /> AI Guard
          </div>
          <p>Zero unexpected breaking changes in production.</p>
          <button
            type="button"
            className="video-trigger-btn"
            onClick={() => setDemoModalOpen(true)}
          >
            <IconPlayCircle /> Product Demo
          </button>
        </div>

        <div className="sidebar-footer">
          <div className="user-profile">
            <div className="user-avatar">{session.user?.username?.[0]?.toUpperCase() || 'U'}</div>
            <div className="user-meta">
              <span className="user-name">{session.user?.username || 'Operator'}</span>
              <span className="user-status">Online</span>
            </div>
          </div>
          <button
            type="button"
            className="ghost-button logout-btn"
            onClick={handleLogout}
            title="Log out"
          >
            <IconLogout />
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="workspace">
        <header className="topbar">
          <div className="topbar-info">
            <div className="breadcrumbs">
              <span>Workspace</span> / <strong className="capitalize">{route}</strong>
            </div>
            <h1>OpenAPI Breaking Change Pipeline</h1>
            <p>
              Compare two OpenAPI specifications, evaluate semantic compatibility, and receive AI-guided impact analysis.
            </p>
          </div>

          <div className="topbar-actions">
            <button
              type="button"
              className="secondary video-watch-pill"
              onClick={() => setDemoModalOpen(true)}
            >
              <IconPlayCircle /> Product Demo
            </button>
            <button
              type="button"
              className="secondary"
              onClick={refreshData}
              disabled={loading}
              title="Refresh remote data"
            >
              <IconRefresh className={loading ? 'spin' : ''} />
              <span>{loading ? 'Syncing…' : 'Refresh'}</span>
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => { window.location.hash = '#/compare' }}
            >
              <IconPlus /> New Compare
            </button>
          </div>
        </header>

        {notice.text && (
          <div className={`notice notice-${notice.type}`}>
            <span className="notice-icon">
              {notice.type === 'error' ? <IconAlertCircle /> : notice.type === 'success' ? <IconCheck /> : <IconInfo />}
            </span>
            <span className="notice-body">{notice.text}</span>
            <button
              type="button"
              className="notice-close"
              onClick={() => setNotice({ text: '', type: 'info' })}
            >
              ×
            </button>
          </div>
        )}

        {route === 'demo' && (
          <ProductDemoPage
            onCloseDemo={() => { window.location.hash = '#/dashboard' }}
            onOpenCompare={() => { window.location.hash = '#/compare' }}
          />
        )}

        {route === 'dashboard' && (
          <Dashboard
            comparison={latestComparison}
            loading={loading}
            onOpenCompare={() => { window.location.hash = '#/compare' }}
            onOpenVideo={() => setDemoModalOpen(true)}
          />
        )}

        {route === 'compare' && (
          <ComparePage
            projects={projects}
            loading={loading}
            runPhase={runPhase}
            onRun={runComparison}
          />
        )}

        {route === 'history' && (
          <HistoryPage
            comparisons={comparisons}
            onSelect={(comp) => {
              setActiveComparison(comp)
              window.location.hash = '#/dashboard'
            }}
          />
        )}

        {route === 'jobs' && (
          <JobsPage
            jobs={jobs}
            comparisons={comparisons}
            onCreateJob={createJob}
          />
        )}

        {route === 'github' && (
          <GitHubCIPage
            projects={projects}
            comparisons={comparisons}
            onOpenCompare={() => { window.location.hash = '#/compare' }}
          />
        )}
      </main>

      {/* Product Demo Modal */}
      {demoModalOpen && (
        <ProductDemoModal
          onClose={() => setDemoModalOpen(false)}
          onStartCompare={() => {
            setDemoModalOpen(false)
            window.location.hash = '#/compare'
          }}
        />
      )}
    </div>
  )
}



/* ==========================================================================
   Product Demo
   ========================================================================== */

function ProductDemoPage({ onCloseDemo, onOpenCompare }) {
  const [modalOpen, setModalOpen] = useState(false)

  return (
    <section className="product-demo-page">
      <div className="product-demo-hero">
        <div>
          <span className="product-demo-kicker">PRODUCT DEMO</span>
          <h2>See API Analyzer in action</h2>
          <p>Walk through contract comparison, breaking-change detection, AI impact analysis, and audit tracking.</p>
        </div>
        <div className="product-demo-hero-actions">
          <button type="button" className="secondary" onClick={onCloseDemo}>Back to Dashboard</button>
          <button type="button" className="primary" onClick={onOpenCompare}>Run a Comparison →</button>
        </div>
      </div>

      <div className="product-demo-card">
        <div className="product-demo-video-shell">
          <video
            className="product-demo-video"
            src="/videos/api-analyzer-tour.mp4"
            controls
            playsInline
            preload="metadata"
          >
            Your browser does not support HTML5 video.
          </video>
          <button
            type="button"
            className="product-demo-open-btn"
            onClick={() => setModalOpen(true)}
          >
            <IconPlayCircle />
            Open Focused Demo
          </button>
        </div>

        <div className="product-demo-info-grid">
          <div>
            <span>01</span>
            <strong>Contract Input</strong>
            <p>Load the baseline and proposed OpenAPI specifications.</p>
          </div>
          <div>
            <span>02</span>
            <strong>Diff & Classification</strong>
            <p>Detect structural changes and identify compatibility risks.</p>
          </div>
          <div>
            <span>03</span>
            <strong>AI Impact Analysis</strong>
            <p>Understand downstream impact and recommended remediation.</p>
          </div>
          <div>
            <span>04</span>
            <strong>History & Jobs</strong>
            <p>Keep an auditable record of every compatibility analysis.</p>
          </div>
        </div>
      </div>

      {modalOpen && (
        <ProductDemoModal
          onClose={() => setModalOpen(false)}
          onStartCompare={onOpenCompare}
        />
      )}
    </section>
  )
}

function ProductDemoModal({ onClose, onStartCompare }) {
  const videoRef = useRef(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playbackRate, setPlaybackRate] = useState(1)

  const formatVideoTime = (seconds) => {
    if (!Number.isFinite(seconds)) return '00:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }

  const togglePlay = async () => {
    const video = videoRef.current
    if (!video) return

    if (video.paused) {
      try {
        await video.play()
      } catch (error) {
        console.error('Product demo playback failed:', error)
      }
    } else {
      video.pause()
    }
  }

  const handleLoadedMetadata = () => {
    const video = videoRef.current
    if (!video) return
    setDuration(Number.isFinite(video.duration) ? video.duration : 0)
  }

  const handleSeek = (event) => {
    const video = videoRef.current
    if (!video || !duration) return
    const rect = event.currentTarget.getBoundingClientRect()
    const percent = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    video.currentTime = percent * duration
  }

  const handleSpeed = (value) => {
    const video = videoRef.current
    if (!video) return
    video.playbackRate = value
    setPlaybackRate(value)
  }

  const handleClose = () => {
    const video = videoRef.current
    if (video) {
      video.pause()
      video.currentTime = 0
    }
    setIsPlaying(false)
    setCurrentTime(0)
    onClose()
  }

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        handleClose()
      }
      if (event.key === ' ' && event.target === document.body) {
        event.preventDefault()
        togglePlay()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [duration])

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0

  return (
    <div className="modal-backdrop product-demo-backdrop" onClick={handleClose} role="dialog" aria-modal="true" aria-label="API Analyzer product demo">
      <div className="video-modal-card product-demo-modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title-wrap">
            <span className="live-indicator">
              <span className="pulse-dot" />
              PRODUCT DEMO
            </span>
            <h3>How API Analyzer works</h3>
          </div>
          <button type="button" className="close-btn" onClick={handleClose} aria-label="Close product demo">
            <IconClose />
          </button>
        </div>

        <div className="real-video-wrapper product-demo-modal-video">
          <video
            ref={videoRef}
            className="real-product-video"
            src="/videos/api-analyzer-tour.mp4"
            preload="metadata"
            playsInline
            controls={false}
            onLoadedMetadata={handleLoadedMetadata}
            onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
          />

          {!isPlaying && (
            <button type="button" className="large-video-play" onClick={togglePlay} aria-label="Play product demo">
              <IconPlay />
            </button>
          )}

          <div className="video-badge">
            <IconSparkles />
            API Compatibility Workflow
          </div>
        </div>

        <div className="real-video-controls">
          <div className="real-video-progress" onClick={handleSeek} role="slider" aria-label="Product demo progress" aria-valuemin="0" aria-valuemax={duration || 0} aria-valuenow={currentTime} tabIndex={0}>
            <div className="real-video-progress-fill" style={{ width: `${progress}%` }} />
          </div>

          <div className="real-video-control-row">
            <div className="control-left">
              <button type="button" className="player-btn primary-player-btn" onClick={togglePlay} aria-label={isPlaying ? 'Pause demo' : 'Play demo'}>
                {isPlaying ? <IconPause /> : <IconPlay />}
              </button>
              <button
                type="button"
                className="player-btn skip-btn"
                onClick={() => {
                  const video = videoRef.current
                  if (video) video.currentTime = Math.min(video.currentTime + 10, duration || video.duration)
                }}
                aria-label="Skip forward ten seconds"
              >
                +10
              </button>
              <span className="video-time">
                {formatVideoTime(currentTime)} / {formatVideoTime(duration)}
              </span>
            </div>

            <div className="control-right">
              <div className="speed-selector" role="group" aria-label="Playback speed">
                {[1, 1.25, 1.5, 2].map((value) => (
                  <button key={value} type="button" className={`speed-pill ${playbackRate === value ? 'active' : ''}`} onClick={() => handleSpeed(value)}>
                    {value}x
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="video-chapters product-demo-chapters">
          <div><span>01</span><strong>Contracts</strong></div>
          <div><span>02</span><strong>Diff Engine</strong></div>
          <div><span>03</span><strong>Breaking Changes</strong></div>
          <div><span>04</span><strong>AI Impact</strong></div>
          <div><span>05</span><strong>Audit & Jobs</strong></div>
        </div>

        <div className="modal-footer">
          <p className="footer-tip">
            <IconSparkles />
            Watch the workflow, then run a real API compatibility audit.
          </p>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={handleClose}>Close</button>
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
   Dashboard View
   ========================================================================== */

function Dashboard({ comparison, loading, onOpenCompare, onOpenVideo }) {
  const [filter, setFilter] = useState('all') // 'all' | 'breaking' | 'non-breaking'
  const [search, setSearch] = useState('')

  const summary = comparison?.summary || {}
  const changes = comparison?.changes || []

  const filteredChanges = useMemo(() => {
    return changes.filter((change) => {
      const matchType =
        filter === 'all'
          ? true
          : filter === 'breaking'
          ? change.compatibility === 'breaking'
          : change.compatibility !== 'breaking'

      const matchSearch =
        !search ||
        change.endpoint?.toLowerCase().includes(search.toLowerCase()) ||
        change.change_type?.toLowerCase().includes(search.toLowerCase()) ||
        change.parameter?.toLowerCase().includes(search.toLowerCase())

      return matchType && matchSearch
    })
  }, [changes, filter, search])

  const breakingCount = changes.filter((c) => c.compatibility === 'breaking').length
  const nonBreakingCount = changes.length - breakingCount

  return (
    <div className="dashboard-layout">
      {/* Metrics Row */}
      <div className="metrics-grid">
        <Metric
          label="Total Contract Changes"
          value={summary.total ?? changes.length}
          sub="Across all routes & schemas"
          icon={IconLayers}
        />
        <Metric
          label="Breaking Changes"
          value={summary.breaking ?? breakingCount}
          tone="danger"
          sub="Immediate action required"
          icon={IconAlertTriangle}
        />
        <Metric
          label="Compatible Updates"
          value={summary.non_breaking ?? nonBreakingCount}
          tone="good"
          sub="Safe for immediate release"
          icon={IconShieldCheck}
        />
        <Metric
          label="Pipeline Status"
          value={comparison ? 'Audited' : 'Idle'}
          sub={comparison ? `Comparison #${comparison.id}` : 'No active run'}
          icon={IconCpu}
        />
      </div>

      <div className="dashboard-grid">
        {/* Left Column: Interactive Workflow Visualizer */}
        <section className="panel workflow-panel">
          <div className="section-title">
            <div>
              <h2>Pipeline Workflow Guide</h2>
              <p>Step-by-step lifecycle of an API compatibility audit.</p>
            </div>
            <button
              type="button"
              className="text-action-btn"
              onClick={onOpenVideo}
            >
              <IconPlayCircle /> Open Product Demo
            </button>
          </div>

          <WorkflowGuide onOpenVideo={onOpenVideo} />
        </section>

        {/* Right Column: Comparison Changes & Diff Explorer */}
        <section className="panel comparison-results-panel">
          <div className="section-title">
            <div>
              <h2>Latest Comparison Audit</h2>
              <p>
                {comparison
                  ? `Comparing specifications in project #${comparison.project || '1'}`
                  : 'Run your first comparison to view classified diffs.'}
              </p>
            </div>
            <button type="button" className="primary small-btn" onClick={onOpenCompare}>
              <IconPlus /> Run New
            </button>
          </div>

          {loading && (
            <div className="state-placeholder">
              <IconRefresh className="spin large-spinner" />
              <p>Evaluating OpenAPI contracts and classifying AST changes…</p>
            </div>
          )}

          {!comparison && !loading && (
            <EmptyState onOpenCompare={onOpenCompare} onOpenVideo={onOpenVideo} />
          )}

          {comparison && !loading && (
            <div className="changes-browser">
              {/* Filter & Search Bar */}
              <div className="filter-toolbar">
                <div className="filter-tabs">
                  <button
                    type="button"
                    className={`filter-tab ${filter === 'all' ? 'active' : ''}`}
                    onClick={() => setFilter('all')}
                  >
                    All ({changes.length})
                  </button>
                  <button
                    type="button"
                    className={`filter-tab tab-breaking ${filter === 'breaking' ? 'active' : ''}`}
                    onClick={() => setFilter('breaking')}
                  >
                    Breaking ({breakingCount})
                  </button>
                  <button
                    type="button"
                    className={`filter-tab tab-safe ${filter === 'non-breaking' ? 'active' : ''}`}
                    onClick={() => setFilter('non-breaking')}
                  >
                    Compatible ({nonBreakingCount})
                  </button>
                </div>

                <div className="filter-search-box">
                  <IconSearch />
                  <input
                    type="search"
                    placeholder="Search endpoint or field..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              </div>

              {/* Render List */}
              <ChangeList changes={filteredChanges} />
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function Metric({ label, value, sub, tone = 'neutral', icon: Icon }) {
  return (
    <div className={`metric metric-${tone}`}>
      <div className="metric-header">
        <span className="metric-label">{label}</span>
        {Icon && <Icon className="metric-icon" />}
      </div>
      <strong className="metric-value">{value}</strong>
      {sub && <span className="metric-sub">{sub}</span>}
    </div>
  )
}

function WorkflowGuide({ onOpenVideo }) {
  const [active, setActive] = useState(0)

  return (
    <div className="workflow-guide">
      <div className="workflow-preview-hero">
        <div className="workflow-stage-card">
          <div className="stage-top-meta">
            <span className="step-pill">Stage 0{active + 1}</span>
            <span className="step-tag-pill">{WORKFLOW_STEPS[active].tag}</span>
          </div>
          <h4>{WORKFLOW_STEPS[active].title}</h4>
          <p>{WORKFLOW_STEPS[active].detail}</p>
        </div>
      </div>

      <div className="workflow-stepper">
        {WORKFLOW_STEPS.map((step, index) => (
          <button
            key={step.label}
            type="button"
            className={`workflow-step-btn ${index === active ? 'active' : ''}`}
            onClick={() => setActive(index)}
          >
            <div className="step-badge">{String(index + 1).padStart(2, '0')}</div>
            <div className="step-content">
              <strong>{step.label}</strong>
              <small>{step.tag}</small>
            </div>
          </button>
        ))}
      </div>

      <button type="button" className="video-banner-btn" onClick={onOpenVideo}>
        <div className="video-banner-text">
          <IconPlayCircle />
          <div>
            <strong>Watch the API Analyzer product demo</strong>
            <span>See the complete compatibility analysis workflow</span>
          </div>
        </div>
        <span className="banner-arrow">→</span>
      </button>
    </div>
  )
}

function EmptyState({ onOpenCompare, onOpenVideo }) {
  return (
    <div className="empty-state">
      <div className="empty-icon-box">
        <IconCompareLarge />
      </div>
      <h3>No Contract Comparisons Run Yet</h3>
      <p>
        Run your first comparison using the pre-configured sample OpenAPI specifications to observe how required query parameters and schema renames are parsed and audited.
      </p>
      <div className="empty-actions">
        <button type="button" className="primary" onClick={onOpenCompare}>
          Run Sample Comparison
        </button>
        <button type="button" className="secondary" onClick={onOpenVideo}>
          <IconPlayCircle /> Watch Product Demo
        </button>
      </div>
    </div>
  )
}

function ChangeList({ changes }) {
  if (!changes.length) {
    return (
      <div className="empty-changes">
        <IconShieldCheck />
        <p>No changes match the selected filter criteria.</p>
      </div>
    )
  }

  return (
    <div className="change-list">
      {changes.map((change, index) => {
        const isBreaking = change.compatibility === 'breaking'
        return (
          <article
            key={change.id || index}
            className={`change-item ${isBreaking ? 'is-breaking' : 'is-safe'}`}
          >
            <div className="change-heading">
              <div className="change-title-group">
                <span className="change-index">#{String(index + 1).padStart(2, '0')}</span>
                <span className="change-endpoint">{change.endpoint || '/'}</span>
                <span className={`badge ${isBreaking ? 'badge-breaking' : 'badge-safe'}`}>
                  {isBreaking ? 'Breaking Change' : 'Compatible'}
                </span>
              </div>
              <span className="change-category">{change.change_type || 'Contract Diff'}</span>
            </div>

            <div className="change-meta">
              <strong>Target:</strong> {change.parameter || change.schema_path || 'Endpoint root definition'}
            </div>

            {(change.old_value !== undefined || change.new_value !== undefined) && (
              <div className="diff-block">
                {change.old_value !== undefined && (
                  <div className="diff-row removed">
                    <span className="diff-marker">−</span>
                    <JsonInline value={change.old_value} />
                  </div>
                )}
                {change.new_value !== undefined && (
                  <div className="diff-row added">
                    <span className="diff-marker">+</span>
                    <JsonInline value={change.new_value} />
                  </div>
                )}
              </div>
            )}

            {change.llm_analysis && (
              <ImpactBox analysis={change.llm_analysis} />
            )}

            {Array.isArray(change.evidence) && change.evidence.length > 0 && (
              <details className="evidence-toggle">
                <summary>AST Diagnostic Evidence ({change.evidence.length})</summary>
                <div className="evidence-content">
                  {change.evidence.map((item, idx) => (
                    <pre key={idx}>{item.excerpt || JSON.stringify(item, null, 2)}</pre>
                  ))}
                </div>
              </details>
            )}
          </article>
        )
      })}
    </div>
  )
}

function ImpactBox({ analysis }) {
  return (
    <div className="analysis-box">
      <div className="analysis-header">
        <IconSparkles />
        <span>AI Impact Analysis & Remediation</span>
      </div>

      <div className="analysis-section">
        <span className="analysis-label">Why this breaks clients</span>
        <p>{analysis.reason || 'Contract restriction may cause downstream serialization failures.'}</p>
      </div>

      <div className="analysis-section">
        <span className="analysis-label">Downstream Impact</span>
        <p>{analysis.impact || 'Client SDKs generated against the previous specification will fail requests.'}</p>
      </div>

      <div className="analysis-section">
        <span className="analysis-label">Suggested Resolution</span>
        <p className="recommendation-text">
          {analysis.recommendation || 'Introduce a backward-compatible alias or version the path.'}
        </p>
      </div>

      {Array.isArray(analysis.affected_components) && analysis.affected_components.length > 0 && (
        <div className="component-row">
          <span className="component-label">Vulnerable Services:</span>
          {analysis.affected_components.map((item, i) => (
            <span key={i} className="component-pill">{item}</span>
          ))}
        </div>
      )}

      {analysis.llm_status && (
        <div className="llm-status">
          Audited via {analysis.llm_status}
        </div>
      )}
    </div>
  )
}

function JsonInline({ value }) {
  const display = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return <code>{display}</code>
}

/* ==========================================================================
   GitHub CI Setup
   ========================================================================== */

function GitHubCIPage({ projects, comparisons, onOpenCompare }) {
  const [projectId, setProjectId] = useState(projects[0]?.id || '')
  const [repository, setRepository] = useState('')
  const [analyzerBaseUrl, setAnalyzerBaseUrl] = useState('')
  const [specPath, setSpecPath] = useState('openapi.json')
  const [generateCommand, setGenerateCommand] = useState('')
  const [baselineMode, setBaselineMode] = useState('merge-base')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!projectId && projects.length > 0) {
      setProjectId(projects[0].id)
    }
  }, [projects, projectId])

  const selectedProject = projects.find(
    (project) => String(project.id) === String(projectId)
  )

  const workflowYaml = `name: API Compatibility

on:
  pull_request:
    types:
      - opened
      - synchronize
      - reopened

permissions:
  contents: read

jobs:
  api-compatibility:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run API Compatibility Analyzer
        uses: ./.github/actions/api-compatibility
        with:
          api-base-url: \${{ secrets.API_ANALYZER_BASE_URL }}
          project-id: \${{ secrets.API_ANALYZER_PROJECT_ID }}
          token: \${{ secrets.API_ANALYZER_TOKEN }}
          spec-path: ${specPath || 'openapi.json'}
          generate-command: ${generateCommand}
          baseline-mode: ${baselineMode}
          fail-on-error: "true"
          poll-timeout-seconds: "600"
          poll-interval-seconds: "5"
`

  const copyWorkflow = async () => {
    try {
      await navigator.clipboard.writeText(workflowYaml)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('Could not copy GitHub workflow:', error)
      setCopied(false)
    }
  }

  const connectedRuns = comparisons.filter(
    (comparison) =>
      comparison.repository ||
      comparison.pull_request_number ||
      comparison.base_sha ||
      comparison.head_sha
  )

  return (
    <section className="panel">
      <div className="section-title">
        <div>
          <h2>GitHub CI Integration</h2>
          <p>
            Configure the GitHub Actions workflow already included in your analyzer project.
            This page prepares the repository-side CI settings; GitHub App OAuth is a later integration step.
          </p>
        </div>
        <span className="status-pill">
          {connectedRuns.length} CI-linked runs
        </span>
      </div>

      <div className="dashboard-grid">
        <section className="panel">
          <div className="section-title">
            <div>
              <h3>1. Project & Repository</h3>
              <p>Choose the analyzer project that your GitHub Action will submit results to.</p>
            </div>
          </div>

          <div className="form-grid">
            <label>
              <span>Analyzer Project</span>
              <select
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="">Select a project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} (#{project.id})
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>GitHub Repository</span>
              <input
                type="url"
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
                placeholder="https://github.com/owner/repository"
              />
            </label>

            <label>
              <span>Analyzer Backend URL</span>
              <input
                type="url"
                value={analyzerBaseUrl}
                onChange={(event) => setAnalyzerBaseUrl(event.target.value)}
                placeholder="https://api-analyzer-backend.onrender.com"
              />
            </label>

            <label>
              <span>OpenAPI Specification Path</span>
              <input
                type="text"
                value={specPath}
                onChange={(event) => setSpecPath(event.target.value)}
                placeholder="openapi.json"
              />
            </label>

            <label>
              <span>Generate Command</span>
              <input
                type="text"
                value={generateCommand}
                onChange={(event) => setGenerateCommand(event.target.value)}
                placeholder="Leave empty when openapi.json is committed"
              />
            </label>

            <label>
              <span>Baseline Mode</span>
              <select
                value={baselineMode}
                onChange={(event) => setBaselineMode(event.target.value)}
              >
                <option value="merge-base">merge-base</option>
                <option value="target_branch_head">target branch head</option>
                <option value="last_released">last released</option>
              </select>
            </label>
          </div>

          <div className="job-summary-panel" style={{ marginTop: 18 }}>
            <div className="job-meta-grid">
              <div className="job-meta-item">
                <small>Selected Project</small>
                <strong>
                  {selectedProject
                    ? `${selectedProject.name} (#${selectedProject.id})`
                    : 'Not selected'}
                </strong>
              </div>

              <div className="job-meta-item">
                <small>Repository</small>
                <strong>{repository || 'Not configured'}</strong>
              </div>

              <div className="job-meta-item">
                <small>Spec Source</small>
                <strong>{specPath || 'openapi.json'}</strong>
              </div>

              <div className="job-meta-item">
                <small>Baseline</small>
                <strong>{baselineMode}</strong>
              </div>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="section-title">
            <div>
              <h3>2. Required GitHub Secrets</h3>
              <p>Store these as repository or organization secrets in GitHub.</p>
            </div>
          </div>

          <div className="change-list">
            <article className="change-item is-safe">
              <div className="change-heading">
                <div className="change-title-group">
                  <span className="change-index">01</span>
                  <span className="change-endpoint">API_ANALYZER_BASE_URL</span>
                </div>
              </div>
              <div className="change-meta">
                Backend URL used by the GitHub Action.
              </div>
            </article>

            <article className="change-item is-safe">
              <div className="change-heading">
                <div className="change-title-group">
                  <span className="change-index">02</span>
                  <span className="change-endpoint">API_ANALYZER_PROJECT_ID</span>
                </div>
              </div>
              <div className="change-meta">
                Analyzer project ID: {projectId || 'select a project first'}.
              </div>
            </article>

            <article className="change-item is-safe">
              <div className="change-heading">
                <div className="change-title-group">
                  <span className="change-index">03</span>
                  <span className="change-endpoint">API_ANALYZER_TOKEN</span>
                </div>
              </div>
              <div className="change-meta">
                Your project-scoped CI token. Keep this secret and never commit it.
              </div>
            </article>
          </div>

          <div className="notice notice-info" style={{ marginTop: 18 }}>
            <span className="notice-icon"><IconInfo /></span>
            <span className="notice-body">
              The token is intentionally not stored in React state or browser storage.
              Add the secret directly in GitHub.
            </span>
          </div>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="section-title">
          <div>
            <h3>3. GitHub Actions Workflow</h3>
            <p>
              Save this as <code>.github/workflows/api-compatibility.yml</code> in the customer repository.
            </p>
          </div>

          <button
            type="button"
            className="primary"
            onClick={copyWorkflow}
          >
            <IconGithub />
            {copied ? 'Copied' : 'Copy Workflow'}
          </button>
        </div>

        <pre
          style={{
            margin: 0,
            padding: 18,
            overflowX: 'auto',
            borderRadius: 12,
            background: 'rgba(8, 12, 24, 0.88)',
            color: '#d9e2ff',
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          <code>{workflowYaml}</code>
        </pre>
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="section-title">
          <div>
            <h3>4. Current GitHub Integration Scope</h3>
            <p>What is available right now in this frontend.</p>
          </div>
        </div>

        <div className="metrics-grid">
          <Metric
            label="CI Workflow"
            value="Ready"
            sub="Customer-side GitHub Action"
            icon={IconGithub}
          />
          <Metric
            label="PR Analysis"
            value="Ready"
            sub="POST /api/ci/analyze"
            icon={IconCompare}
          />
          <Metric
            label="GitHub App OAuth"
            value="Later"
            sub="Backend installation flow not exposed here yet"
            icon={IconCpu}
          />
          <Metric
            label="Project"
            value={projectId ? `#${projectId}` : '—'}
            sub={selectedProject?.name || 'Select an analyzer project'}
            icon={IconLayers}
          />
        </div>

        <div className="modal-actions" style={{ marginTop: 18 }}>
          <button type="button" className="secondary" onClick={onOpenCompare}>
            <IconCompare /> Run Manual Comparison
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => window.open('https://github.com/', '_blank', 'noopener,noreferrer')}
          >
            <IconGithub /> Open GitHub
          </button>
        </div>

        {analyzerBaseUrl && (
          <div className="notice notice-info" style={{ marginTop: 18 }}>
            <span className="notice-icon"><IconInfo /></span>
            <span className="notice-body">
              Configure <strong>API_ANALYZER_BASE_URL</strong> in GitHub as:
              {' '}
              {analyzerBaseUrl}
            </span>
          </div>
        )}
      </section>
    </section>
  )
}

/* ==========================================================================
   Compare View
   ========================================================================== */

function ComparePage({ projects, loading, runPhase, onRun }) {
  const [form, setForm] = useState({
    projectId: '',
    projectName: 'Main API Service',
    oldName: 'Users API Production',
    newName: 'Users API Staging',
    oldVersion: '1.0.0',
    newVersion: '2.0.0',
    oldSpec: sampleOldSpec,
    newSpec: sampleNewSpec,
  })

  const projectSeededRef = useRef(false)

  useEffect(() => {
    if (!projectSeededRef.current && projects.length > 0) {
      setForm((current) => ({
        ...current,
        projectId: projects[0].id,
      }))
      projectSeededRef.current = true
    }
  }, [projects])

  const update = (field, value) => setForm((curr) => ({ ...curr, [field]: value }))

  const submit = (event) => {
    event.preventDefault()
    onRun(form)
  }

  const loadExample = () => {
    setForm((curr) => ({
      ...curr,
      oldSpec: sampleOldSpec,
      newSpec: sampleNewSpec,
      oldVersion: '1.0.0',
      newVersion: '2.0.0',
    }))
  }

  const runPhaseIndex = RUN_STEPS.findIndex((s) => s.key === runPhase)

  return (
    <form className="compare-form" onSubmit={submit}>
      <div className="panel compare-config-panel">
        <div className="section-title">
          <div>
            <h2>1. Target Project Context</h2>
            <p>Select an existing API repository project or generate a new workspace container.</p>
          </div>
          <button type="button" className="secondary" onClick={loadExample}>
            Reset to Sample Specs
          </button>
        </div>

        <div className="form-grid">
          <label>
            <span>Target Project</span>
            <select
              value={form.projectId}
              onChange={(e) => update('projectId', e.target.value)}
            >
              <option value="">＋ Create new project container</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (#{p.id})
                </option>
              ))}
            </select>
          </label>

          {!form.projectId && (
            <label>
              <span>New Project Name</span>
              <input
                type="text"
                placeholder="e.g. Payments Gateway"
                value={form.projectName}
                onChange={(e) => update('projectName', e.target.value)}
                required
              />
              <small style={{ marginTop: 6, opacity: 0.7 }}>
                An existing project with this name will be reused automatically.
              </small>
            </label>
          )}

          <label>
            <span>Base Spec Label & Version</span>
            <div className="inline-input-group">
              <input
                type="text"
                placeholder="Name"
                value={form.oldName}
                onChange={(e) => update('oldName', e.target.value)}
                required
              />
              <input
                type="text"
                className="version-input"
                placeholder="v1.0.0"
                value={form.oldVersion}
                onChange={(e) => update('oldVersion', e.target.value)}
              />
            </div>
          </label>

          <label>
            <span>Target Spec Label & Version</span>
            <div className="inline-input-group">
              <input
                type="text"
                placeholder="Name"
                value={form.newName}
                onChange={(e) => update('newName', e.target.value)}
                required
              />
              <input
                type="text"
                className="version-input"
                placeholder="v2.0.0"
                value={form.newVersion}
                onChange={(e) => update('newVersion', e.target.value)}
              />
            </div>
          </label>
        </div>
      </div>

      <div className="editor-grid">
        <SpecEditor
          title="Baseline Specification (JSON)"
          badge="Production / Previous"
          value={form.oldSpec}
          onChange={(val) => update('oldSpec', val)}
        />
        <SpecEditor
          title="Proposed Specification (JSON)"
          badge="Staging / Candidate"
          value={form.newSpec}
          onChange={(val) => update('newSpec', val)}
        />
      </div>

      <div className="runbar">
        <div className="runbar-info">
          <strong>Execute Compatibility Audit</strong>
          <p>
            The backend engine will validate AST structures, detect backward incompatibilities, and trigger AI impact analysis.
          </p>

          {loading && runPhase && (
            <div className="run-progress">
              {RUN_STEPS.map((step, idx) => {
                const isCurrent = idx === runPhaseIndex
                const isDone = idx < runPhaseIndex
                return (
                  <div
                    key={step.key}
                    className={`run-progress-row ${isCurrent ? 'active' : ''} ${isDone ? 'done' : ''}`}
                  >
                    <div className="run-progress-dot" />
                    <span>
                      {step.label}
                      {isCurrent ? '…' : isDone ? ' — completed' : ''}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <button type="submit" className="primary large-btn" disabled={loading}>
          {loading ? (
            <>
              <IconRefresh className="spin" /> Running Pipeline…
            </>
          ) : (
            <>
              <IconPlay /> Run Compatibility Audit
            </>
          )}
        </button>
      </div>
    </form>
  )
}

function SpecEditor({ title, badge, value, onChange }) {
  const [formattedStatus, setFormattedStatus] = useState(null)

  const isValid = useMemo(() => {
    try {
      JSON.parse(value)
      return true
    } catch {
      return false
    }
  }, [value])

  const formatJson = () => {
    try {
      const parsed = JSON.parse(value)
      onChange(JSON.stringify(parsed, null, 2))
      setFormattedStatus('Formatted')
      setTimeout(() => setFormattedStatus(null), 2000)
    } catch {
      setFormattedStatus('Cannot format invalid JSON')
      setTimeout(() => setFormattedStatus(null), 2000)
    }
  }

  return (
    <div className="panel editor-panel">
      <div className="editor-header">
        <div>
          <h3>{title}</h3>
          <span className="spec-badge-label">{badge}</span>
        </div>
        <div className="editor-tools">
          <button type="button" className="editor-tool-btn" onClick={formatJson} title="Format JSON">
            {formattedStatus || 'Prettify'}
          </button>
          <span className={`status-pill ${isValid ? 'ok' : 'bad'}`}>
            {isValid ? 'Valid JSON' : 'Invalid JSON'}
          </span>
        </div>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck="false"
        rows={18}
        placeholder="Paste valid OpenAPI 3.0 or Swagger JSON..."
      />
    </div>
  )
}

/* ==========================================================================
   History View
   ========================================================================== */

function HistoryPage({ comparisons, onSelect }) {
  return (
    <section className="panel">
      <div className="section-title">
        <div>
          <h2>Comparison Audit History</h2>
          <p>Every automated contract verification run recorded for this workspace.</p>
        </div>
        <span className="status-pill">{comparisons.length} Runs Logged</span>
      </div>

      {!comparisons.length && (
        <div className="state-placeholder">
          <IconHistoryLarge />
          <p>No comparisons saved yet. Run your first comparison to view history.</p>
        </div>
      )}

      {comparisons.length > 0 && (
        <div className="table-list">
          <div className="table-header-row">
            <span>ID</span>
            <span>Project</span>
            <span>Total Changes</span>
            <span>Status</span>
            <span>Action</span>
          </div>
          {comparisons.map((c) => {
            const breaking = c.summary?.breaking ?? 0
            return (
              <div className="history-row" key={c.id}>
                <span className="history-id">#{c.id}</span>
                <span className="history-project">Project #{c.project || '1'}</span>
                <div className="history-metrics">
                  <strong>{c.summary?.total ?? c.changes?.length ?? 0} diffs</strong>
                  {breaking > 0 && <span className="breaking-chip">{breaking} breaking</span>}
                </div>
                <span className={`badge ${c.status === 'completed' || !c.status ? 'badge-safe' : 'badge-warn'}`}>
                  {c.status || 'audited'}
                </span>
                <button
                  type="button"
                  className="secondary small-btn"
                  onClick={() => onSelect(c)}
                >
                  View Details →
                </button>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

/* ==========================================================================
   Jobs View
   ========================================================================== */

function JobsPage({ jobs, comparisons, onCreateJob }) {
  const [comparisonId, setComparisonId] = useState(comparisons[0]?.id || '')
  const [expandedJob, setExpandedJob] = useState(null)

const getStatusClass = (status) => {
  switch (status) {
    case 'completed':
      return 'badge-safe'

    case 'running':
      return 'badge-warn'

    case 'queued':
      return 'badge-warn'

    case 'failed':
      return 'badge-breaking'

    default:
      return 'badge-safe'
  }
}

  const getJobComparison = (job) => {
    return comparisons.find(
      (comparison) => comparison.id === job.comparison
    )
  }

  const getJobChanges = (job) => {
    const comparison = getJobComparison(job)
    return comparison?.changes || []
  }

  const getBreakingCount = (job) => {
    if (job.result?.breaking !== undefined) {
      return job.result.breaking
    }

    return getJobChanges(job).filter(
      (change) => change.compatibility === 'breaking'
    ).length
  }

  const getNonBreakingCount = (job) => {
    if (job.result?.non_breaking !== undefined) {
      return job.result.non_breaking
    }

    return getJobChanges(job).filter(
      (change) =>
        change.compatibility === 'non-breaking' ||
        change.compatibility === 'compatible'
    ).length
  }

  const formatDate = (date) => {
    if (!date) return '—'

    try {
      return new Date(date).toLocaleString()
    } catch {
      return date
    }
  }

  return (
    <section className="panel">
      {/* ================= HEADER ================= */}
      <div className="section-title">
        <div>
          <h2>AI Analysis Jobs</h2>
          <p>
            Monitor AI impact-analysis runs, review their results, and inspect
            LLM-generated explanations for API changes.
          </p>
        </div>

        <span className="status-pill">
          {jobs.length} Analysis Runs
        </span>
      </div>

      {/* ================= CREATE JOB ================= */}
      <div className="job-create-bar">
        <label>
          <span>Select Comparison Run</span>

          <select
            value={comparisonId}
            onChange={(e) => setComparisonId(e.target.value)}
          >
            <option value="">
              -- Choose Comparison ID --
            </option>

            {comparisons.map((comparison) => (
              <option value={comparison.id} key={comparison.id}>
                Comparison #{comparison.id} (
                {comparison.summary?.total ||
                  comparison.changes?.length ||
                  0}{' '}
                changes)
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="primary"
          onClick={() => onCreateJob(comparisonId)}
          disabled={!comparisonId}
        >
          <IconSparkles />
          Dispatch Analysis Job
        </button>
      </div>

      {/* ================= EMPTY STATE ================= */}
      {!jobs.length && (
        <div className="state-placeholder">
          <IconCpuLarge />

          <p>
            No analysis jobs yet. Select a comparison above to dispatch an
            AI impact-analysis job.
          </p>
        </div>
      )}

      {/* ================= JOB LIST ================= */}
      {jobs.length > 0 && (
        <div className="table-list">

          {jobs.map((job) => {
            const comparison = getJobComparison(job)
            const changes = getJobChanges(job)
            const isExpanded = expandedJob === job.id

            const breakingCount = getBreakingCount(job)
            const nonBreakingCount = getNonBreakingCount(job)

            const progress =
              job.progress !== undefined && job.progress !== null
                ? job.progress
                : job.status === 'completed'
                  ? 100
                  : 0

            return (
              <div className="job-card" key={job.id}>

                {/* ================= JOB HEADER ================= */}
                <div className="history-row job-row">

                  <div className="history-id">
                    <strong>Job #{job.id}</strong>

                    <small>
                      Comparison #{job.comparison || '—'}
                    </small>
                  </div>

                  {/* PROGRESS */}
                  <div className="job-track-wrap">
                    <div className="job-progress-track">
                      <div
                        className="job-progress-fill"
                        style={{
                          width: `${Math.min(progress, 100)}%`,
                        }}
                      />
                    </div>

                    <small>
                      {progress}% completed
                    </small>
                  </div>

                  {/* STATUS */}
                  <span
                    className={`badge ${getStatusClass(job.status)}`}
                  >
                    {job.status || 'unknown'}
                  </span>

                  {/* EXPAND BUTTON */}
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      setExpandedJob(
                        isExpanded ? null : job.id
                      )
                    }
                  >
                    {isExpanded ? 'Hide Details' : 'View Analysis'}
                  </button>
                </div>

                {/* ================= JOB SUMMARY ================= */}
                <div className="job-summary-panel">

                  <div className="job-meta-grid">

                    <div className="job-meta-item">
                      <small>Project</small>
                      <strong>
                        {job.project || '—'}
                      </strong>
                    </div>

                    <div className="job-meta-item">
                      <small>Comparison</small>
                      <strong>
                        #{job.comparison || '—'}
                      </strong>
                    </div>

                    <div className="job-meta-item">
                      <small>Total Changes</small>
                      <strong>
                        {job.result?.total ??
                          comparison?.summary?.total ??
                          changes.length ??
                          0}
                      </strong>
                    </div>

                    <div className="job-meta-item">
                      <small>Breaking</small>
                      <strong>
                        {breakingCount}
                      </strong>
                    </div>

                    <div className="job-meta-item">
                      <small>Non-Breaking</small>
                      <strong>
                        {nonBreakingCount}
                      </strong>
                    </div>

                    <div className="job-meta-item">
                      <small>Created</small>
                      <strong>
                        {formatDate(job.created_at)}
                      </strong>
                    </div>

                  </div>
                </div>

                {/* ================= ERROR ================= */}
                {job.error && (
                  <div className="job-error-box">
                    <strong>Job Error</strong>
                    <p>{job.error}</p>
                  </div>
                )}

                {/* ================= EXPANDED ANALYSIS ================= */}
                {isExpanded && (
                  <div className="job-analysis-panel">

                    <div className="analysis-header">
                      <div>
                        <h3>
                          AI Impact Analysis
                        </h3>

                        <p>
                          Detailed LLM analysis generated for
                          Comparison #{job.comparison}.
                        </p>
                      </div>

                      <span className="status-pill">
                        {job.status || 'completed'}
                      </span>
                    </div>

                    {/* JOB RESULT */}
                    {job.result && (
                      <div className="job-result-summary">

                        <h4>Analysis Summary</h4>

                        <div className="analysis-stat-grid">

                          <div>
                            <span>Total Changes</span>
                            <strong>
                              {job.result?.total ??
                              comparison?.summary?.total ??
                              changes.length ??
                               0}
                            </strong>
                          </div>

                          <div>
                            <span>Breaking</span>
                            <strong>
                              {job.result?.breaking ??
                                comparison?.summary?.breaking ??
                                breakingCount}
                            </strong>
                          </div>

                          <div>
                            <span>Non-Breaking</span>
                            <strong>
                              {job.result?.non_breaking ??
                                comparison?.summary?.non_breaking ??
                                nonBreakingCount}
                            </strong>
                          </div>

                          <div>
                            <span>Potentially Breaking</span>
                            <strong>
                              {job.result?.potentially_breaking ??
                                comparison?.summary?.potentially_breaking ??
                                0}
                            </strong>
                          </div>

                        </div>
                      </div>
                    )}

                    {/* ================= LLM RESPONSES ================= */}
                    {changes.length > 0 ? (
                      <div className="job-change-list">

                        <h4>
                          LLM Findings
                        </h4>

                        {changes.map((change, index) => {

                          const analysis =
                            change.llm_analysis

                          return (
                            <div
                              className="job-change-card"
                              key={
                                change.id ||
                                `${job.id}-${index}`
                              }
                            >

                              {/* CHANGE HEADER */}
                              <div className="job-change-header">

                                <div>
                                  <strong>
                                    Change #{index + 1}
                                  </strong>

                                  <span>
                                    {change.endpoint ||
                                      'Unknown endpoint'}
                                  </span>
                                </div>

                                <span
                                  className={`badge ${
                                    change.compatibility ===
                                      'breaking'
                                      ? 'badge-danger'
                                      : 'badge-safe'
                                  }`}
                                >
                                  {change.compatibility ||
                                    'unknown'}
                                </span>

                              </div>

                              {/* CHANGE INFORMATION */}
                              <div className="job-change-details">

                                <div>
                                  <small>
                                    Change Type
                                  </small>

                                  <strong>
                                    {change.change_type ||
                                      change.category ||
                                      '—'}
                                  </strong>
                                </div>

                                <div>
                                  <small>
                                    Target
                                  </small>

                                  <strong>
                                    {change.parameter ||
                                      change.field ||
                                      change.target ||
                                      '—'}
                                  </strong>
                                </div>

                                <div>
                                  <small>
                                    Old Value
                                  </small>

                                  <code>
                                    {typeof change.old_value ===
                                    'object'
                                      ? JSON.stringify(
                                          change.old_value
                                        )
                                      : String(
                                          change.old_value ??
                                            '—'
                                        )}
                                  </code>
                                </div>

                                <div>
                                  <small>
                                    New Value
                                  </small>

                                  <code>
                                    {typeof change.new_value ===
                                    'object'
                                      ? JSON.stringify(
                                          change.new_value
                                        )
                                      : String(
                                          change.new_value ??
                                            '—'
                                        )}
                                  </code>
                                </div>

                              </div>

                              {/* ================= LLM ANALYSIS ================= */}
                              {analysis ? (
                                <div className="job-llm-analysis">

                                  <div className="llm-analysis-header">
                                    <IconSparkles />

                                    <div>
                                      <strong>
                                        AI Impact Analysis
                                      </strong>

                                      <small>
                                        Audited via{' '}
                                        {analysis.llm_status ||
                                          'LLM'}
                                      </small>
                                    </div>
                                  </div>

                                  {/* WHY */}
                                  {analysis.reason && (
                                    <div className="llm-section">
                                      <h5>
                                        Why this matters
                                      </h5>

                                      <p>
                                        {analysis.reason}
                                      </p>
                                    </div>
                                  )}

                                  {/* IMPACT */}
                                  {analysis.impact && (
                                    <div className="llm-section">
                                      <h5>
                                        Downstream Impact
                                      </h5>

                                      <p>
                                        {analysis.impact}
                                      </p>
                                    </div>
                                  )}

                                  {/* RECOMMENDATION */}
                                  {analysis.recommendation && (
                                    <div className="llm-section">
                                      <h5>
                                        Suggested Resolution
                                      </h5>

                                      <p>
                                        {
                                          analysis.recommendation
                                        }
                                      </p>
                                    </div>
                                  )}

                                  {/* AFFECTED COMPONENTS */}
                                  {analysis.affected_components
                                    ?.length > 0 && (
                                    <div className="llm-section">
                                      <h5>
                                        Affected Components
                                      </h5>

                                      <div className="component-list">
                                        {analysis.affected_components.map(
                                          (
                                            component,
                                            componentIndex
                                          ) => (
                                            <span
                                              key={
                                                componentIndex
                                              }
                                              className="component-tag"
                                            >
                                              {component}
                                            </span>
                                          )
                                        )}
                                      </div>
                                    </div>
                                  )}

                                  {/* EVIDENCE */}
                                  {change.evidence && (
                                    <div className="llm-section">
                                      <h5>
                                        Evidence
                                      </h5>

                                      <pre className="evidence-block">
                                        {typeof change.evidence ===
                                        'string'
                                          ? change.evidence
                                          : JSON.stringify(
                                              change.evidence,
                                              null,
                                              2
                                            )}
                                      </pre>
                                    </div>
                                  )}

                                </div>
                              ) : (
                                <div className="llm-empty-state">
                                  <IconCpuLarge />

                                  <p>
                                    No LLM analysis is available
                                    for this change.
                                  </p>
                                </div>
                              )}

                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div className="llm-empty-state">
                        <IconCpuLarge />

                        <p>
                          Detailed change-level analysis is not
                          available in this job result.
                        </p>

                        <small>
                          Open the related comparison to inspect
                          the detailed AI analysis.
                        </small>
                      </div>
                    )}

                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
/* ==========================================================================
   Auth View
   ========================================================================== */

function AuthPage({ mode, loading, notice, onSubmit, onOpenVideo }) {
  const isRegister = mode === 'register'
  const [form, setForm] = useState({ username: '', email: '', password: '' })
  const update = (field, value) => setForm((curr) => ({ ...curr, [field]: value }))

  function submit(event) {
    event.preventDefault()
    onSubmit(mode, isRegister ? form : { username: form.username, password: form.password })
  }

  return (
    <div className="auth-layout">
      <div className="auth-side">
        <div className="auth-brand-lockup">
          <div className="brand-mark">
            <IconMark />
          </div>
          <h2>API Compatibility Sentinel</h2>
          <p>
            Automated semantic diffing, OpenAPI schema validation, and AI breaking change risk prevention.
          </p>
        </div>

        <div className="auth-feature-list">
          {WORKFLOW_STEPS.slice(0, 3).map((step, idx) => (
            <div key={step.label} className="auth-feature-item">
              <span className="auth-feature-num">0{idx + 1}</span>
              <div>
                <strong>{step.label}</strong>
                <p>{step.detail}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="auth-video-callout">
          <button type="button" className="auth-video-btn" onClick={onOpenVideo}>
            <IconPlayCircle /> Watch 60s Platform Overview
          </button>
        </div>
      </div>

      <div className="auth-panel-wrap">
        <div className="auth-panel">
          <div className="auth-panel-header">
            <h3>{isRegister ? 'Create an Account' : 'Welcome to API Analyzer'}</h3>
            <p>
              {isRegister
                ? 'Sign up to start auditing your team’s OpenAPI releases.'
                : 'Enter your credentials to enter the comparison workspace.'}
            </p>
          </div>

          <form onSubmit={submit}>
            <label>
              <span>Username</span>
              <input
                type="text"
                value={form.username}
                onChange={(e) => update('username', e.target.value)}
                placeholder="dev_lead"
                required
              />
            </label>

            {isRegister && (
              <label>
                <span>Work Email</span>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => update('email', e.target.value)}
                  placeholder="name@company.com"
                  required
                />
              </label>
            )}

            <label>
              <span>Password</span>
              <input
                type="password"
                value={form.password}
                onChange={(e) => update('password', e.target.value)}
                placeholder="••••••••••••"
                required
              />
            </label>

            {notice.text && (
              <div className={`notice notice-${notice.type}`}>
                {notice.text}
              </div>
            )}

            <button type="submit" className="primary full-width" disabled={loading}>
              {loading ? 'Authenticating…' : isRegister ? 'Create Account' : 'Sign In'}
            </button>
          </form>

          <div className="auth-switch-row">
            {isRegister ? (
              <span>
                Already have an account? <a href="#/login">Log in here</a>
              </span>
            ) : (
              <span>
                Need an account? <a href="#/register">Create one</a>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ==========================================================================
   SVG Icons (No external dependencies)
   ========================================================================== */

function IconMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 8l-4 4 4 4" />
      <path d="M17 8l4 4-4 4" />
      <path d="M14 4l-4 16" />
    </svg>
  )
}

function IconDashboard() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  )
}

function IconCompare() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <path d="M11 18H8a2 2 0 0 1-2-2V9" />
    </svg>
  )
}

function IconHistory() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  )
}

function IconJobs() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    </svg>
  )
}

function IconLogout() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  )
}

function IconPlayCircle() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none" />
    </svg>
  )
}

function IconPlay() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  )
}

function IconPause() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  )
}

function IconSkipForward() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <polygon points="5 4 15 12 5 20 5 4" />
      <line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

function IconGithub() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .7a11.3 11.3 0 0 0-3.57 22.02c.57.1.78-.25.78-.55v-2.02c-3.18.7-3.85-1.35-3.85-1.35-.52-1.34-1.27-1.7-1.27-1.7-1.04-.72.08-.7.08-.7 1.15.08 1.75 1.18 1.75 1.18 1.02 1.75 2.67 1.25 3.32.96.1-.75.4-1.25.72-1.54-2.54-.29-5.21-1.27-5.21-5.65 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.45.11-3.02 0 0 .96-.31 3.13 1.17a10.85 10.85 0 0 1 5.69 0c2.17-1.48 3.13-1.17 3.13-1.17.62 1.57.23 2.73.11 3.02.73.8 1.18 1.82 1.18 3.07 0 4.39-2.68 5.35-5.23 5.63.41.36.77 1.07.77 2.16v3.19c0 .31.21.66.79.55A11.3 11.3 0 0 0 12 .7Z" />
    </svg>
  )
}

function IconRefresh({ className }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3L21.5 8M22 12.5a10 10 0 0 1-18.8 4.2L2.5 16" />
    </svg>
  )
}

function IconPlus() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function IconSparkles() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.912 5.885L20 10.8l-4.5 4.385L16.564 21 12 17.585 7.436 21l1.064-5.815L4 10.8l6.088-1.915L12 3z" />
    </svg>
  )
}

function IconSearch() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function IconCheck() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function IconCheckCircleLarge() {
  return (
    <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#1f8f5f" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="16 9 10 15 7 12" />
    </svg>
  )
}

function IconAlertCircle() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  )
}

function IconInfo() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  )
}

function IconClose() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function IconLayers() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  )
}

function IconAlertTriangle() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

function IconShieldCheck() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  )
}

function IconCpu() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="1" x2="9" y2="4" />
      <line x1="15" y1="1" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="23" />
      <line x1="15" y1="20" x2="15" y2="23" />
      <line x1="20" y1="9" x2="23" y2="9" />
      <line x1="20" y1="14" x2="23" y2="14" />
      <line x1="1" y1="9" x2="4" y2="9" />
      <line x1="1" y1="14" x2="4" y2="14" />
    </svg>
  )
}

function IconCompareLarge() {
  return (
    <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <path d="M11 18H8a2 2 0 0 1-2-2V9" />
    </svg>
  )
}

function IconHistoryLarge() {
  return (
    <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  )
}

function IconCpuLarge() {
  return (
    <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
    </svg>
  )
}
