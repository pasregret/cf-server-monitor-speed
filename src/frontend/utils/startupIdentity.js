import { getApiBases } from './config'
import { STORAGE } from './constants'

export function getStartupIdentity(includeChallenge = true) {
  if (typeof window === 'undefined') return null
  const keys = [STORAGE.JWT_TOKEN, ...(includeChallenge ? [STORAGE.TURNSTILE_TOKEN, STORAGE.TURNSTILE_VERIFIED] : [])]
  return JSON.stringify([window.location.pathname, window.location.hash.replace(/^#/, '') || '/',
    getApiBases(), ...keys.map(key => localStorage.getItem(key))])
}
