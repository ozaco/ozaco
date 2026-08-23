/**
 * Where the panel talks to and what it remembers. Served by the docs plugin at `<docsPath>`
 * (`/docs` by default) on the same origin as the api, so the base is `location.origin` and the
 * docs path is the page's own path — both overridable (a dev server, another api).
 */

declare global {
  interface Window {
    __OZACO_PANEL__?: { base?: string; docsPath?: string }
  }
}

export const KEYS = {
  base: 'ozaco-panel:base',
  docsPath: 'ozaco-panel:docs-path',
  token: 'ozaco-panel:token',
  theme: 'ozaco-panel:theme',
  split: 'ozaco-panel:split',
  sidebar: 'ozaco-panel:sidebar-w',
  history: 'ozaco-panel:history',
} as const

const memory = new Map<string, string>()

export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key) ?? memory.get(key) ?? null
    } catch {
      return memory.get(key) ?? null
    }
  },

  set(key: string, value: string | null): void {
    try {
      if (value === null) {
        localStorage.removeItem(key)
      } else {
        localStorage.setItem(key, value)
      }
    } catch {
      // private mode / sandbox: keep it in memory
    }

    if (value === null) {
      memory.delete(key)
    } else {
      memory.set(key, value)
    }
  },
}

/** `/docs/` → `/docs`; a page path that is not the docs path (a dev server) → `/docs`. */
const docsPathOf = (): string => {
  const given = window.__OZACO_PANEL__?.docsPath ?? storage.get(KEYS.docsPath)

  if (given) {
    return given.replace(/\/$/u, '') || '/docs'
  }

  const path = location.pathname.replace(/\/$/u, '')

  return path.length > 0 && !path.endsWith('.html') ? path : '/docs'
}

export interface Connection {
  readonly base: string
  readonly docsPath: string
  readonly token: string | null
}

export const connection = (): Connection => ({
  base:
    window.__OZACO_PANEL__?.base ?? storage.get(KEYS.base) ?? location.origin.replace(/\/$/u, ''),
  docsPath: docsPathOf(),
  token: storage.get(KEYS.token),
})

export type Theme = 'dark' | 'light'

export const theme = (): Theme => (storage.get(KEYS.theme) === 'light' ? 'light' : 'dark')

export const applyTheme = (value: Theme): void => {
  storage.set(KEYS.theme, value)
  document.documentElement.classList.toggle('dark', value === 'dark')
  document.documentElement.classList.toggle('light', value === 'light')
}
