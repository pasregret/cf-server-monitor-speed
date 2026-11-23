import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { CURRENT_VERSION } from '../src/utils/config.js';
import { generateToken } from '../src/middleware/auth.js';
import { clearSiteSettingsCache, clearAppearanceSettingsCache, SITE_FIELDS, APPEARANCE_FIELDS } from '../src/utils/settings.js';

// A stalled optional upstream must not hold up authenticated startup config.
test('startup config stays responsive while the authenticated version request is pending', async () => {
  const site = { ...Object.fromEntries(SITE_FIELDS.map(k => [k, ''])),
    jwt_secret: 'x'.repeat(32), is_public: 'false', servers_optimized: 'true',
    turnstile_enabled: 'false', app_password: 'test-app-access-password' };
  const appearance = Object.fromEntries(APPEARANCE_FIELDS.map(k => [k, '']));
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (sql.includes('sqlite_master')) return { name: 'existing' };
          if (sql.includes("key = 'site_options'")) return { value: JSON.stringify(site) };
          if (sql.includes("key = 'appearance_options'")) return { value: JSON.stringify(appearance) };
          return null;
        },
        async all() { return { results: [] }; },
        async run() { return { success: true }; }
      };
    }
  };
  const env = { API_SECRET: 'test-only-secret', DB: db };
  const token = await generateToken(env, site);
  const request = path => new Request(`https://example.com${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const originalFetch = globalThis.fetch;
  const pending = [];
  globalThis.fetch = (url) => new Promise(resolve => pending.push({ url: String(url), resolve }));
  clearSiteSettingsCache();
  clearAppearanceSettingsCache();
  let versionRequest;
  try {
    const initial = await worker.fetch(request('/api/config'), env, {});
    assert.equal(initial.status, 200);
    assert.equal((await initial.json()).last_workers_version, null);
    assert.equal(pending.length, 0, 'config must not initiate any GitHub requests');

    for (const headers of [{}, { 'X-App-Password': site.app_password }]) {
      const denied = await worker.fetch(new Request('https://example.com/api/version', { headers }), env, {});
      assert.equal(denied.status, 401, 'read-only App access is not administrator access');
    }
    assert.equal(pending.length, 0);

    versionRequest = worker.fetch(request('/api/version'), env, {});
    for (let i = 0; pending.length < 2 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(pending.length, 2);
    let watchdog;
    const configResponse = await Promise.race([
      worker.fetch(request('/api/config'), env, {}),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('config waited for GitHub')), 500); })
    ]).finally(() => clearTimeout(watchdog));
    const config = await configResponse.json();
    assert.equal(configResponse.status, 200);
    assert.equal(config.authorization, true);
    assert.equal(config.is_public, false);
    assert.equal(config.last_workers_version, null);

    assert.deepEqual(pending.map(item => item.url), [
      'https://api.github.com/repos/leon4z/cf-server-monitor-speed/releases/latest',
      'https://api.github.com/repos/huilang-me/cfsm-agent/releases/latest'
    ]);
    pending[0].resolve(Response.json({ tag_name: 'v9.0.0' }));
    pending[1].resolve(Response.json({ tag_name: 'v1.1.3' }));
    const versionResponse = await versionRequest;
    assert.equal(versionResponse.status, 200);
    assert.equal(versionResponse.headers.get('Cache-Control'), 'private, no-store');
    assert.deepEqual(await versionResponse.json(), { version: CURRENT_VERSION, last_workers_version: '9.0.0', last_agent_version: 'v1.1.3' });
    const cached = await worker.fetch(request('/api/config'), env, {});
    assert.equal((await cached.json()).last_workers_version, '9.0.0');
    await worker.fetch(request('/api/version'), env, {});
    assert.equal(pending.length, 2, 'the existing ten-minute GitHub cache is reused');
    site.turnstile_enabled = 'true';
    clearSiteSettingsCache();
    const challenge = await worker.fetch(request('/api/version'), env, {});
    assert.equal(challenge.status, 403, 'the new endpoint must not bypass global Turnstile');
    assert.equal(pending.length, 2);
  } finally {
    for (const item of pending) item.resolve(Response.json({}));
    await versionRequest;
    globalThis.fetch = originalFetch;
    clearSiteSettingsCache();
    clearAppearanceSettingsCache();
  }
});
