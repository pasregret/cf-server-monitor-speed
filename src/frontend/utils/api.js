import { http, DEFAULT_REQUEST_TIMEOUT_MS } from './http'
import { getApiBases, hasMultipleApiBases, getTitle } from './config'
import { DEFAULT_SITE_TITLE, LATENCY_WINDOW, STORAGE } from './constants'
import { ref } from 'vue'
import { normalizeTimestamp } from './time.js'
import { TIME } from './constants'
import { resolveDisplayMode } from './displayMode.js'

export const VERSION = ref('')
export const LAST_WORKERS_VERSION = ref('')
export const LAST_AGENT_VERSION = ref('')

export { createLiveSocket, normalizeLiveSocketTimeoutMinutes } from './liveSocket.js'

export const getFlagRegionCode = (region) => {
  const code = (region || '').toUpperCase()
  if (code === 'TW') return 'cn'
  return code.toLowerCase()
}

export const formatBytes = (bytes) => {
  bytes = parseFloat(bytes) || 0
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const safeIndex = Math.max(0, Math.min(i, sizes.length - 1))
  return parseFloat((bytes / Math.pow(k, safeIndex)).toFixed(1)) + ' ' + sizes[safeIndex]
}

export const isServerOnline = (server, now = Date.now()) => {
  const lastUpdated = normalizeTimestamp(server?.report_timestamp ?? server?.last_updated)
  return lastUpdated && (now - lastUpdated) < TIME.ONLINE_THRESHOLD_MS
}

export const fetchServersAll = async (initialResult = null) => {
  const multiSite = hasMultipleApiBases()
  const reusable = !multiSite && (initialResult?.timeout === true ||
    (initialResult?.status === 200 && !initialResult.error && Array.isArray(initialResult.data?.servers)))
  // A timed-out prefetch has already spent the startup budget. Auth/challenge
  // failures may retry after config settles, but never wait on an unbounded read.
  const path = multiSite ? '/api/servers' : '/api/servers?realtime=deferred'
  const results = reusable ? [initialResult] : await http.getAll(path, { timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS })
  const localTitle = getTitle() || DEFAULT_SITE_TITLE

  const mergedData = createEmptyMergedData()
  mergedData.sysConfig.site_title = multiSite ? localTitle : DEFAULT_SITE_TITLE

  for (const result of results) {
    mergeSiteResult(mergedData, result, multiSite, localTitle)
  }

  return mergedData
}

const createEmptyMergedData = () => ({
  servers: [],
  latestReportUpdates: [],
  stats: { total: 0, online: 0, offline: 0, globalNetRx: 0, globalNetTx: 0, globalSpeedIn: 0, globalSpeedOut: 0 },
  regionStats: {},
  sysConfig: {
    show_price: true,
    show_expire: true,
    show_tf: true,
    show_three_net_details: true,
    display_mode: 'bar',
    site_title: DEFAULT_SITE_TITLE,
    latency_window: {
      points: LATENCY_WINDOW.POINTS,
      hours: LATENCY_WINDOW.HOURS
    }
  }
})

const mergeSiteResult = (mergedData, { data, error, baseUrl }, multiSite, localTitle) => {
  if (error || !data) return

  const rawServers = Array.isArray(data.servers)
    ? data.servers
    : Object.entries(data.latestMetricsMap || {}).map(([id, metrics]) => ({ id, ...metrics }))

  for (const server of rawServers) {
    mergedData.servers.push({ ...server, source: baseUrl })
  }

  const latestReportUpdates = Array.isArray(data.latestReportUpdates) ? data.latestReportUpdates : []
  for (const update of latestReportUpdates) {
    if (!update || !update.serverId || !Array.isArray(update.samples)) continue
    mergedData.latestReportUpdates.push({ ...update, source: baseUrl })
  }

  if (data.stats) {
    mergedData.stats.total += data.stats.total || 0
    mergedData.stats.online += data.stats.online || 0
    mergedData.stats.offline += data.stats.offline || 0
    mergedData.stats.globalNetRx += data.stats.globalNetRx || 0
    mergedData.stats.globalNetTx += data.stats.globalNetTx || 0
    mergedData.stats.globalSpeedIn += data.stats.globalSpeedIn || 0
    mergedData.stats.globalSpeedOut += data.stats.globalSpeedOut || 0
  }

  if (data.regionStats) {
    for (const code in data.regionStats) {
      mergedData.regionStats[code] = (mergedData.regionStats[code] || 0) + data.regionStats[code]
    }
  }

  if (data.sysConfig) {
    mergedData.sysConfig = {
      show_price: data.sysConfig.show_price ?? mergedData.sysConfig.show_price,
      show_expire: data.sysConfig.show_expire ?? mergedData.sysConfig.show_expire,
      show_tf: data.sysConfig.show_tf ?? mergedData.sysConfig.show_tf,
      show_three_net_details: data.sysConfig.show_three_net_details ?? mergedData.sysConfig.show_three_net_details,
      display_mode: resolveDisplayMode(data.sysConfig, mergedData.sysConfig.display_mode),
      site_title: multiSite ? localTitle : mergedData.sysConfig.site_title,
      latency_window: data.sysConfig.latency_window ?? mergedData.sysConfig.latency_window
    }
  }
}

export const fetchServersAllWithProgress = async (onResult) => {
  const multiSite = hasMultipleApiBases()
  const localTitle = getTitle() || DEFAULT_SITE_TITLE

  const mergedData = createEmptyMergedData()
  mergedData.sysConfig.site_title = multiSite ? localTitle : DEFAULT_SITE_TITLE

  let corsErrorSites = []

  await http.getAllWithProgress('/api/servers', (result) => {
    mergeSiteResult(mergedData, result, multiSite, localTitle)
    if (result.corsError && !corsErrorSites.includes(result.baseUrl)) corsErrorSites.push(result.baseUrl)
    onResult({ ...mergedData, corsErrorSites })
  }, { timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS })

  return mergedData
}

export const fetchServerDetail = async (id, apiIndex = 0) => {
  const result = await http.getByIndex(`/api/server?id=${id}`, apiIndex)
  if (result.error) return null
  return result.data
}

export const fetchAllHistory = async (id, hours, apiIndex = 0) => {
  const result = await http.getByIndex(`/api/history/all?id=${id}&hours=${hours}`, apiIndex, { autoRedirect: false })
  if (result.error) {
    const error = new Error(result.error)
    error.code = result.code
    error.status = result.status
    error.message = result.message || result.error
    throw error
  }
  return Array.isArray(result.data) ? result.data : []
}

export const adminApi = async (data, apiIndex = 0) => {
  const result = await http.postByIndex('/admin/api', data, apiIndex)
  return result
}

export const login = async (username, password, turnstileToken = '', apiIndex = 0) => {
  if (turnstileToken) {
    localStorage.setItem(STORAGE.TURNSTILE_TOKEN, turnstileToken)
  }
  const result = await http.postByIndex('/admin/api', { action: 'login', username, password }, apiIndex, { autoRedirect: false })
  
  if (!result.error && result.data && result.data.token) {
    localStorage.setItem(STORAGE.JWT_TOKEN, result.data.token)
  }
  return result
}

export const logout = () => {
  localStorage.removeItem(STORAGE.JWT_TOKEN)
}

// Optional update metadata is requested after mounting, never during startup.
const remoteVersionRequests = new Map()
let activeVersionApiIndex = null
export const fetchRemoteVersion = (apiIndex = 0) => {
  if (activeVersionApiIndex !== apiIndex) {
    LAST_WORKERS_VERSION.value = ''
    LAST_AGENT_VERSION.value = ''
  }
  activeVersionApiIndex = apiIndex
  if (remoteVersionRequests.has(apiIndex)) return remoteVersionRequests.get(apiIndex)
  const promise = http.getByIndex('/api/version', apiIndex, {
    includeAuth: true, includeTurnstile: true, autoRedirect: false
  }).then(result => {
    if (result.error || !result.data) return null
    if (activeVersionApiIndex === apiIndex) {
      if (result.data.version) VERSION.value = result.data.version
      LAST_WORKERS_VERSION.value = result.data.last_workers_version || ''
      LAST_AGENT_VERSION.value = result.data.last_agent_version || ''
    }
    return result.data
  }).finally(() => remoteVersionRequests.delete(apiIndex))
  remoteVersionRequests.set(apiIndex, promise)
  return promise
}

export const fetchConfig = async (apiIndex = 0) => {
  const result = await http.getByIndex('/api/config', apiIndex, { includeAuth: true, includeTurnstile: false })
  if (result.error) return null
  if (result.data && result.data.version) {
    VERSION.value = result.data.version
  }
  LAST_WORKERS_VERSION.value = result.data?.last_workers_version || ''
  LAST_AGENT_VERSION.value = result.data?.last_agent_version || ''
  return result.data
}

export const upgradeDatabase = async (apiIndex = 0) => {
  const result = await http.postByIndex('/updateDatabase', {}, apiIndex, { autoRedirect: false })
  if (result.error) {
    if (result.status === 401) {
      return { success: false, error: 'Unauthorized' }
    }
    return { success: false, error: 'Request failed' }
  }
  return result.data
}

export const clearHistory = async (apiIndex = 0) => {
  const result = await http.postByIndex('/clearHistory', {}, apiIndex, { autoRedirect: false })
  if (result.error) {
    if (result.status === 401) {
      return { success: false, error: 'Unauthorized' }
    }
    return { success: false, error: 'Request failed' }
  }
  return result.data
}
