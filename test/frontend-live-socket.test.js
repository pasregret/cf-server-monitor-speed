import assert from 'node:assert/strict'
import test from 'node:test'

import { createServer } from 'vite'

class FakeWebSocket {
  static instances = []

  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.sent = []
    this.closeCalls = []
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(handler)
  }

  emit(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) handler(event)
  }

  send(message) {
    this.sent.push(message)
  }

  close(code, reason = '') {
    this.closeCalls.push({ code, reason })
    this.emit('close', { code, reason })
  }
}

test('frontend WebSocket lifetime and explicit close cancel all pending reconnects', async () => {
  const vite = await createServer({
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true }
  })
  const { createLiveSocket, normalizeLiveSocketTimeoutMinutes } = await vite.ssrLoadModule('/src/frontend/utils/api.js')
  const originalWindow = globalThis.window
  const originalLocalStorage = globalThis.localStorage
  const originalWebSocket = globalThis.WebSocket
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const originalDateNow = Date.now

  globalThis.window = {
    location: {
      origin: 'https://example.com',
      protocol: 'https:',
      host: 'example.com'
    }
  }
  globalThis.localStorage = { getItem: () => '' }
  globalThis.WebSocket = FakeWebSocket
  const timers = []
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false }
    timers.push(timer)
    return timer
  }
  globalThis.clearTimeout = timer => {
    if (timer) timer.cleared = true
  }
  FakeWebSocket.instances = []

  let liveSocket = null
  let unlimitedSocket = null
  try {
    const statuses = []
    const timeouts = []
    liveSocket = createLiveSocket('all', {
      timeoutMinutes: 1,
      onStatus: status => statuses.push(status),
      onTimeout: timeout => timeouts.push(timeout)
    }, 0, ['server-1'])

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')
    assert.equal(timers.length, 1)
    assert.equal(timers[0].delay, 60 * 1000)
    timers[0].callback()

    assert.deepEqual(socket.closeCalls, [{
      code: 1000,
      reason: 'connection lifetime exceeded'
    }])
    assert.equal(FakeWebSocket.instances.length, 1)
    assert.equal(liveSocket.isConnected, false)
    assert.deepEqual(timeouts, [{ durationMs: 60 * 1000 }])
    assert.deepEqual(statuses.at(-1), {
      connected: false,
      reason: 'connection lifetime exceeded'
    })

    unlimitedSocket = createLiveSocket('all')
    const unlimitedWebSocket = FakeWebSocket.instances[1]
    unlimitedWebSocket.emit('open')
    assert.equal(timers.length, 1)
    assert.deepEqual(unlimitedWebSocket.closeCalls, [])
    assert.equal(normalizeLiveSocketTimeoutMinutes(0), 0)
    assert.equal(normalizeLiveSocketTimeoutMinutes(20), 20)
    assert.equal(normalizeLiveSocketTimeoutMinutes(-1), 0)
    assert.equal(normalizeLiveSocketTimeoutMinutes(1441), 0)

    // A disconnected early connection must stay closed after access is denied,
    // including when a previously queued reconnect callback races with close.
    unlimitedWebSocket.emit('close')
    const outer = timers.at(-1)
    if (outer.delay === 50) outer.callback() // Reproduce the old nested-timer gap.
    const pending = timers.at(-1)
    unlimitedSocket.close()
    assert.equal(pending.cleared, true)
    pending.callback()
    assert.equal(FakeWebSocket.instances.length, 2)

    // Explicit reconnect creates one connection, with no old socket's close
    // handler scheduling an additional attempt.
    unlimitedSocket.reconnect()
    assert.equal(FakeWebSocket.instances.length, 3)
    const timerCount = timers.length
    unlimitedSocket.reconnect()
    assert.equal(FakeWebSocket.instances.length, 4)
    assert.equal(timers.length, timerCount)

    // Adopt a configured lifetime on this same open connection. The limit
    // starts at its original open time, not when the main application adopts it.
    let now = 100000
    Date.now = () => now
    FakeWebSocket.instances.at(-1).emit('open')
    now += 2000
    unlimitedSocket.setTimeoutMinutes(1)
    assert.equal(FakeWebSocket.instances.length, 4)
    assert.equal(timers.at(-1).delay, 58000)
    const firstPolicy = timers.at(-1)
    unlimitedSocket.setTimeoutMinutes(0)
    assert.equal(firstPolicy.cleared, true)
    now += 1000
    unlimitedSocket.setTimeoutMinutes(1)
    assert.equal(timers.at(-1).delay, 57000)
    timers.at(-1).callback()
    assert.equal(FakeWebSocket.instances.length, 4, 'adoption and expiry never create another connection')
    assert.equal(unlimitedSocket.isConnected, false)
  } finally {
    liveSocket?.close()
    unlimitedSocket?.close()
    globalThis.window = originalWindow
    globalThis.localStorage = originalLocalStorage
    globalThis.WebSocket = originalWebSocket
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    Date.now = originalDateNow
    await vite.close()
  }
})
