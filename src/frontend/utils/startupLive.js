import { createLiveSocket } from './liveSocket.js'
import { DEFAULT_REQUEST_TIMEOUT_MS } from './http'
import { getStartupIdentity } from './startupIdentity'

// One early connection for an existing session on a single-site homepage.
// No buffered data is delivered until the authenticated application adopts it.
export function createStartupLiveSocket(makeSocket = createLiveSocket) {
  let target = null
  let buffered = []
  let status = null
  let closed = false
  let taken = false
  let adoptionTimer = null
  // Challenge renewal is allowed; identity/route changes must not adopt old data.
  const expectedIdentity = getStartupIdentity(false)
  const isCurrent = () => expectedIdentity === getStartupIdentity(false)
  const discardChanged = () => { if (!isCurrent()) controller.close() }
  const releaseIdentityGuard = () => {
    if (typeof window !== 'undefined') for (const event of ['hashchange', 'popstate', 'storage']) window.removeEventListener?.(event, discardChanged)
  }
  const socket = makeSocket('all', {
    initialSnapshot: true, replay: false,
    onMessage(message) {
      if (closed) return
      if (target) target.onMessage?.(message)
      else { buffered.push(message); if (buffered.length > 64) buffered.shift() }
    },
    onStatus(value) {
      status = value
      if (!closed) target?.onStatus?.(value)
    },
    onTimeout(value) { if (!closed) target?.onTimeout?.(value) }
  }, 0, [])
  const controller = {
    take(handlers) {
      if (!isCurrent()) { controller.close(); return null }
      if (closed || taken) return null
      taken = true
      clearTimeout(adoptionTimer)
      releaseIdentityGuard()
      target = handlers
      socket.setTimeoutMinutes?.(handlers.timeoutMinutes)
      if (status) handlers.onStatus?.(status)
      for (const message of buffered) handlers.onMessage?.(message)
      buffered = []
      return socket
    },
    close() {
      if (closed) return
      closed = true; buffered = []; target = null
      clearTimeout(adoptionTimer)
      releaseIdentityGuard()
      socket.close()
    },
    get isCurrent() { return isCurrent() }
  }
  // A failed/blocked main module must not leave an unclaimed live connection.
  adoptionTimer = setTimeout(() => controller.close(), DEFAULT_REQUEST_TIMEOUT_MS)
  if (typeof window !== 'undefined') for (const event of ['hashchange', 'popstate', 'storage']) window.addEventListener?.(event, discardChanged)
  return controller
}
