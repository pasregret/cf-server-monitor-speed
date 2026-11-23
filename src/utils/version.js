import { PROJECT_REPOSITORY } from './project.js';

const PANEL_RELEASE_URL = `https://api.github.com/repos/${PROJECT_REPOSITORY}/releases/latest`;
const AGENT_RELEASE_URL = 'https://api.github.com/repos/huilang-me/cfsm-agent/releases/latest';
const GITHUB_HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': PROJECT_REPOSITORY };
const REMOTE_VERSION_TTL = 10 * 60 * 1000;
const REMOTE_VERSION_FAILURE_TTL = 30 * 1000;
const REMOTE_VERSION_FETCH_TIMEOUT_MS = 2000;

let cachedRemoteVersion = null;
let cachedRemoteVersionAt = 0;
let cachedRemoteVersionFailureAt = 0;
let remoteVersionPromise = null;

// Reading the last known versions must never start a network request.
export function getCachedRemoteVersion() {
  return cachedRemoteVersion;
}

export async function getRemoteVersion() {
  const now = Date.now();
  if (cachedRemoteVersion && now - cachedRemoteVersionAt < REMOTE_VERSION_TTL) {
    return cachedRemoteVersion;
  }
  if (cachedRemoteVersionFailureAt && now - cachedRemoteVersionFailureAt < REMOTE_VERSION_FAILURE_TTL) {
    return cachedRemoteVersion;
  }
  if (remoteVersionPromise) {
    return remoteVersionPromise;
  }

  remoteVersionPromise = fetchRemoteVersion(now).finally(() => {
    remoteVersionPromise = null;
  });

  return remoteVersionPromise;
}

async function fetchRemoteVersion(now) {
  try {
    const [versionRes, releaseRes] = await Promise.allSettled([
      fetchWithTimeout(PANEL_RELEASE_URL, { headers: GITHUB_HEADERS }),
      fetchWithTimeout(AGENT_RELEASE_URL, { headers: GITHUB_HEADERS })
    ]);

    let workers;
    let agent;

    if (versionRes.status === 'fulfilled' && versionRes.value.ok) {
      const release = await versionRes.value.json();
      if (typeof release?.tag_name === 'string') {
        workers = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name)?.[1];
      }
    }

    if (releaseRes.status === 'fulfilled' && releaseRes.value.ok) {
      const release = await releaseRes.value.json();
      const tag = typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
      if (tag) {
        agent = tag;
      }
    }

    if (workers === undefined && agent === undefined) {
      cachedRemoteVersionFailureAt = Date.now();
      return cachedRemoteVersion;
    }

    cachedRemoteVersion = {
      workers: workers !== undefined ? workers : (cachedRemoteVersion?.workers || ''),
      agent: agent !== undefined ? agent : (cachedRemoteVersion?.agent || '')
    };
    cachedRemoteVersionAt = now;
    cachedRemoteVersionFailureAt = 0;
    return cachedRemoteVersion;
  } catch (_) {
    cachedRemoteVersionFailureAt = Date.now();
    return cachedRemoteVersion;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REMOTE_VERSION_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
