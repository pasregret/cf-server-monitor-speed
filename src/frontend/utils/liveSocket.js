import { getApiBases, getWsBase } from './config'
import { FRONTEND_WS_TIMEOUT_MINUTES_MAX, STORAGE, TIME } from './constants'
import { normalizeTimestamp } from './time.js'

export const normalizeLiveSocketTimeoutMinutes = (value) => {
  const minutes = Number(value)
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= FRONTEND_WS_TIMEOUT_MINUTES_MAX
    ? minutes
    : 0
}

export const createLiveSocket = (subscribe, handlers = {}, apiIndex = 0, serverIds = []) => {
  const { onUpdate, onStatus, onMessage, onTimeout } = handlers
  let maxConnectionDurationMs = normalizeLiveSocketTimeoutMinutes(handlers.timeoutMinutes) * 60 * 1000
  const shouldReplay = handlers.replay !== false
  const scope = (subscribe || 'all').toLowerCase()
  let ws = null
  let manualClose = false
  let reconnectTimer = null
  let reconnectDelay = TIME.RECONNECT_INITIAL_DELAY_MS
  let reconnectAttempts = 0
  let connectionLifetimeTimer = null
  let connectionOpenedAt = null
  const MAX_REPLAY_DELAY = 120000
  let isConnected = false
  let subscribedIds = Array.isArray(serverIds) ? serverIds : []
  const replayTimers = new Set()

  const getWsBaseByIndex = (index) => {
    const bases = getApiBases()
    if (bases.length > 0 && bases[index]) {
      try {
        const u = new URL(bases[index])
        const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:'
        return `${wsProto}//${u.host}`
      } catch (_) {
        return `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
      }
    }
    return getWsBase()
  }

  const getJwtToken = () => {
    try {
      return localStorage.getItem(STORAGE.JWT_TOKEN) || ''
    } catch (_) {
      return ''
    }
  }

  const isSameHostWebSocket = (url) => {
    if (typeof window === 'undefined' || !window.location) return false
    return url.host === window.location.host
  }

  const setStatus = (connected, reason) => {
    isConnected = connected
    if (typeof onStatus === 'function') {
      onStatus({ connected, reason: reason || '' })
    }
  }

  const clearReplayTimers = () => {
    replayTimers.forEach(timer => clearTimeout(timer))
    replayTimers.clear()
  }

  const clearConnectionLifetimeTimer = () => {
    if (!connectionLifetimeTimer) return
    clearTimeout(connectionLifetimeTimer)
    connectionLifetimeTimer = null
  }

  const armConnectionLifetime = (socket = ws, now = Date.now()) => {
    clearConnectionLifetimeTimer()
    if (!socket || socket !== ws || manualClose || !isConnected || connectionOpenedAt === null || maxConnectionDurationMs === 0) return
    connectionLifetimeTimer = setTimeout(() => {
      if (socket !== ws) return
      connectionLifetimeTimer = null
      manualClose = true
      clearReplayTimers()
      try { socket.close(1000, 'connection lifetime exceeded') } catch (_) {}
      if (typeof onTimeout === 'function') onTimeout({ durationMs: maxConnectionDurationMs })
    }, Math.max(0, maxConnectionDurationMs - (now - connectionOpenedAt)))
  }

  const normalizeReplayTimestamp = (value, fallback = Date.now()) => {
    return normalizeTimestamp(value, fallback)
  }

  const emitUpdate = ({ serverId, data, ts }) => {
    if (serverId && data && typeof onUpdate === 'function') {
      const receiveTs = Date.now()
      const sampleTs = normalizeReplayTimestamp(data.sample_timestamp || data.last_updated || data.timestamp || ts, receiveTs)
      onUpdate({
        serverId,
        data: {
          ...data,
          sample_timestamp: sampleTs,
          last_updated: receiveTs,
          timestamp: receiveTs
        }
      })
    }
  }

  const collectBatchEventGroups = (msg) => {
    const groups = []
    const updates = Array.isArray(msg.updates) ? msg.updates : []

    for (const update of updates) {
      if (!update || !update.serverId) continue
      const events = []
      const samples = Array.isArray(update.samples) ? update.samples : []

      for (const sample of samples) {
        if (!sample || typeof sample !== 'object') continue
        const data = sample.data || sample.payload || sample.metrics
        if (!data) continue
        events.push({
          serverId: update.serverId,
          ts: normalizeReplayTimestamp(sample.ts || sample.timestamp || data.last_updated || msg.ts),
          data
        })
      }

      events.sort((a, b) => a.ts - b.ts)
      if (events.length > 0) groups.push(events)
    }

    return groups
  }

  const replayBatch = (msg) => {
    const groups = collectBatchEventGroups(msg)
    if (groups.length === 0) return

    for (const events of groups) {
      const firstTs = events[0].ts
      for (const event of events) {
        const delay = Math.max(0, Math.min(event.ts - firstTs, MAX_REPLAY_DELAY))
        const timer = setTimeout(() => {
          replayTimers.delete(timer)
          emitUpdate(event)
        }, delay)
        replayTimers.add(timer)
      }
    }
  }

  const connect = () => {
    if (manualClose) return
    let socket = null
    try {
      const url = new URL(`${getWsBaseByIndex(apiIndex)}/api/ws`)
      url.searchParams.set('subscribe', scope)
      if (handlers.initialSnapshot === true) url.searchParams.set('snapshot', '1')
      const token = getJwtToken()
      if (token && !isSameHostWebSocket(url)) {
        url.searchParams.set('token', token)
      }
      socket = new WebSocket(url.toString())
      ws = socket
    } catch (e) {
      setStatus(false, 'WebSocket not supported')
      return
    }

    socket.addEventListener('open', () => {
      if (socket !== ws || manualClose) {
        try { socket.close() } catch (_) {}
        return
      }
      reconnectDelay = TIME.RECONNECT_INITIAL_DELAY_MS
      reconnectAttempts = 0
      try {
        socket.send(JSON.stringify({
          type: 'subscribe',
          scope,
          ids: subscribedIds
        }))
      } catch (_) {}
      setStatus(true, 'connected')
      connectionOpenedAt = Date.now()
      armConnectionLifetime(socket, connectionOpenedAt)
    })

    socket.addEventListener('message', (event) => {
      if (socket !== ws) return
      let msg = null
      try {
        msg = typeof event.data === 'string' ? JSON.parse(event.data) : null
      } catch (_) { return }
      if (!msg) return

      if (shouldReplay && msg.type === 'batchUpdate') {
        replayBatch(msg)
      }
      if (typeof onMessage === 'function') onMessage(msg)
    })

    socket.addEventListener('close', (event) => {
      if (socket !== ws) return
      ws = null
      connectionOpenedAt = null
      clearConnectionLifetimeTimer()
      setStatus(false, event.reason || 'disconnected')
      scheduleReconnect()
    })

    socket.addEventListener('error', () => {
      if (socket !== ws) return
      setStatus(false, 'error')
      try { socket.close() } catch (_) {}
    })
  }

  const scheduleReconnect = () => {
    if (manualClose) return
    if (reconnectTimer) return
    if (reconnectAttempts >= TIME.MAX_RECONNECT_ATTEMPTS) {
      setStatus(false, 'max reconnect attempts reached')
      return
    }

    const delay = reconnectDelay
    reconnectAttempts++
    reconnectDelay = Math.min(reconnectDelay * 2, TIME.RECONNECT_MAX_DELAY_MS)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (!manualClose) connect()
    }, 50 + delay)
  }

  connect()

  return {
    setTimeoutMinutes(value) {
      maxConnectionDurationMs = normalizeLiveSocketTimeoutMinutes(value) * 60 * 1000
      armConnectionLifetime()
    },
    setServerIds(ids) {
      subscribedIds = Array.isArray(ids) ? ids : []
      if (ws?.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'subscribe', scope, ids: subscribedIds })) } catch (_) {}
      }
    },
    close() {
      manualClose = true
      reconnectAttempts = TIME.MAX_RECONNECT_ATTEMPTS
      clearReplayTimers()
      clearConnectionLifetimeTimer()
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      if (ws) { try { ws.close() } catch (_) {} ws = null }
      setStatus(false, 'disconnected')
    },
    reconnect() {
      manualClose = false
      reconnectAttempts = 0
      clearReplayTimers()
      clearConnectionLifetimeTimer()
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      const previous = ws
      ws = null
      if (previous) { try { previous.close() } catch (_) {} }
      setStatus(false, 'reconnecting')
      connect()
    },
    get isConnected() {
      return isConnected
    }
  }
}

