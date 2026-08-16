/**
 * Panel runtime configuration: the injected base url, the persisted bearer token and the theme.
 * The host page may inject `window.__OZACO_PANEL__ = { base?: string }` BEFORE the bundle runs;
 * absent (or empty) base means same-origin relative requests.
 */

interface StringStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const createMemoryStore = (): StringStore => {
  const values = new Map<string, string>()

  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: key => {
      values.delete(key)
    },
  }
}

/** `localStorage` when available (browser), an in-memory fallback otherwise (tests, SSR). */
const store: StringStore = typeof localStorage === 'undefined' ? createMemoryStore() : localStorage

declare global {
  interface Window {
    __OZACO_PANEL__?: PanelGlobal
  }
}

const isTheme = (value: string | null): value is Theme =>
  value === 'dark' || value === 'light' || value === 'system'

export interface PanelGlobal {
  readonly base?: string
}

export const TOKEN_KEY = 'ozaco-panel:token'
export const THEME_KEY = 'ozaco-panel:theme'
export const BASE_KEY = 'ozaco-panel:base'

export type Theme = 'dark' | 'light' | 'system'

/** Base url for every API request: injected global, trailing slash trimmed, `''` = same origin. */
export const panelBase = (): string => {
  const injected = typeof window === 'undefined' ? undefined : window.__OZACO_PANEL__?.base

  return (injected ?? '').replace(/\/+$/u, '')
}

/** User-persisted base override (settings dialog) — beats the injected global when set. */
export const getBaseOverride = (): string => store.getItem(BASE_KEY) ?? ''

export const setBaseOverride = (base: string): void => {
  const trimmed = base.trim().replace(/\/+$/u, '')

  if (trimmed === '') {
    store.removeItem(BASE_KEY)

    return
  }

  store.setItem(BASE_KEY, trimmed)
}

/** The base every request should use: persisted override first, injected global otherwise. */
export const effectiveBase = (): string => {
  const override = getBaseOverride()

  return override === '' ? panelBase() : override
}

export const getToken = (): string => store.getItem(TOKEN_KEY) ?? ''

export const setToken = (token: string): void => {
  if (token === '') {
    store.removeItem(TOKEN_KEY)

    return
  }

  store.setItem(TOKEN_KEY, token)
}

export const getTheme = (): Theme => {
  const stored = store.getItem(THEME_KEY)

  return isTheme(stored) ? stored : 'system'
}

/** Persist the choice and stamp `data-theme` on the root element (`system` removes the stamp). */
export const setTheme = (theme: Theme): void => {
  store.setItem(THEME_KEY, theme)

  if (typeof document === 'undefined') {
    return
  }

  if (theme === 'system') {
    delete document.documentElement.dataset['theme']

    return
  }

  document.documentElement.dataset['theme'] = theme
}

/** Re-apply the persisted theme on boot (call once from the entrypoint). */
export const applyStoredTheme = (): Theme => {
  const theme = getTheme()

  setTheme(theme)

  return theme
}
