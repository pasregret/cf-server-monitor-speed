import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

test('version checks share in-flight work and ignore older site responses', async () => {
  const vite = await createServer({ configFile: false, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  const saved = { window: globalThis.window, localStorage: globalThis.localStorage, fetch: globalThis.fetch }
  let redirects = 0
  globalThis.window = { location: { origin: 'https://a.example', protocol: 'https:', host: 'a.example', assign() { redirects++ } }, __APP_API_BASES__: ['https://a.example', 'https://b.example'] }
  globalThis.localStorage = { getItem: () => '', removeItem() {} }
  const pending = []
  globalThis.fetch = url => new Promise(resolve => pending.push({ url: String(url), resolve }))
  try {
    const api = await vite.ssrLoadModule('/src/frontend/utils/api.js')
    const first = api.fetchRemoteVersion(0)
    assert.equal(api.fetchRemoteVersion(0), first)
    assert.equal(pending.length, 1)
    const second = api.fetchRemoteVersion(1)
    assert.equal(pending.length, 2)
    assert.equal(pending[0].url, 'https://a.example/api/version')
    assert.equal(pending[1].url, 'https://b.example/api/version')

    pending[1].resolve(Response.json({ version: '2.0', last_workers_version: '2.1', last_agent_version: 'v2.1' }))
    await second
    pending[0].resolve(Response.json({ version: '1.0', last_workers_version: '1.1', last_agent_version: 'v1.1' }))
    await first
    assert.equal(api.VERSION.value, '2.0')
    assert.equal(api.LAST_WORKERS_VERSION.value, '2.1')
    assert.equal(api.LAST_AGENT_VERSION.value, 'v2.1')

    const denied = api.fetchRemoteVersion(1)
    pending[2].resolve(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    assert.equal(await denied, null)
    assert.equal(redirects, 0, 'optional metadata must not redirect the active page')
    assert.equal(api.VERSION.value, '2.0')
    assert.equal(api.LAST_WORKERS_VERSION.value, '2.1')
  } finally {
    for (const item of pending) item.resolve(Response.json({}))
    globalThis.window = saved.window
    globalThis.localStorage = saved.localStorage
    globalThis.fetch = saved.fetch
    await vite.close()
  }
})
