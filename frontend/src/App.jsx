import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const LOCAL_API_BASE = 'http://127.0.0.1:8000/api'
const configuredApiBase = String(import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '')
const isLocalFrontend = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)

// Keep localhost convenient during development, but never silently point a
// deployed frontend at the developer's machine. Production deployments must
// provide VITE_API_BASE_URL.
const API_BASE = configuredApiBase || (isLocalFrontend ? LOCAL_API_BASE : '')

const GITHUB_ACTION_REPOSITORY = String(import.meta.env.VITE_GITHUB_ACTION_REPOSITORY || 'Sumitkokad/api_analyzer_full').trim() || 'Sumitkokad/api_analyzer_full'
const GITHUB_ACTION_REF = String(import.meta.env.VITE_GITHUB_ACTION_REF || 'main').trim() || 'main'
const API_REQUEST_TIMEOUT_MS = 60000

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

function normalizeCompatibility(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-')

  if (normalized === 'breaking') return 'breaking'
  if (normalized === 'potentially-breaking' || normalized === 'potentiallybreaking') return 'potentially-breaking'
  if (normalized === 'non-breaking' || normalized === 'compatible') return 'non-breaking'
  return 'unknown'
}

function compatibilityLabel(value) {
  const normalized = normalizeCompatibility(value)
  if (normalized === 'breaking') return 'Breaking Change'
  if (normalized === 'potentially-breaking') return 'Potential Risk'
  if (normalized === 'non-breaking') return 'Compatible'
  return 'Unclassified'
}

function compatibilityBadgeClass(value) {
  const normalized = normalizeCompatibility(value)
  if (normalized === 'breaking') return 'badge-breaking'
  if (normalized === 'potentially-breaking') return 'badge-warn'
  if (normalized === 'non-breaking') return 'badge-safe'
  return 'badge-neutral'
}

function changeItemClass(value) {
  const normalized = normalizeCompatibility(value)
  if (normalized === 'breaking') return 'is-breaking'
  if (normalized === 'potentially-breaking') return 'is-potential'
  if (normalized === 'non-breaking') return 'is-safe'
  return 'is-unknown'
}

function getComparisonCounts(comparison) {
  const changes = Array.isArray(comparison?.changes) ? comparison.changes : []
  const persisted = comparison?.summary_counts || comparison?.summary || {}

  // Detailed change records are the most useful source for the UI because
  // legacy summaries may have been produced before potentially-breaking was
  // separated from non-breaking. Recalculate whenever records are present.
  if (changes.length > 0) {
    return changes.reduce(
      (acc, change) => {
        const classification = normalizeCompatibility(change?.compatibility)
        acc.total += 1
        if (classification === 'breaking') acc.breaking += 1
        else if (classification === 'potentially-breaking') acc.potentiallyBreaking += 1
        else if (classification === 'non-breaking') acc.nonBreaking += 1
        else acc.unknown += 1
        return acc
      },
      { total: 0, breaking: 0, potentiallyBreaking: 0, nonBreaking: 0, unknown: 0 },
    )
  }

  const persistedBreaking = Number(persisted.breaking)
  const persistedPotential = Number(
    persisted.potentially_breaking ?? persisted.potentiallyBreaking,
  )
  const persistedNonBreaking = Number(
    persisted.non_breaking ?? persisted.nonBreaking,
  )
  const persistedTotal = Number(persisted.total)

  const breaking = Number.isFinite(persistedBreaking) && persistedBreaking >= 0 ? persistedBreaking : 0
  const potentiallyBreaking = Number.isFinite(persistedPotential) && persistedPotential >= 0 ? persistedPotential : 0
  const nonBreaking = Number.isFinite(persistedNonBreaking) && persistedNonBreaking >= 0 ? persistedNonBreaking : 0
  const total = Number.isFinite(persistedTotal) && persistedTotal >= 0
    ? persistedTotal
    : breaking + potentiallyBreaking + nonBreaking
  const unknown = Math.max(0, total - breaking - potentiallyBreaking - nonBreaking)

  return { total, breaking, potentiallyBreaking, nonBreaking, unknown }
}

function getGateStatus(comparison) {
  const explicitGate = String(comparison?.gate_status || '').trim().toUpperCase()
  if (['PASS', 'WARN', 'FAIL', 'ERROR'].includes(explicitGate)) return explicitGate

  const status = String(comparison?.status || '').trim().toLowerCase()
  if (status === 'queued' || status === 'running') return 'PENDING'
  if (status === 'failed') return 'ERROR'
  return 'UNASSESSED'
}

function gateBadgeClass(gateStatus) {
  switch (String(gateStatus || '').toUpperCase()) {
    case 'PASS':
      return 'badge-safe'
    case 'WARN':
      return 'badge-warn'
    case 'FAIL':
    case 'ERROR':
      return 'badge-breaking'
    default:
      return 'badge-neutral'
  }
}

function gateDescription(comparison) {
  const gate = getGateStatus(comparison)
  const reason = comparison?.gate_reason_code || comparison?.reason_code

  if (gate === 'PASS') return reason ? `Gate passed · ${reason}` : 'No prohibited breaking changes'
  if (gate === 'WARN') return reason ? `Review required · ${reason}` : 'Review required before release'
  if (gate === 'FAIL') return reason ? `Release blocked · ${reason}` : 'Breaking changes exceed project policy'
  if (gate === 'ERROR') return reason ? `Analysis failed · ${reason}` : 'Analyzer could not complete safely'
  if (gate === 'PENDING') return 'Analysis is still running'
  return 'No machine-readable gate result is available'
}

function getProjectName(projects, projectId) {
  const match = projects.find((project) => String(project.id) === String(projectId))
  return match?.name || (projectId ? `Project #${projectId}` : '—')
}

function maskSecret(value) {
  const text = String(value || '')
  if (!text) return ''
  if (text.length <= 12) return '••••••••••••'
  return `${text.slice(0, 5)}${'•'.repeat(Math.max(8, Math.min(24, text.length - 10)))}${text.slice(-5)}`
}

function githubConfigKey(projectId) {
  return `apiAnalyzerGithubCI:v2:${projectId || 'none'}`
}

function readGithubConfig(projectId) {
  if (!projectId) return {}

  try {
    const value = localStorage.getItem(githubConfigKey(projectId))
    return value ? JSON.parse(value) : {}
  } catch {
    return {}
  }
}

function writeGithubConfig(projectId, config) {
  if (!projectId) return

  try {
    localStorage.setItem(githubConfigKey(projectId), JSON.stringify(config))
  } catch {
    // Local draft persistence is optional; never block CI setup if storage is unavailable.
  }
}

const VALID_ROUTES = new Set([
  'login',
  'register',
  'dashboard',
  'compare',
  'history',
  'jobs',
  'github',
  'demo',
])

const PENDING_AUTH_ROUTE_KEY = 'apiAnalyzerPendingAuthRoute:v1'
const LAST_PROJECT_KEY = 'apiAnalyzerLastProjectId:v1'
const GITHUB_CALLBACK_PROJECT_KEY = 'apiAnalyzerGithubCallbackProjectId'

function parseHashLocation() {
  const rawHash = String(window.location.hash || '')
  const raw = rawHash.startsWith('#/')
    ? rawHash.slice(2)
    : rawHash.replace(/^#/, '')

  const [rawRoute = '', rawQuery = ''] = raw.split('?', 2)
  const candidateRoute = String(rawRoute || '').trim().toLowerCase()
  const route = VALID_ROUTES.has(candidateRoute)
    ? candidateRoute
    : 'dashboard'

  return {
    route,
    params: new URLSearchParams(rawQuery),
  }
}

function routeParamsObject(params) {
  const result = {}
  if (!params) return result
  params.forEach((value, key) => {
    result[key] = value
  })
  return result
}

function buildHashPath(route, params = {}) {
  const safeRoute = VALID_ROUTES.has(String(route || '').toLowerCase())
    ? String(route).toLowerCase()
    : 'dashboard'

  const query = new URLSearchParams()
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value) !== '') {
      query.set(key, String(value))
    }
  })

  const queryString = query.toString()
  return `#/${safeRoute}${queryString ? `?${queryString}` : ''}`
}

function navigateTo(route, params = {}) {
  const nextHash = buildHashPath(route, params)
  if (window.location.hash !== nextHash) {
    window.location.hash = nextHash
  }
}

function savePendingAuthRoute(locationState) {
  if (!locationState || !locationState.route) return

  try {
    sessionStorage.setItem(
      PENDING_AUTH_ROUTE_KEY,
      JSON.stringify({
        route: locationState.route,
        params: routeParamsObject(locationState.params),
      }),
    )
  } catch {
    // Session storage is optional.
  }
}

function readPendingAuthRoute() {
  try {
    const raw = sessionStorage.getItem(PENDING_AUTH_ROUTE_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw)
    if (!parsed || !VALID_ROUTES.has(String(parsed.route || '').toLowerCase())) {
      return null
    }

    return {
      route: String(parsed.route).toLowerCase(),
      params: parsed.params && typeof parsed.params === 'object'
        ? parsed.params
        : {},
    }
  } catch {
    return null
  }
}

function clearPendingAuthRoute() {
  try {
    sessionStorage.removeItem(PENDING_AUTH_ROUTE_KEY)
  } catch {
    // Session storage is optional.
  }
}

function rememberLastProject(projectId) {
  if (!projectId) return
  try {
    localStorage.setItem(LAST_PROJECT_KEY, String(projectId))
  } catch {
    // Local storage is optional.
  }
}

function readLastProjectId() {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY) || ''
  } catch {
    return ''
  }
}

function extractGithubCallback() {
  const hashLocation = parseHashLocation()
  const rootParams = new URLSearchParams(window.location.search || '')
  const hasRootCallback = rootParams.has('github')
  const hasHashCallback = hashLocation.params.has('github')

  if (!hasRootCallback && !hasHashCallback) return null

  const source = hasHashCallback ? hashLocation.params : rootParams
  const github = String(source.get('github') || '').trim().toLowerCase()
  const projectId = String(source.get('project_id') || '').trim()
  const reason = String(source.get('reason') || '').trim()

  if (!github) return null

  return {
    result: github,
    projectId,
    reason,
    location: hashLocation,
    fromRootQuery: hasRootCallback,
  }
}

function cleanLegacyRootQuery() {
  if (!window.location.search) return
  const cleanedUrl = `${window.location.pathname}${window.location.hash}`
  window.history.replaceState({}, document.title, cleanedUrl)
}

function githubCallbackMessage(result, reason) {
  if (result === 'connected') {
    return {
      text: 'GitHub App connected successfully. Select the repository to finish setup.',
      type: 'success',
    }
  }

  const reasonMessages = {
    github_app_not_configured: 'GitHub App is not configured on the analyzer backend.',
    github_authorization_incomplete: 'GitHub authorization was not completed.',
    github_installation_verification_failed: 'GitHub installation verification failed. Review the GitHub App configuration and try again.',
    github_connection_failed: 'The GitHub connection could not be completed.',
    invalid_or_expired_state: 'The GitHub installation link expired. Start the connection again.',
    missing_state: 'The GitHub callback did not include a valid state.',
  }

  return {
    text: reasonMessages[reason] || 'GitHub connection did not complete successfully.',
    type: 'error',
  }
}

export default function App() {
  const initialLocation = parseHashLocation()
  const [session, setSession] = useState(readSession)
  const [routeLocation, setRouteLocation] = useState(initialLocation)
  const [projects, setProjects] = useState([])
  const [comparisons, setComparisons] = useState([])
  const [jobs, setJobs] = useState([])
  const [activeComparison, setActiveComparison] = useState(null)
  const [notice, setNotice] = useState({ text: '', type: 'info' })
  const [loading, setLoading] = useState(false)
  const [runPhase, setRunPhase] = useState(null)
  const [demoModalOpen, setDemoModalOpen] = useState(false)
  const authed = Boolean(session.token)
  const route = routeLocation.route
  const routeParams = routeLocation.params

  useEffect(() => {
    const onLocationChange = () => {
      setRouteLocation(parseHashLocation())
    }

    window.addEventListener('hashchange', onLocationChange)
    window.addEventListener('popstate', onLocationChange)

    return () => {
      window.removeEventListener('hashchange', onLocationChange)
      window.removeEventListener('popstate', onLocationChange)
    }
  }, [])

  const showNotice = (text, type = 'info') => {
    setNotice({ text, type })
    if (type !== 'error') {
      window.setTimeout(() => setNotice({ text: '', type: 'info' }), 6000)
    }
  }

  useEffect(() => {
    if (authed) return

    if (route === 'login' || route === 'register') return

    // The bare site URL resolves to dashboard, but that is only the default
    // landing page. Do not remember that default as a deep-link destination;
    // a fresh registration should therefore continue into Compare.
    const hasExplicitHash = Boolean(window.location.hash)
    if (route === 'dashboard' && !hasExplicitHash) return

    savePendingAuthRoute(routeLocation)
  }, [authed, route, routeLocation])

  useEffect(() => {
    const callback = extractGithubCallback()
    if (!callback) return

    const { result, projectId, reason, fromRootQuery } = callback

    if (projectId) {
      try {
        sessionStorage.setItem(
          GITHUB_CALLBACK_PROJECT_KEY,
          String(projectId),
        )
      } catch {
        // Session storage is optional.
      }
    }

    if (!authed) {
      // Preserve the complete callback route until authentication succeeds.
      savePendingAuthRoute({
        route: 'github',
        params: {
          github: result,
          ...(projectId ? { project_id: projectId } : {}),
          ...(reason ? { reason } : {}),
        },
      })

      if (fromRootQuery) {
        cleanLegacyRootQuery()
      }
      return
    }

    const targetParams = projectId ? { project_id: projectId } : {}
    navigateTo('github', targetParams)

    const callbackNotice = githubCallbackMessage(result, reason)
    setNotice(callbackNotice)

    if (fromRootQuery) {
      cleanLegacyRootQuery()
    }

    // Remove callback-only query fields from the hash after the message has
    // been captured. The canonical GitHub CI URL keeps only project_id.
    if (routeParams.has('github')) {
      window.setTimeout(() => {
        navigateTo('github', targetParams)
      }, 0)
    }
  }, [authed, routeParams])

  const apiFetch = useCallback(async (path, options = {}) => {
    if (!API_BASE) {
      throw new Error('API base URL is not configured. Set VITE_API_BASE_URL for this frontend deployment.')
    }

    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS)
    const headers = new Headers(options.headers || {})
    headers.set('Accept', 'application/json')

    if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

    if (session.token) headers.set('Authorization', `Token ${session.token}`)

    try {
      const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers,
        signal: controller.signal,
      })

      if (response.status === 204) return null

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        if (response.status === 401 && !String(path).startsWith('/auth/')) {
          const currentLocation = parseHashLocation()
          if (currentLocation.route !== 'login' && currentLocation.route !== 'register') {
            savePendingAuthRoute(currentLocation)
          }

          localStorage.removeItem('apiAnalyzerToken')
          localStorage.removeItem('apiAnalyzerUser')
          setSession({ token: null, user: null })
          navigateTo('login')

          throw new Error('Your session expired. Please sign in again.')
        }

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

          if (messages.length) errorMsg = messages.join(' | ')
        }

        throw new Error(errorMsg)
      }

      return data
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('Request timed out. Check the analyzer backend and try again.')
      }
      throw error
    } finally {
      window.clearTimeout(timeoutId)
    }
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

  const refreshComparisons = useCallback(async () => {
    try {
      const comparisonData = await apiFetch('/comparisons/')
      const nextComparisons = normalizeList(comparisonData)
      setComparisons(nextComparisons)
      setActiveComparison((current) => {
        if (!current && nextComparisons.length) return nextComparisons[0]
        if (current) {
          const matched = nextComparisons.find((comparison) => String(comparison.id) === String(current.id))
          return matched || nextComparisons[0] || null
        }
        return null
      })
    } catch (error) {
      setNotice({ text: error.message || 'Unable to refresh comparison status.', type: 'error' })
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
      const data = await apiFetch(`/auth/${mode}/`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })

      localStorage.setItem('apiAnalyzerToken', data.token)
      localStorage.setItem('apiAnalyzerUser', JSON.stringify(data.user))
      setSession({ token: data.token, user: data.user })

      const pending = readPendingAuthRoute()
      clearPendingAuthRoute()

      const fallbackRoute = mode === 'register' ? 'compare' : 'dashboard'
      const destination = pending || { route: fallbackRoute, params: {} }

      if (destination.route === 'login' || destination.route === 'register') {
        navigateTo(fallbackRoute)
      } else {
        navigateTo(destination.route, destination.params)
      }

      showNotice(
        `Signed in successfully as ${data.user?.username || 'user'}.`,
        'success',
      )
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

    try {
      Object.keys(localStorage)
        .filter((key) => key.startsWith('apiAnalyzerGithubCI:'))
        .forEach((key) => localStorage.removeItem(key))
    } catch {
      // Ignore storage cleanup failures during logout.
    }
    setSession({ token: null, user: null })
    setProjects([])
    setComparisons([])
    setJobs([])
    setActiveComparison(null)
    clearPendingAuthRoute()
    try {
      sessionStorage.removeItem(GITHUB_CALLBACK_PROJECT_KEY)
    } catch {
      // Session storage is optional.
    }
    localStorage.removeItem(LAST_PROJECT_KEY)
    navigateTo('login')
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
      rememberLastProject(projectId)

      showNotice(
        'Comparison completed successfully! Results and AI analysis are ready below.',
        'success'
      )

      await refreshData()
      navigateTo('dashboard')
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
              href={
                id === 'github' &&
                (activeComparison?.project || readLastProjectId() || projects[0]?.id)
                  ? buildHashPath('github', {
                      project_id:
                        activeComparison?.project ||
                        readLastProjectId() ||
                        projects[0]?.id,
                    })
                  : buildHashPath(id)
              }
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
              onClick={() => navigateTo('compare')}
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
            onCloseDemo={() => navigateTo('dashboard')}
            onOpenCompare={() => navigateTo('compare')}
          />
        )}

        {route === 'dashboard' && (
          <Dashboard
            comparison={latestComparison}
            loading={loading}
            onOpenCompare={() => navigateTo('compare')}
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
            projects={projects}
            onSelect={(comp) => {
              setActiveComparison(comp)
              navigateTo('dashboard')
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
            routeProjectId={routeParams.get('project_id') || ''}
            preferredProjectId={
              activeComparison?.project ||
              readLastProjectId() ||
              projects[0]?.id ||
              ''
            }
            onOpenCompare={() => navigateTo('compare')}
            onSelectComparison={(comp) => {
              setActiveComparison(comp)
              navigateTo('dashboard')
            }}
            onRefresh={refreshComparisons}
            apiFetch={apiFetch}
          />
        )}
      </main>

      {/* Product Demo Modal */}
      {demoModalOpen && (
        <ProductDemoModal
          onClose={() => setDemoModalOpen(false)}
          onStartCompare={() => {
            setDemoModalOpen(false)
            navigateTo('compare')
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
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')

  const summary = comparison?.summary || {}
  const changes = comparison?.changes || []
  const counts = useMemo(() => getComparisonCounts(comparison), [comparison])
  const gateStatus = getGateStatus(comparison)

  const filteredChanges = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()

    return changes.filter((change) => {
      const classification = normalizeCompatibility(change.compatibility)
      const matchType =
        filter === 'all'
          ? true
          : filter === 'breaking'
            ? classification === 'breaking'
            : filter === 'potentially-breaking'
              ? classification === 'potentially-breaking'
              : filter === 'non-breaking'
                ? classification === 'non-breaking'
                : false

      const matchSearch =
        !normalizedSearch ||
        String(change.endpoint || '').toLowerCase().includes(normalizedSearch) ||
        String(change.change_type || '').toLowerCase().includes(normalizedSearch) ||
        String(change.parameter || '').toLowerCase().includes(normalizedSearch) ||
        String(change.schema_path || '').toLowerCase().includes(normalizedSearch) ||
        String(change.rule_id || '').toLowerCase().includes(normalizedSearch)

      return matchType && matchSearch
    })
  }, [changes, filter, search])

  return (
    <div className="dashboard-layout">
      <div className="metrics-grid">
        <Metric
          label="Total Contract Changes"
          value={counts.total}
          sub={`${counts.breaking} breaking · ${counts.potentiallyBreaking} potential · ${counts.nonBreaking} compatible`}
          icon={IconLayers}
        />
        <Metric
          label="Breaking Changes"
          value={counts.breaking}
          tone="danger"
          sub={counts.breaking ? 'Review before release' : 'None detected'}
          icon={IconAlertTriangle}
        />
        <Metric
          label="Compatible Updates"
          value={counts.nonBreaking}
          tone="good"
          sub={counts.potentiallyBreaking ? `${counts.potentiallyBreaking} potential risk item${counts.potentiallyBreaking === 1 ? '' : 's'}` : 'No potential-risk items'}
          icon={IconShieldCheck}
        />
        <Metric
          label="CI Gate"
          value={comparison ? gateStatus : 'IDLE'}
          tone={gateStatus === 'FAIL' || gateStatus === 'ERROR' ? 'danger' : gateStatus === 'WARN' ? 'warn' : gateStatus === 'PASS' ? 'good' : undefined}
          sub={comparison ? (comparison.gate_reason_code || `Comparison #${comparison.id}`) : 'No active comparison'}
          icon={IconCpu}
        />
      </div>

      {comparison && (
        <div className="comparison-context-bar">
          <div>
            <span>Audit</span>
            <strong>Comparison #{comparison.id}</strong>
          </div>
          <div>
            <span>Repository</span>
            <strong>{comparison.repository || 'Manual comparison'}</strong>
          </div>
          <div>
            <span>Revision pair</span>
            <strong>
              {comparison.base_sha ? String(comparison.base_sha).slice(0, 10) : 'base'}
              {' → '}
              {comparison.head_sha ? String(comparison.head_sha).slice(0, 10) : 'head'}
            </strong>
          </div>
          <div>
            <span>Decision</span>
            <span className={`badge ${gateBadgeClass(gateStatus)}`}>{gateStatus}</span>
          </div>
        </div>
      )}

      <div className="dashboard-grid">
        <section className="panel workflow-panel">
          <div className="section-title">
            <div>
              <h2>Pipeline Workflow Guide</h2>
              <p>Step-by-step lifecycle of an API compatibility audit.</p>
            </div>
            <button type="button" className="text-action-btn" onClick={onOpenVideo}>
              <IconPlayCircle /> Open Product Demo
            </button>
          </div>

          <WorkflowGuide onOpenVideo={onOpenVideo} />
        </section>

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
              <p>Evaluating OpenAPI contracts and classifying semantic changes…</p>
            </div>
          )}

          {!comparison && !loading && (
            <EmptyState onOpenCompare={onOpenCompare} onOpenVideo={onOpenVideo} />
          )}

          {comparison && !loading && (
            <div className="changes-browser">
              {counts.unknown > 0 && (
                <div className="notice notice-warning classification-warning">
                  <span className="notice-icon"><IconAlertCircle /></span>
                  <span className="notice-body">
                    {counts.unknown} change{counts.unknown === 1 ? '' : 's'} could not be mapped to a known compatibility class. Treating these as unclassified instead of silently calling them safe.
                  </span>
                </div>
              )}

              <div className="filter-toolbar">
                <div className="filter-tabs">
                  <button type="button" className={`filter-tab ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
                    All ({changes.length})
                  </button>
                  <button type="button" className={`filter-tab tab-breaking ${filter === 'breaking' ? 'active' : ''}`} onClick={() => setFilter('breaking')}>
                    Breaking ({counts.breaking})
                  </button>
                  <button type="button" className={`filter-tab tab-potential ${filter === 'potentially-breaking' ? 'active' : ''}`} onClick={() => setFilter('potentially-breaking')}>
                    Potential ({counts.potentiallyBreaking})
                  </button>
                  <button type="button" className={`filter-tab tab-safe ${filter === 'non-breaking' ? 'active' : ''}`} onClick={() => setFilter('non-breaking')}>
                    Compatible ({counts.nonBreaking})
                  </button>
                </div>

                <div className="filter-search-box">
                  <IconSearch />
                  <input
                    type="search"
                    placeholder="Search endpoint, field or rule…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              </div>

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
        const classification = normalizeCompatibility(change.compatibility)
        const badgeClass = compatibilityBadgeClass(classification)
        const itemClass = changeItemClass(classification)
        const evidence = Array.isArray(change.evidence) ? change.evidence : []
        const flags = Array.isArray(change.flags) ? change.flags : []

        return (
          <article key={change.id || change.stable_hash || index} className={`change-item ${itemClass}`}>
            <div className="change-heading">
              <div className="change-title-group">
                <span className="change-index">#{String(index + 1).padStart(2, '0')}</span>
                <span className="change-endpoint">{change.endpoint || '/'}</span>
                <span className={`badge ${badgeClass}`}>{compatibilityLabel(classification)}</span>
              </div>
              <span className="change-category">{change.change_type || 'Contract Diff'}</span>
            </div>

            <div className="change-meta">
              <strong>Target:</strong> {change.parameter || change.schema_path || 'Endpoint root definition'}
            </div>

            <div className="change-signals">
              {change.method && <span className="change-signal">{String(change.method).toUpperCase()}</span>}
              {change.direction && change.direction !== 'unknown' && <span className="change-signal">{change.direction}</span>}
              {change.relation && <span className="change-signal">relation: {change.relation}</span>}
              {change.rule_id && <span className="change-signal change-signal-mono">rule: {change.rule_id}</span>}
              {change.severity && <span className="change-signal">severity: {change.severity}</span>}
              {flags.map((flag) => <span key={flag} className="change-signal change-signal-flag">{flag}</span>)}
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
              <ImpactBox analysis={change.llm_analysis} classification={classification} />
            )}

            {evidence.length > 0 && (
              <details className="evidence-toggle">
                <summary>Supporting Evidence ({evidence.length})</summary>
                <div className="evidence-content">
                  {evidence.map((item, idx) => (
                    <div key={idx} className="evidence-item">
                      <div className="evidence-item-meta">
                        <span>{item.source_type || item.source || 'spec'}</span>
                        <span>{item.retrieval || 'exact'}</span>
                        {item.location && <span>{item.location}</span>}
                      </div>
                      <pre>{item.excerpt || JSON.stringify(item, null, 2)}</pre>
                    </div>
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

function ImpactBox({ analysis, classification }) {
  const status = String(analysis?.status || '').toLowerCase()
  const isGenerated = status === 'generated' || status === 'completed'
  const isSkipped = status === 'skipped'
  const isFailed = status === 'failed'

  const reasonLabel =
    classification === 'breaking'
      ? 'Why this breaks clients'
      : classification === 'potentially-breaking'
        ? 'Why this needs review'
        : classification === 'non-breaking'
          ? 'Compatibility rationale'
          : 'Analyzer rationale'

  return (
    <div className={`analysis-box ${isFailed ? 'analysis-box-failed' : ''}`}>
      <div className="analysis-header">
        <IconSparkles />
        <span>{isGenerated ? 'AI Impact Analysis & Remediation' : 'Impact Analysis & Remediation'}</span>
        <span className={`impact-status ${isGenerated ? 'is-generated' : isFailed ? 'is-failed' : 'is-pending'}`}>
          {isGenerated ? 'generated' : isFailed ? 'failed' : isSkipped ? 'skipped' : (status || 'pending')}
        </span>
      </div>

      <div className="analysis-section">
        <span className="analysis-label">{reasonLabel}</span>
        <p>
          {analysis?.reason ||
            (isSkipped
              ? 'AI explanation was intentionally skipped. The deterministic rule result remains authoritative.'
              : 'No explanation is available yet.')}
        </p>
      </div>

      {analysis?.impact && (
        <div className="analysis-section">
          <span className="analysis-label">Downstream Impact</span>
          <p>{analysis.impact}</p>
        </div>
      )}

      {analysis?.recommendation && (
        <div className="analysis-section">
          <span className="analysis-label">Suggested Resolution</span>
          <p className="recommendation-text">{analysis.recommendation}</p>
        </div>
      )}

      {Array.isArray(analysis?.affected_components) && analysis.affected_components.length > 0 && (
        <div className="component-row">
          <span className="component-label">Affected Components:</span>
          {analysis.affected_components.map((item, i) => (
            <span key={i} className="component-pill">{item}</span>
          ))}
        </div>
      )}

      <div className="analysis-footer-row">
        {analysis?.confidence_label && (
          <span className="impact-confidence">Confidence: {analysis.confidence_label}</span>
        )}
        {analysis?.model && isGenerated && <span className="impact-confidence">Model: {analysis.model}</span>}
        {analysis?.llm_status && <span className="impact-confidence">Provider: {analysis.llm_status}</span>}
        {analysis?.error && <span className="impact-error">{analysis.error}</span>}
      </div>
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

function comparisonSummaryNote(comparison) {
  if (!comparison) return 'No CI comparison is available for the selected project yet.'
  return gateDescription(comparison)
}

function GitHubCIPage({
  projects,
  comparisons,
  routeProjectId,
  preferredProjectId,
  onOpenCompare,
  onSelectComparison,
  onRefresh,
  apiFetch,
}) {
  const [projectId, setProjectId] = useState(() => {
    try {
      return (
        routeProjectId ||
        sessionStorage.getItem(GITHUB_CALLBACK_PROJECT_KEY) ||
        preferredProjectId ||
        projects[0]?.id ||
        ''
      )
    } catch {
      return routeProjectId || preferredProjectId || projects[0]?.id || ''
    }
  })

  const [repository, setRepository] = useState('')
  const [githubConnection, setGithubConnection] = useState({
    connected: false,
    installation_connected: false,
    installation_id: '',
    repository_full_name: '',
    metadata: {},
  })
  const [githubRepositories, setGithubRepositories] = useState([])
  const [githubLoading, setGithubLoading] = useState(false)
  const [githubConnecting, setGithubConnecting] = useState(false)
  const [repositoryConnecting, setRepositoryConnecting] = useState(false)
  const [setupLoading, setSetupLoading] = useState(false)
  const [githubError, setGithubError] = useState('')
  const [setupResult, setSetupResult] = useState(null)
  const [setupError, setSetupError] = useState('')

  useEffect(() => {
    const preferred =
      routeProjectId ||
      preferredProjectId ||
      projectId ||
      projects[0]?.id ||
      ''

    if (preferred && String(preferred) !== String(projectId)) {
      setProjectId(preferred)
    } else if (!projectId && preferred) {
      setProjectId(preferred)
    }
  }, [routeProjectId, preferredProjectId, projects, projectId])

  const selectedProject = projects.find(
    (project) => String(project.id) === String(projectId),
  )

  const selectedGithubRepository = useMemo(
    () =>
      githubRepositories.find(
        (item) =>
          String(item.full_name || '').toLowerCase() ===
          String(repository || '').toLowerCase(),
      ) || null,
    [githubRepositories, repository],
  )

  const connectedRuns = useMemo(() => {
    const projectMatches = comparisons.filter(
      (comparison) =>
        String(comparison.project) === String(projectId),
    )

    const normalizedRepo = repository.trim().toLowerCase()

    return projectMatches
      .filter((comparison) => {
        if (!normalizedRepo) return true

        return (
          String(comparison.repository || '').toLowerCase() ===
          normalizedRepo
        )
      })
      .sort((a, b) => {
        const aTime = new Date(
          a.updated_at || a.created_at || 0,
        ).getTime()

        const bTime = new Date(
          b.updated_at || b.created_at || 0,
        ).getTime()

        return bTime - aTime
      })
  }, [comparisons, projectId, repository])

  const activeRunExists = connectedRuns.some((comparison) => {
    const status = String(
      comparison.status || '',
    ).toLowerCase()

    return status === 'queued' || status === 'running'
  })

  useEffect(() => {
    if (!activeRunExists || !onRefresh) return undefined

    const timer = window.setInterval(
      () => onRefresh(),
      10000,
    )

    return () => window.clearInterval(timer)
  }, [activeRunExists, onRefresh])

  const loadGithubState = useCallback(
    async (selectedProjectId) => {
      if (!selectedProjectId) {
        setGithubConnection({
          connected: false,
          installation_connected: false,
          installation_id: '',
          repository_full_name: '',
          metadata: {},
        })
        setGithubRepositories([])
        setRepository('')
        return
      }

      setGithubLoading(true)
      setGithubError('')

      try {
        const connection = await apiFetch(
          `/github/connection/?project_id=${selectedProjectId}`,
        )

        const normalizedConnection = {
          connected: Boolean(connection?.connected),
          installation_connected: Boolean(
            connection?.installation_connected,
          ),
          installation_id: String(
            connection?.installation_id || '',
          ),
          repository_full_name: String(
            connection?.repository_full_name || '',
          ),
          metadata: connection?.metadata || {},
        }

        setGithubConnection(normalizedConnection)

        if (normalizedConnection.installation_connected) {
          const repositoryData = await apiFetch(
            `/github/repositories/?project_id=${selectedProjectId}`,
          )

          const repositories = Array.isArray(
            repositoryData?.repositories,
          )
            ? repositoryData.repositories
            : []

          setGithubRepositories(repositories)

          if (normalizedConnection.repository_full_name) {
            setRepository(
              normalizedConnection.repository_full_name,
            )
          } else {
            setRepository('')
          }
        } else {
          setGithubRepositories([])
          setRepository('')
        }
      } catch (error) {
        setGithubRepositories([])
        setRepository('')
        setGithubError(
          error.message ||
            'Unable to load GitHub connection status.',
        )
      } finally {
        setGithubLoading(false)
      }
    },
    [apiFetch],
  )

  useEffect(() => {
    if (!projectId) return

    setSetupResult(null)
    setSetupError('')

    loadGithubState(projectId)
  }, [projectId, loadGithubState])

  const connectGithub = async () => {
    if (!projectId) {
      setGithubError(
        'Select an analyzer project before connecting GitHub.',
      )
      return
    }

    setGithubConnecting(true)
    setGithubError('')

    try {
      const data = await apiFetch(
        `/github/install/start/?project_id=${projectId}`,
      )

      if (data?.already_connected) {
        rememberLastProject(projectId)
        navigateTo('github', { project_id: projectId })
        await loadGithubState(projectId)
        setGithubConnecting(false)
        return
      }

      if (!data?.install_url) {
        throw new Error(
          'The backend did not return a GitHub installation URL.',
        )
      }

      rememberLastProject(projectId)
      navigateTo('github', { project_id: projectId })
      window.location.assign(data.install_url)
    } catch (error) {
      setGithubError(
        error.message ||
          'Unable to start the GitHub App installation.',
      )
      setGithubConnecting(false)
    }
  }

  const refreshGithub = async () => {
    await loadGithubState(projectId)
  }

  const connectRepository = async () => {
    if (!projectId) {
      setGithubError(
        'Select an analyzer project first.',
      )
      return
    }

    if (!repository) {
      setGithubError(
        'Select a repository first.',
      )
      return
    }

    setRepositoryConnecting(true)
    setGithubError('')
    setSetupResult(null)
    setSetupError('')

    try {
      const data = await apiFetch(
        '/github/repositories/connect/',
        {
          method: 'POST',
          body: JSON.stringify({
            project_id: projectId,
            repository_full_name: repository,
          }),
        },
      )

      const connectedRepository =
        data?.repository?.full_name || repository

      setRepository(connectedRepository)

      setGithubConnection((current) => ({
        ...current,
        connected: true,
        installation_connected: true,
        repository_full_name: connectedRepository,
      }))
      rememberLastProject(projectId)
      navigateTo('github', { project_id: projectId })
    } catch (error) {
      setGithubError(
        error.message ||
          'Unable to connect the selected repository.',
      )
    } finally {
      setRepositoryConnecting(false)
    }
  }

  const createSetupPR = async () => {
    if (!projectId) {
      setSetupError('Select an analyzer project first.')
      return
    }

    if (!githubConnection.installation_connected) {
      setSetupError(
        'Connect the API Analyzer GitHub App first.',
      )
      return
    }

    const selectedRepository = String(repository || '').trim().toLowerCase()
    const connectedRepository = String(
      githubConnection.repository_full_name || ''
    ).trim().toLowerCase()

    if (
      !githubConnection.connected ||
      !selectedRepository ||
      selectedRepository !== connectedRepository
    ) {
      setSetupError(
        'Select a repository and click Use this repository before enabling compatibility.',
      )
      return
    }

    setSetupLoading(true)
    setSetupError('')
    setGithubError('')
    setSetupResult(null)

    try {
      const data = await apiFetch(
        `/projects/${projectId}/setup/`,
        {
          method: 'POST',
          body: JSON.stringify({
            project_id: projectId,
          }),
        },
      )

      if (!data?.success) {
        throw new Error(
          data?.detail ||
            'API Analyzer could not create the setup pull request.',
        )
      }

      setSetupResult(data)

      if (onRefresh) {
        window.setTimeout(() => onRefresh(), 500)
      }
    } catch (error) {
      setSetupError(
        error.message ||
          'Automatic GitHub setup failed.',
      )
    } finally {
      setSetupLoading(false)
    }
  }

  const openGithub = () => {
    if (!repository) return

    window.open(
      `https://github.com/${repository}`,
      '_blank',
      'noopener,noreferrer',
    )
  }

  const repositoryMatchesConnection =
    Boolean(repository) &&
    String(githubConnection.repository_full_name || '').trim().toLowerCase() ===
      String(repository || '').trim().toLowerCase()

  const setupReady =
    githubConnection.installation_connected &&
    githubConnection.connected &&
    repositoryMatchesConnection

  const setupAlreadyExists = Boolean(
    setupResult?.setup?.pull_request_url,
  )

  return (
    <section className="github-ci-page">
      <div className="github-ci-hero">
        <div>
          <span className="github-ci-kicker">
            CI / GITHUB ACTIONS
          </span>

          <h2>Connect your API repository</h2>

          <p>
            Connect GitHub once. API Analyzer detects the API contract
            setup and creates one reviewable setup pull request for you.
            No tokens, workflow YAML, or OpenAPI files need to be copied
            manually.
          </p>
        </div>

        <div className="github-ci-hero-actions">
          <span
            className={`badge ${
              setupReady
                ? 'badge-safe'
                : 'badge-warn'
            }`}
          >
            {setupReady
              ? 'Ready to enable'
              : 'Setup required'}
          </span>

          {repository && (
            <button
              type="button"
              className="secondary"
              onClick={openGithub}
            >
              <IconGithub /> Repository
            </button>
          )}

          <button
            type="button"
            className="primary"
            onClick={onOpenCompare}
          >
            <IconCompare /> Manual Compare
          </button>
        </div>
      </div>

      <div className="github-ci-layout">
        <div className="github-ci-main">
          <section className="panel github-ci-card">
            <div className="section-title">
              <div>
                <h3>1. Choose your analyzer project</h3>
                <p>
                  This project stores the compatibility history for the
                  repository you connect.
                </p>
              </div>

              {selectedProject && (
                <span className="status-pill">
                  {selectedProject.name} · #{selectedProject.id}
                </span>
              )}
            </div>

            <label>
              <span>Analyzer Project</span>

              <select
                value={projectId}
                onChange={(event) => {
                  const nextProjectId = event.target.value
                  setProjectId(nextProjectId)
                  setGithubError('')
                  setSetupError('')
                  setSetupResult(null)
                  rememberLastProject(nextProjectId)
                  navigateTo('github', { project_id: nextProjectId })
                }}
              >
                <option value="">
                  Select a project
                </option>

                {projects.map((project) => (
                  <option
                    key={project.id}
                    value={project.id}
                  >
                    {project.name} (#{project.id})
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section className="panel github-ci-card">
            <div className="section-title">
              <div>
                <h3>2. Connect GitHub</h3>
                <p>
                  API Analyzer uses the GitHub App to read the repositories
                  you authorize. You never paste a GitHub token here.
                </p>
              </div>

              <span
                className={`status-pill ${
                  githubConnection.installation_connected
                    ? 'github-status-ok'
                    : ''
                }`}
              >
                {githubConnection.installation_connected
                  ? 'Connected'
                  : 'Not connected'}
              </span>
            </div>

            {!githubConnection.installation_connected ? (
              <div className="github-app-connection-body">
                <div className="github-app-steps">
                  <div>
                    <span>01</span>
                    <strong>Connect GitHub</strong>
                    <small>
                      Authorize the API Analyzer GitHub App.
                    </small>
                  </div>

                  <div>
                    <span>02</span>
                    <strong>Select repository</strong>
                    <small>
                      Choose the repository containing your API.
                    </small>
                  </div>

                  <div>
                    <span>03</span>
                    <strong>Create setup PR</strong>
                    <small>
                      Analyzer prepares the one-time integration.
                    </small>
                  </div>
                </div>

                <button
                  type="button"
                  className="primary github-connect-button"
                  onClick={connectGithub}
                  disabled={
                    githubConnecting ||
                    githubLoading ||
                    !projectId
                  }
                >
                  <IconGithub />
                  {githubConnecting
                    ? 'Opening GitHub…'
                    : 'Connect GitHub'}
                </button>
              </div>
            ) : (
              <div className="github-app-connection-body">
                <div className="github-repository-toolbar">
                  <label className="github-repository-selector">
                    <span>Repository</span>

                    <select
                      value={repository}
                      onChange={(event) => {
                        const nextRepository = event.target.value
                        const connectedRepository = String(
                          githubConnection.repository_full_name || ''
                        ).trim().toLowerCase()

                        setRepository(nextRepository)
                        setGithubConnection((current) => ({
                          ...current,
                          connected:
                            Boolean(nextRepository) &&
                            String(nextRepository).trim().toLowerCase() ===
                              connectedRepository,
                        }))
                        setSetupResult(null)
                        setSetupError('')
                      }}
                      disabled={
                        githubLoading ||
                        repositoryConnecting ||
                        githubRepositories.length === 0
                      }
                    >
                      <option value="">
                        Select a repository
                      </option>

                      {githubRepositories.map((item) => (
                        <option
                          key={
                            item.id ||
                            item.full_name
                          }
                          value={item.full_name}
                        >
                          {item.full_name}
                          {item.private
                            ? ' · private'
                            : ''}
                        </option>
                      ))}
                    </select>
                  </label>

                  <button
                    type="button"
                    className="secondary"
                    onClick={refreshGithub}
                    disabled={
                      githubLoading ||
                      repositoryConnecting
                    }
                  >
                    <IconRefresh
                      className={
                        githubLoading
                          ? 'spin'
                          : ''
                      }
                    />
                    {githubLoading
                      ? 'Refreshing…'
                      : 'Refresh'}
                  </button>
                </div>

                {repository && (
                  <div className="github-repository-summary">
                    <div>
                      <small>Repository</small>
                      <strong>{repository}</strong>
                    </div>

                    <div>
                      <small>Default branch</small>
                      <strong>
                        {selectedGithubRepository?.default_branch ||
                          githubConnection.metadata?.default_branch ||
                          selectedProject?.default_branch ||
                          'main'}
                      </strong>
                    </div>

                    <div>
                      <small>Visibility</small>
                      <strong>
                        {selectedGithubRepository?.private
                          ? 'Private'
                          : 'Public'}
                      </strong>
                    </div>
                  </div>
                )}

                {!githubConnection.connected && (
                  <div className="github-app-connection-actions">
                    <button
                      type="button"
                      className="primary"
                      onClick={connectRepository}
                      disabled={
                        repositoryConnecting ||
                        githubLoading ||
                        !repository
                      }
                    >
                      <IconCheck />
                      {repositoryConnecting
                        ? 'Connecting…'
                        : 'Use this repository'}
                    </button>

                    <span className="github-inline-help">
                      This only links the selected repository to the
                      current analyzer project.
                    </span>
                  </div>
                )}

                {githubConnection.connected && (
                  <div className="github-connected-note">
                    <IconCheck />
                    Repository is connected and ready for automatic setup.
                  </div>
                )}
              </div>
            )}

            {githubError && (
              <div className="notice notice-error github-ci-callout">
                <span className="notice-icon">
                  <IconAlertCircle />
                </span>

                <span className="notice-body">
                  {githubError}
                </span>
              </div>
            )}
          </section>

          {setupReady && (
            <section className="panel github-ci-card github-simple-setup-card">
              <div className="section-title">
                <div>
                  <h3>3. Enable API compatibility</h3>
                  <p>
                    API Analyzer will scan the repository, detect the contract
                    source, provision the GitHub Actions connection, and create
                    one setup pull request for review.
                  </p>
                </div>

                <span className="status-pill github-status-ok">
                  Ready
                </span>
              </div>

              <div className="github-one-time-steps">
                <div className="github-one-time-step">
                  <span>1</span>
                  <div>
                    <strong>Detect the repository</strong>
                    <small>
                      Framework, contract source, branch, and API specification
                      are resolved by the analyzer backend.
                    </small>
                  </div>
                </div>

                <div className="github-one-time-step">
                  <span>2</span>
                  <div>
                    <strong>Configure GitHub automatically</strong>
                    <small>
                      The analyzer creates the required Actions secret,
                      repository variable, and workflow through the GitHub App.
                    </small>
                  </div>
                </div>

                <div className="github-one-time-step">
                  <span>3</span>
                  <div>
                    <strong>Review one setup pull request</strong>
                    <small>
                      You review the exact repository changes and merge them
                      normally.
                    </small>
                  </div>
                </div>
              </div>

              <button
                type="button"
                className="primary large-btn"
                onClick={createSetupPR}
                disabled={setupLoading || setupAlreadyExists}
              >
                <IconGithub />

                {setupLoading
                  ? 'Preparing setup PR…'
                  : setupAlreadyExists
                    ? 'Setup PR Already Created'
                    : 'Enable API Compatibility'}
              </button>

              {setupError && (
                <div className="notice notice-error github-ci-callout">
                  <span className="notice-icon">
                    <IconAlertCircle />
                  </span>
                  <span className="notice-body">
                    {setupError}
                  </span>
                </div>
              )}

              {setupResult?.setup?.pull_request_url && (
                <div className="github-ci-ready-banner">
                  <div className="github-ci-ready-icon">
                    <IconCheck />
                  </div>

                  <div>
                    <strong>
                      Setup pull request created
                    </strong>

                    <p>
                      {setupResult.adapter?.framework_name
                        ? `${setupResult.adapter.framework_name} was detected. `
                        : ''}
                      Review the setup PR and merge it in GitHub.
                    </p>

                    <a
                      href={
                        setupResult.setup.pull_request_url
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open setup pull request →
                    </a>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>

        <aside className="github-ci-side">
          <section className="panel github-ci-card github-live-card">
            <div className="section-title">
              <div>
                <h3>CI tracker</h3>
                <p>
                  Compatibility results already stored for this project and
                  repository.
                </p>
              </div>

              <span className="status-pill">
                {connectedRuns.length} runs
              </span>
            </div>

            {activeRunExists && (
              <div className="notice notice-info github-ci-callout">
                <span className="notice-icon">
                  <IconRefresh className="spin" />
                </span>

                <span className="notice-body">
                  An active run is being refreshed every 10 seconds.
                </span>
              </div>
            )}

            {connectedRuns.length > 0 ? (
              <div className="github-ci-runs">
                {connectedRuns
                  .slice(0, 10)
                  .map((comparison) => {
                    const gate = getGateStatus(comparison)
                    const counts =
                      getComparisonCounts(comparison)

                    const repo =
                      comparison.repository ||
                      'unknown repository'

                    const prLabel =
                      comparison.pull_request_number
                        ? `PR #${comparison.pull_request_number}`
                        : `Comparison #${comparison.id}`

                    return (
                      <article
                        className="github-ci-run-row"
                        key={comparison.id}
                      >
                        <div
                          className={`github-ci-run-status ${
                            gate === 'PASS'
                              ? 'is-pass'
                              : gate === 'WARN'
                                ? 'is-warn'
                                : gate === 'FAIL' ||
                                    gate === 'ERROR'
                                  ? 'is-fail'
                                  : 'is-pending'
                          }`}
                        >
                          {gate}
                        </div>

                        <div className="github-ci-run-main">
                          <strong>{prLabel}</strong>
                          <small>{repo}</small>

                          <small>
                            {comparison.base_sha
                              ? String(
                                  comparison.base_sha,
                                ).slice(0, 10)
                              : 'base'}
                            {' → '}
                            {comparison.head_sha
                              ? String(
                                  comparison.head_sha,
                                ).slice(0, 10)
                              : 'head'}
                          </small>

                          <small>
                            {counts.breaking} breaking ·{' '}
                            {counts.potentiallyBreaking} potential ·{' '}
                            {counts.nonBreaking} compatible
                          </small>
                        </div>

                        <div className="github-ci-run-actions">
                          <span
                            className={`badge ${gateBadgeClass(
                              gate,
                            )}`}
                          >
                            {gate}
                          </span>

                          <button
                            type="button"
                            className="secondary small-btn"
                            onClick={() =>
                              onSelectComparison(
                                comparison,
                              )
                            }
                          >
                            View
                          </button>
                        </div>
                      </article>
                    )
                  })}
              </div>
            ) : (
              <div className="github-ci-empty">
                <IconGithub />

                <strong>
                  No compatibility runs yet
                </strong>

                <p>
                  Merge the setup pull request first. Future repository PRs
                  will appear here automatically.
                </p>
              </div>
            )}
          </section>

          <section className="panel github-ci-card">
            <div className="section-title">
              <div>
                <h3>What API Analyzer handles</h3>
                <p>
                  The developer workflow stays focused on normal code reviews.
                </p>
              </div>
            </div>

            <div className="github-connection-state">
              <div className="connection-row">
                <span>GitHub App</span>
                <strong
                  className={
                    githubConnection.installation_connected
                      ? 'is-ready'
                      : 'is-pending'
                  }
                >
                  {githubConnection.installation_connected
                    ? 'Connected'
                    : 'Not connected'}
                </strong>
              </div>

              <div className="connection-row">
                <span>Repository</span>
                <strong
                  className={
                    githubConnection.connected
                      ? 'is-ready'
                      : 'is-pending'
                  }
                >
                  {repository || 'Not selected'}
                </strong>
              </div>

              <div className="connection-row">
                <span>Contract detection</span>
                <strong className="is-ready">
                  Automatic
                </strong>
              </div>

              <div className="connection-row">
                <span>GitHub credentials</span>
                <strong className="is-ready">
                  Provisioned by App
                </strong>
              </div>

              <div className="connection-row">
                <span>Setup method</span>
                <strong className="is-ready">
                  Reviewable setup PR
                </strong>
              </div>

              <div className="connection-row">
                <span>Future PR checks</span>
                <strong className="is-ready">
                  Automatic
                </strong>
              </div>
            </div>
          </section>

          <section className="panel github-ci-card">
            <div className="section-title">
              <div>
                <h3>Gate semantics</h3>
                <p>
                  Compatibility results remain PASS, WARN, FAIL, or ERROR.
                </p>
              </div>
            </div>

            <div className="github-gate-legend">
              {[
                'PASS',
                'WARN',
                'FAIL',
                'ERROR',
              ].map((gate) => (
                <div key={gate}>
                  <span
                    className={`badge ${gateBadgeClass(
                      gate,
                    )}`}
                  >
                    {gate}
                  </span>

                  <small>
                    {gate === 'PASS'
                      ? 'Safe under project policy'
                      : gate === 'WARN'
                        ? 'Review / policy risk'
                        : gate === 'FAIL'
                          ? 'Breaking change blocks release'
                          : 'Analyzer failure; not a compatibility pass'}
                  </small>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </section>
  )
}

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

function HistoryPage({ comparisons, projects, onSelect }) {
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
            <span>Gate</span>
            <span>Action</span>
          </div>

          {comparisons.map((comparison) => {
            const counts = getComparisonCounts(comparison)
            const gate = getGateStatus(comparison)
            const projectName = getProjectName(projects, comparison.project)

            return (
              <div className="history-row" key={comparison.id}>
                <span className="history-id">#{comparison.id}</span>
                <span className="history-project">
                  <strong>{projectName}</strong>
                  {comparison.repository && <small>{comparison.repository}</small>}
                </span>
                <div className="history-metrics">
                  <strong>{counts.total} diffs</strong>
                  <div className="history-count-row">
                    {counts.breaking > 0 && <span className="breaking-chip">{counts.breaking} breaking</span>}
                    {counts.potentiallyBreaking > 0 && <span className="potential-chip">{counts.potentiallyBreaking} potential</span>}
                    {counts.unknown > 0 && <span className="unknown-chip">{counts.unknown} unclassified</span>}
                  </div>
                </div>
                <div className="history-status-cell">
                  <span className={`badge ${gateBadgeClass(gate)}`}>{gate}</span>
                  <small>{comparison.gate_reason_code || comparison.status || 'unassessed'}</small>
                </div>
                <button type="button" className="secondary small-btn" onClick={() => onSelect(comparison)}>
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

function JobsPage({ jobs, comparisons, onCreateJob }) {
  const [comparisonId, setComparisonId] = useState(comparisons[0]?.id || '')
  const [expandedJob, setExpandedJob] = useState(null)

  const getStatusClass = (status) => {
    switch (String(status || '').toLowerCase()) {
      case 'completed':
        return 'badge-safe'
      case 'running':
      case 'queued':
        return 'badge-warn'
      case 'failed':
        return 'badge-breaking'
      default:
        return 'badge-neutral'
    }
  }

  const getJobComparison = (job) => comparisons.find((comparison) => String(comparison.id) === String(job.comparison))
  const getJobChanges = (job) => getJobComparison(job)?.changes || []

  const getCounts = (job) => {
    const comparison = getJobComparison(job)
    if (comparison) return getComparisonCounts(comparison)

    const changes = getJobChanges(job)
    return changes.reduce(
      (acc, change) => {
        const kind = normalizeCompatibility(change.compatibility)
        if (kind === 'breaking') acc.breaking += 1
        else if (kind === 'potentially-breaking') acc.potentiallyBreaking += 1
        else if (kind === 'non-breaking') acc.nonBreaking += 1
        else acc.unknown += 1
        return acc
      },
      { total: changes.length, breaking: 0, potentiallyBreaking: 0, nonBreaking: 0, unknown: 0 },
    )
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
      <div className="section-title">
        <div>
          <h2>AI Analysis Jobs</h2>
          <p>Execution lifecycle for impact-analysis work. Compatibility and gate decisions remain deterministic and separate from the AI job state.</p>
        </div>
        <span className="status-pill">{jobs.length} Analysis Runs</span>
      </div>

      <div className="job-create-bar">
        <label>
          <span>Select Comparison Run</span>
          <select value={comparisonId} onChange={(e) => setComparisonId(e.target.value)}>
            <option value="">-- Choose Comparison ID --</option>
            {comparisons.map((comparison) => {
              const counts = getComparisonCounts(comparison)
              return (
                <option value={comparison.id} key={comparison.id}>
                  Comparison #{comparison.id} ({counts.total} changes)
                </option>
              )
            })}
          </select>
        </label>

        <button type="button" className="primary" onClick={() => onCreateJob(comparisonId)} disabled={!comparisonId}>
          <IconSparkles /> Dispatch Analysis Job
        </button>
      </div>

      {!jobs.length && (
        <div className="state-placeholder">
          <IconCpuLarge />
          <p>No analysis jobs yet. Select a comparison above to dispatch an AI impact-analysis job.</p>
        </div>
      )}

      {jobs.length > 0 && (
        <div className="table-list">
          {jobs.map((job) => {
            const comparison = getJobComparison(job)
            const changes = getJobChanges(job)
            const counts = getCounts(job)
            const gate = comparison ? getGateStatus(comparison) : 'UNASSESSED'
            const isExpanded = expandedJob === job.id
            const progress = job.progress !== undefined && job.progress !== null
              ? Number(job.progress)
              : job.status === 'completed'
                ? 100
                : 0

            return (
              <div className="job-card" key={job.id}>
                <div className="history-row job-row">
                  <div className="history-id">
                    <strong>Job #{job.id}</strong>
                    <small>Comparison #{job.comparison || '—'}</small>
                  </div>

                  <div className="job-track-wrap">
                    <div className="job-progress-track">
                      <div className="job-progress-fill" style={{ width: `${Math.min(Math.max(progress, 0), 100)}%` }} />
                    </div>
                    <small>{Math.round(progress)}% execution progress</small>
                  </div>

                  <div className="job-state-stack">
                    <span className={`badge ${getStatusClass(job.status)}`}>{job.status || 'unknown'}</span>
                    {comparison && <span className={`badge ${gateBadgeClass(gate)}`}>Gate: {gate}</span>}
                  </div>

                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setExpandedJob(isExpanded ? null : job.id)}
                  >
                    {isExpanded ? 'Hide Details' : 'View Analysis'}
                  </button>
                </div>

                <div className="job-summary-panel">
                  <div className="job-meta-grid">
                    <div className="job-meta-item"><small>Project</small><strong>{job.project || comparison?.project || '—'}</strong></div>
                    <div className="job-meta-item"><small>Total Changes</small><strong>{counts.total}</strong></div>
                    <div className="job-meta-item"><small>Breaking</small><strong>{counts.breaking}</strong></div>
                    <div className="job-meta-item"><small>Potential Risk</small><strong>{counts.potentiallyBreaking}</strong></div>
                    <div className="job-meta-item"><small>Compatible</small><strong>{counts.nonBreaking}</strong></div>
                    <div className="job-meta-item"><small>Created</small><strong>{formatDate(job.created_at)}</strong></div>
                    <div className="job-meta-item"><small>Stage</small><strong>{job.stage || '—'}</strong></div>
                    <div className="job-meta-item"><small>Error</small><strong>{job.error_code || '—'}</strong></div>
                  </div>
                </div>

                {isExpanded && (
                  <div className="job-details-panel">
                    {!changes.length ? (
                      <div className="state-placeholder"><p>No change records are available for this comparison.</p></div>
                    ) : (
                      <div className="job-change-list">
                        {changes.map((change, index) => {
                          const kind = normalizeCompatibility(change.compatibility)
                          return (
                            <div className="job-change-item" key={change.id || change.stable_hash || index}>
                              <div>
                                <strong>{change.endpoint || '/'}</strong>
                                <small>{change.change_type || 'Contract Diff'}</small>
                              </div>
                              <div className="job-change-signals">
                                <span className={`badge ${compatibilityBadgeClass(kind)}`}>{compatibilityLabel(kind)}</span>
                                {change.rule_id && <small>Rule: {change.rule_id}</small>}
                                {change.direction && change.direction !== 'unknown' && <small>Direction: {change.direction}</small>}
                              </div>
                            </div>
                          )
                        })}
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
