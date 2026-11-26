// The browser host: values in localStorage under `prefix` (sealed ones through the vault), one
// signing tab by a Web Lock, and the page's own events for coming and going.

import type { Held, Host, Keeper, Presence, Store } from './host.ts'
import { isSealed, openWith, sealWith, vaultKey } from './vault.ts'

export type BrowserHostOptions = {
  /** Put before every name in localStorage, as `cells:fiber:` gives `cells:fiber:state`. */
  prefix: string
  /** IndexedDB database of the vault's key (and the keeper's). */
  db?: string
  keeper?: Keeper
}

export function browserHost(options: BrowserHostOptions): Host {
  const { prefix } = options
  const db = options.db ?? 'cells-fiber'
  const at = (name: string) => prefix + name

  const store: Store = {
    async get(name, opts) {
      const stored = localStorage.getItem(at(name))
      if (stored === null) return undefined
      if (!opts?.sealed) return stored
      const key = await vaultKey(db)
      const plain = await openWith(key, stored)
      // Kept before sealing: sealed now.
      if (!isSealed(stored)) localStorage.setItem(at(name), await sealWith(key, plain))
      return plain
    },
    async set(name, value, opts) {
      localStorage.setItem(at(name), opts?.sealed ? await sealWith(await vaultKey(db), value) : value)
    },
    async remove(name) {
      localStorage.removeItem(at(name))
    },
    async move(from, to) {
      const value = localStorage.getItem(at(from))
      if (value !== null) localStorage.setItem(at(to), value)
      localStorage.removeItem(at(from))
    },
    async names(start) {
      return Object.keys(localStorage)
        .filter((k) => k.startsWith(at(start)))
        .map((k) => k.slice(prefix.length))
    },
  }

  let wakeLock: WakeLockSentinel | null = null
  const presence: Presence = {
    onAway(fn) {
      addEventListener('pagehide', () => fn('gone'))
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') fn('hidden')
      })
    },
    onBack(fn) {
      addEventListener('pageshow', (e) => {
        if (e.persisted) fn('restored')
      })
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') fn('visible')
      })
    },
    visible: () => document.visibilityState === 'visible',
    beacon(url, body) {
      navigator.sendBeacon(url, body)
    },
    async holdScreen(on) {
      try {
        if (on && document.visibilityState === 'visible' && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen')
        else if (!on && wakeLock) {
          await wakeLock.release()
          wakeLock = null
        }
      } catch {
        // No wake lock in this browser.
      }
    },
  }

  return {
    store,
    presence,
    acquire(name) {
      if (!navigator.locks) return Promise.resolve<Held>({ held: false, why: 'unsupported' })
      return new Promise<Held>((resolve, reject) => {
        navigator.locks
          .request(name, { ifAvailable: true }, async (lock) => {
            if (!lock) return resolve({ held: false, why: 'taken' })
            // Held while the page lives, unless released.
            await new Promise<void>((release) => resolve({ held: true, release }))
          })
          .catch(reject)
      })
    },
    // Queued behind the tab that holds it: granted when that tab closes, never shared with it.
    wait(name) {
      if (!navigator.locks) return Promise.resolve<Held>({ held: false, why: 'unsupported' })
      return new Promise<Held>((resolve, reject) => {
        navigator.locks
          .request(name, async () => {
            await new Promise<void>((release) => resolve({ held: true, release }))
          })
          .catch(reject)
      })
    },
    restart: () => location.reload(),
    initSigner: async (init) => {
      await init()
    },
    keeper: options.keeper,
  }
}
