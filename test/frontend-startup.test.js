import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

test('speculative startup reads preserve sessions and only reuse successful single-site results', async () => {
  const vite = await createServer({ configFile: false, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  const saved = { window: globalThis.window, localStorage: globalThis.localStorage, fetch: globalThis.fetch }
  const store = new Map([['jwt_token', 'test-session'], ['turnstile_token', 'challenge'], ['turnstile_verified', 'verified']])
  let redirects = 0
  let calls = 0
  let status = 200
  let sentHeaders
  const payload = { servers: [{ id: 'test-1', name: 'Synthetic server' }], latestReportUpdates: [], sysConfig: {}, stats: {}, regionStats: {} }
  globalThis.window = { location: { origin: 'https://a.example', protocol: 'https:', host: 'a.example', assign() { redirects++ }, reload() { redirects++ } }, __APP_API_BASES__: ['https://a.example'] }
  globalThis.localStorage = { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) }
  globalThis.fetch = async (_url, options) => { calls++; sentHeaders = options.headers; return Response.json(status === 200 ? payload : { error: 'denied' }, { status }) }
  try {
    const { http } = await vite.ssrLoadModule('/src/frontend/utils/http.js')
    const api = await vite.ssrLoadModule('/src/frontend/utils/api.js')
    const before = [...store]
    for (const denied of [401, 403]) {
      status = denied
      const result = await http.get('/api/servers', { autoRedirect: false, updateSession: false, includeTurnstileToken: false })
      assert.equal(result.status, denied)
      assert.equal(sentHeaders['X-Turnstile-Token'], undefined, 'speculation cannot consume a one-time challenge token')
      assert.equal(sentHeaders['X-Turnstile-Verified'], 'verified', 'existing verified sessions still accelerate startup')
      assert.deepEqual([...store], before, 'a speculative response must not race config or challenge state')
      assert.equal(redirects, 0)
    }
    status = 200
    calls = 0
    const reused = await api.fetchServersAll({ status: 200, data: payload })
    assert.equal(reused.servers[0].id, 'test-1')
    assert.equal(calls, 0, 'successful startup data is consumed without a second request')
    const timedOut = await api.fetchServersAll({ status: 0, timeout: true, error: 'timeout' })
    assert.equal(timedOut.servers.length, 0)
    assert.equal(calls, 0, 'a timeout cannot start another full startup wait')
    await api.fetchServersAll({ status: 403, error: 'denied' })
    assert.equal(calls, 1, 'failed speculation retries through the ordinary authenticated request')
    await api.fetchServersAll({ status: 200, data: {} })
    assert.equal(calls, 2, 'malformed startup data is not treated as an empty inventory')
    globalThis.window.__APP_API_BASES__ = ['https://a.example', 'https://b.example']
    await api.fetchServersAll({ status: 200, data: payload })
    assert.equal(calls, 4, 'a single-site result cannot replace multi-site retrieval')
    status = 401
    await http.get('/api/servers', { autoRedirect: false })
    assert.equal(store.has('jwt_token'), false, 'ordinary authorization failure keeps existing logout semantics')
  } finally {
    Object.assign(globalThis, saved)
    await vite.close()
  }
})

test('early realtime messages stay private until one authenticated adoption and are discarded on close', async () => {
  const vite = await createServer({ configFile: false, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  try {
    const { createStartupLiveSocket } = await vite.ssrLoadModule('/src/frontend/utils/startupLive.js')
    let callbacks, closed = 0
    const socket = { close() { closed++ } }
    const early = createStartupLiveSocket((_scope, handlers) => { callbacks = handlers; return socket })
    const received = []
    callbacks.onMessage({type:'snapshot',updates:[{serverId:'synthetic'}]})
    assert.deepEqual(received, [])
    const adopted = early.take({ onMessage: message => received.push(message) })
    assert.equal(adopted, socket); assert.equal(received.length, 1)
    assert.equal(early.take({}), null)
    callbacks.onMessage({type:'batchUpdate',updates:[]}); assert.equal(received.length,2)
    early.close(); callbacks.onMessage({type:'snapshot'}); assert.equal(received.length,2); assert.equal(closed,1)
    const denied = createStartupLiveSocket((_scope, handlers) => { callbacks = handlers; return socket })
    callbacks.onMessage({type:'snapshot'}); denied.close(); assert.equal(denied.take({onMessage:message=>received.push(message)}),null)
    assert.equal(received.length,2)
  } finally { await vite.close() }
})

test('unclaimed early sockets expire and configured lifetimes apply to the adopted socket', async () => {
  const vite = await createServer({ configFile:false,appType:'custom',logLevel:'silent',server:{middlewareMode:true} })
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout
  let early, adopted
  try {
    const { createStartupLiveSocket } = await vite.ssrLoadModule('/src/frontend/utils/startupLive.js')
    const timers=[]; globalThis.setTimeout=(callback,delay)=>{const t={callback,delay};timers.push(t);return t};globalThis.clearTimeout=t=>{if(t)t.cleared=true}
    let closes=0, creates=0, handlers; const limits=[]
    const socket={close(){closes++},setTimeoutMinutes(value){limits.push(value)}}
    const make=(_scope,h)=>{creates++;handlers=h;return socket}
    early=createStartupLiveSocket(make);assert.equal(timers[0].delay,15000)
    timers[0].callback();assert.equal(closes,1);assert.equal(early.take({}),null)
    adopted=createStartupLiveSocket(make);let timeouts=0
    assert.equal(adopted.take({timeoutMinutes:1,onTimeout(){timeouts++}}),socket)
    assert.deepEqual(limits,[1]);assert.equal(timers[1].cleared,true);assert.equal(creates,2)
    handlers.onTimeout({durationMs:60000});assert.equal(timeouts,1)
    assert.equal(adopted.take({}),null)
  } finally {early?.close();adopted?.close();globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;await vite.close()}
})

test('identity guard survives main startup until the dashboard actually adopts the connection', async () => {
  const vite=await createServer({configFile:false,appType:'custom',logLevel:'silent',server:{middlewareMode:true}})
  const saved={window:globalThis.window,localStorage:globalThis.localStorage}
  const store=new Map([['jwt_token','initial-session']]),listeners=new Map()
  globalThis.window={location:{pathname:'/',hash:'',origin:'https://example.com'},__APP_API_BASES__:['https://example.com'],addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)}
  globalThis.localStorage={getItem:key=>store.get(key)||null}
  let early
  try{
    const {createStartupLiveSocket}=await vite.ssrLoadModule('/src/frontend/utils/startupLive.js')
    let closes=0
    early=createStartupLiveSocket(()=>({close(){closes++}}))
    assert.equal(listeners.size,3)
    // Main has the controller, but awaits config/challenge; no Dashboard take yet.
    store.set('turnstile_verified','renewed-challenge');listeners.get('storage')()
    assert.equal(closes,0,'challenge renewal keeps the same authenticated connection')
    store.set('jwt_token','different-session');listeners.get('storage')()
    assert.equal(closes,1);assert.equal(early.isCurrent,false);assert.equal(early.take({}),null)
    assert.equal(listeners.size,0)
  }finally{early?.close();Object.assign(globalThis,saved);await vite.close()}
})
