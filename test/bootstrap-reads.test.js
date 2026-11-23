import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'
import worker from '../src/index.js'
import { generateToken } from '../src/middleware/auth.js'
import { loadSettings, clearSiteSettingsCache, clearAppearanceSettingsCache } from '../src/utils/settings.js'

test('inline reads reuse HTTP semantics, exclude one-time challenges and discard changed identities', async () => {
  const vite = await createServer({ configFile: false, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  const saved = { window: globalThis.window, localStorage: globalThis.localStorage, fetch: globalThis.fetch }
  const store = new Map([['jwt_token', 'synthetic-session'], ['turnstile_verified', 'verified']])
  const calls = []; let status = 200
  globalThis.window = { location: { origin: 'https://a.example', protocol: 'https:', host: 'a.example', pathname: '/', hash: '' }, __APP_API_BASES__: ['https://a.example'] }
  globalThis.localStorage = { getItem: key => store.get(key) || null, setItem: (key,value) => store.set(key,value), removeItem: key => store.delete(key) }
  globalThis.fetch = async (url, options) => { calls.push({url,options}); return Response.json({ authorization: true }, {status}) }
  try {
    const { startStartupReads, takeStartupReads } = await vite.ssrLoadModule('/src/frontend/utils/startupReads.js')
    const { applySessionResult } = await vite.ssrLoadModule('/src/frontend/utils/http.js')
    const liveControllers=[]
    const start=()=>startStartupReads([],()=>{const live={closed:0,close(){this.closed++}};liveControllers.push(live);return live})
    start(); start()
    assert.equal(calls.length, 2, 'one config and one inventory request, before app startup')
    window.location.hash='#/' // The hash router normalizes an initially empty hash.
    const early = takeStartupReads(); assert.ok(early); assert.equal(takeStartupReads(),null)
    assert.equal((await early.config).status,200); await early.servers
    assert.ok(calls.every(c => c.options.headers.Authorization==='Bearer synthetic-session' && !c.options.headers['X-Turnstile-Token']))
    for (const denied of [401,403]) {
      status=denied; const original=[...store]; start(); const result=await takeStartupReads().config
      assert.deepEqual([...store],original,'early failures cannot clear a session or verified challenge')
      if (denied===401) { applySessionResult(result); assert.equal(store.has('jwt_token'),false); store.set('jwt_token','synthetic-session') }
    }
    status=200; store.set('turnstile_token','once'); const before=calls.length
    start(); const fresh=takeStartupReads(); assert.equal(fresh.config,null); await fresh.servers
    assert.equal(calls.length,before+1); assert.equal(store.get('turnstile_token'),'once')
    start(); store.set('jwt_token','changed-session'); assert.equal(takeStartupReads(),null); assert.equal(liveControllers.at(-1).closed,1)
    store.delete('turnstile_token'); store.delete('jwt_token'); start(); const anonymous=takeStartupReads()
    assert.ok(anonymous.config); assert.equal(anonymous.servers,null); await anonymous.config
    window.location.pathname='/admin'; const count=calls.length; start(); assert.equal(calls.length,count)
    window.location.pathname='/'; window.__APP_API_BASES__=['https://a.example','https://b.example']; start(); assert.equal(calls.length,count)
  } finally { Object.assign(globalThis,saved); await vite.close() }
})

test('cold config reads site/appearance in parallel and shares one legacy read without persistence', async () => {
  const site = { jwt_secret:'x'.repeat(32), is_public:'false', servers_optimized:'true', turnstile_enabled:'false' }
  let allReads=0, writes=0, releaseSite, blockReads=false
  const started=[]
  const gate=new Promise(resolve => { releaseSite=resolve })
  const db={ prepare(sql) { return {
    bind() {return this},
    async first() {
      if (sql.includes('sqlite_master')) return {name:'existing'}
      if (sql.includes("key = 'site_options'")) {started.push('site'); if(blockReads) await gate; return {value:JSON.stringify(site)}}
      if (sql.includes("key = 'appearance_options'")) {started.push('appearance'); return null}
      return null
    },
    async all() {
      if(sql.includes('PRAGMA')) return {results:[{name:'history_partition_id'},{name:'timestamp'}]}
      allReads++; if(blockReads) await gate; return {results:[{key:'site_title',value:'Synthetic title'}]}
    },
    async run() {writes++;return {success:true}}
  } } }
  clearSiteSettingsCache(); clearAppearanceSettingsCache()
  const env={DB:db,API_SECRET:'synthetic-api-secret'}; const token=await generateToken(env,site)
  await worker.fetch(new Request('https://example.com/api/config',{headers:{Authorization:'Bearer '+token}}),env,{})
  clearSiteSettingsCache();clearAppearanceSettingsCache(); allReads=0;writes=0;started.length=0;blockReads=true
  const pending=worker.fetch(new Request('https://example.com/api/config',{headers:{Authorization:'Bearer '+token}}),env,{})
  try {
    for(let i=0; i<100 && !started.includes('appearance'); i++) await new Promise(resolve=>setTimeout(resolve,1))
    assert.ok(started.includes('site') && started.includes('appearance'),'appearance must start while site read is unresolved')
    releaseSite(); const response=await pending; const data=await response.json()
    assert.equal(response.status,200); assert.equal(data.authorization,true); assert.equal(data.site_title,'Synthetic title')
    assert.equal(allReads,1,'missing modern fields share the same request-local legacy rows')
    assert.equal(writes,0,'no migration, defaults backfill or secret rotation')
    clearSiteSettingsCache(); clearAppearanceSettingsCache(); const next=await loadSettings(db)
    assert.equal(next.site_title,'Synthetic title'); assert.equal(allReads,2,'later reads do not retain a new legacy cache')
  } finally {releaseSite(); await pending; clearSiteSettingsCache();clearAppearanceSettingsCache()}
})
