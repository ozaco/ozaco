import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { kindDotClass, methodDotClass, protoDotClass } from './components/badges'
import {
  SIDEBAR_BOUNDS,
  SIDEBAR_KEY,
  SPLIT_BOUNDS,
  SPLIT_KEY,
  SideResizer,
  usePersistedNumber,
  useStacked,
} from './components/layout'
import { SettingsDialog } from './components/settings-dialog'
import type { PanelSettings } from './components/settings-dialog'
import { Sidebar } from './components/sidebar'
import type { ConnState } from './components/sidebar'
import { TabStrip, tabIdOf } from './components/tab-strip'
import type { TabItem, TabSpec } from './components/tab-strip'
import { ToastProvider, useToasts } from './components/toasts'
import {
  DEFAULT_DOCS_PATH,
  effectiveBase,
  fetchManifest,
  findFn,
  getTheme,
  getToken,
  indexManifest,
  setBaseOverride,
  setTheme,
  setToken,
} from './lib'
import type { FnEntry, Manifest, Theme } from './lib'
import { HttpTab } from './views/http-tab'
import { ManifestTab } from './views/manifest-tab'
import { OfflineView } from './views/offline-view'
import { SseTab } from './views/sse-tab'
import { WsTab } from './views/ws-tab'

/**
 * LAYOUT OVERVIEW — Postman/Insomnia-style request workspace.
 *
 * Three-column shell: a resizable Sidebar (Insomnia collections tree: services as folders,
 * request rows with colored method tags, WS/SSE realtime rows, environment/base row, search,
 * settings/manifest/theme footer) | the workspace. The workspace stacks a Postman-style TabStrip
 * (every opened request is a closable tab; opening from the sidebar adds/focuses one) over the
 * active tab's view. Each tab view renders its own URL bar (method chip + resolved path + Send /
 * Connect action) above a request | response dual pane split by a draggable vertical splitter
 * (double-click resets, persisted in localStorage, stacks vertically below ~1000px). ALL open
 * tabs stay mounted (inactive ones display:none), so per-tab state — args, body, files, headers,
 * response, run history, live WS/SSE connections — survives tab switches. Tab kinds: 'http'
 * (views/http-tab), 'ws' (views/ws-tab), 'sse' (views/sse-tab) and the special 'manifest' tab.
 */

type ManifestState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly message: string }
  | { readonly phase: 'ready'; readonly manifest: Manifest; readonly entries: readonly FnEntry[] }

interface TabState {
  readonly tabs: readonly TabSpec[]
  readonly active: string | null
}

/** Same-origin panels are mounted AT the docs path — derive it from the page location. */
const docsPathFor = (base: string): string => {
  if (base !== '' || typeof location === 'undefined') {
    return DEFAULT_DOCS_PATH
  }

  const path = location.pathname.replace(/\/+$/u, '')

  return path === '' ? DEFAULT_DOCS_PATH : path
}

const THEME_ORDER: readonly Theme[] = ['dark', 'light', 'system']

const labelOf = (spec: TabSpec, entries: readonly FnEntry[]): TabItem => {
  const id = tabIdOf(spec)

  if (spec.kind === 'http') {
    const entry = findFn(entries, spec.fnId)
    const dot =
      entry === undefined
        ? 'bg-muted'
        : entry.route === undefined
          ? kindDotClass(entry.kind)
          : methodDotClass(entry.route.method)

    return { id, label: entry?.key ?? spec.fnId, dotClass: dot, hint: spec.fnId }
  }

  if (spec.kind === 'ws') {
    const name = spec.service ?? 'custom'

    return { id, label: `${name} · ws`, dotClass: protoDotClass('WS'), hint: `${name} · websocket` }
  }

  if (spec.kind === 'sse') {
    return {
      id,
      label: `${spec.service} · sse`,
      dotClass: protoDotClass('SSE'),
      hint: `${spec.service} · sse`,
    }
  }

  return { id, label: 'manifest', dotClass: 'bg-muted', hint: 'manifest document' }
}

const PanelApp = () => {
  const toasts = useToasts()
  const stacked = useStacked()
  const [settings, setSettings] = useState<PanelSettings>(() => ({
    base: effectiveBase(),
    token: getToken(),
    theme: getTheme(),
  }))
  const [state, setState] = useState<ManifestState>({ phase: 'loading' })
  const [tabState, setTabState] = useState<TabState>({ tabs: [], active: null })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarW, setSidebarW] = usePersistedNumber(SIDEBAR_KEY, SIDEBAR_BOUNDS)
  const [split, setSplit] = usePersistedNumber(SPLIT_KEY, SPLIT_BOUNDS)

  const docsPath = docsPathFor(settings.base)
  const probeUrl = `${settings.base}${docsPath}/manifest`

  const load = useCallback(
    async (base: string, quiet: boolean): Promise<void> => {
      if (!quiet) {
        setState({ phase: 'loading' })
      }

      try {
        const manifest = await fetchManifest(base, docsPathFor(base))

        setState({ phase: 'ready', manifest, entries: indexManifest(manifest) })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        if (quiet) {
          toasts.error(`Manifest reload failed: ${message}`)
        } else {
          setState({ phase: 'error', message })
        }
      }
    },
    [toasts],
  )

  // initial load + reload whenever the effective base changes (settings save)
  useEffect(() => {
    void load(settings.base, false)
  }, [load, settings.base])

  const applySettings = (next: PanelSettings): void => {
    setBaseOverride(next.base)
    setToken(next.token)
    setTheme(next.theme)
    setSettings(next)
    toasts.ok('Settings saved')
  }

  const toggleTheme = (): void => {
    const index = THEME_ORDER.indexOf(settings.theme)
    const next = THEME_ORDER[(index + 1) % THEME_ORDER.length] ?? 'dark'

    setTheme(next)
    setSettings(prev => ({ ...prev, theme: next }))
  }

  const openTab = useCallback((spec: TabSpec): void => {
    const id = tabIdOf(spec)

    setTabState(prev => ({
      tabs: prev.tabs.some(tab => tabIdOf(tab) === id) ? prev.tabs : [...prev.tabs, spec],
      active: id,
    }))
  }, [])

  const closeTab = useCallback((id: string): void => {
    setTabState(prev => {
      const index = prev.tabs.findIndex(tab => tabIdOf(tab) === id)

      if (index === -1) {
        return prev
      }

      const tabs = prev.tabs.filter(tab => tabIdOf(tab) !== id)

      if (prev.active !== id) {
        return { tabs, active: prev.active }
      }

      const neighbor = tabs[Math.min(index, tabs.length - 1)]

      return { tabs, active: neighbor === undefined ? null : tabIdOf(neighbor) }
    })
  }, [])

  const selectTab = useCallback((id: string): void => {
    setTabState(prev => ({ ...prev, active: id }))
  }, [])

  const connState: ConnState =
    state.phase === 'loading' ? 'loading' : state.phase === 'error' ? 'error' : 'ok'

  const ready = state.phase === 'ready' ? state : null
  const baseLabel = settings.base === '' ? 'same origin' : settings.base

  const renderTab = (spec: TabSpec): ReactNode => {
    if (ready === null) {
      return null
    }

    if (spec.kind === 'http') {
      const entry = findFn(ready.entries, spec.fnId)

      if (entry === undefined) {
        return (
          <div className='text-muted flex h-full items-center justify-center text-[13px]'>
            {spec.fnId} is no longer in the manifest
          </div>
        )
      }

      return (
        <HttpTab
          base={settings.base}
          entry={entry}
          onOpenSettings={() => setSettingsOpen(true)}
          onSplit={setSplit}
          split={split}
          stacked={stacked}
          token={settings.token}
        />
      )
    }

    if (spec.kind === 'ws') {
      return (
        <WsTab
          base={settings.base}
          manifest={ready.manifest}
          onSplit={setSplit}
          service={spec.service}
          split={split}
          stacked={stacked}
          token={settings.token}
        />
      )
    }

    if (spec.kind === 'sse') {
      return (
        <SseTab
          base={settings.base}
          manifest={ready.manifest}
          onSplit={setSplit}
          service={spec.service}
          split={split}
          stacked={stacked}
          token={settings.token}
        />
      )
    }

    return <ManifestTab manifest={ready.manifest} sourceUrl={probeUrl} />
  }

  return (
    <div className='bg-surface text-ink flex h-full'>
      <div className='flex h-full shrink-0' style={{ width: sidebarW }}>
        <Sidebar
          activeTabId={tabState.active}
          baseLabel={baseLabel}
          connState={connState}
          entries={ready?.entries ?? []}
          manifest={ready?.manifest ?? null}
          onOpen={openTab}
          onOpenSettings={() => setSettingsOpen(true)}
          onRefresh={() => {
            void load(settings.base, ready !== null)
          }}
          onToggleTheme={toggleTheme}
          theme={settings.theme}
        />
      </div>
      <SideResizer onWidth={setSidebarW} width={sidebarW} />

      <main className='flex h-full min-w-0 flex-1 flex-col'>
        <TabStrip
          activeId={tabState.active}
          onClose={closeTab}
          onSelect={selectTab}
          tabs={tabState.tabs.map(spec => labelOf(spec, ready?.entries ?? []))}
        />
        <div className='min-h-0 flex-1'>
          {ready === null ? (
            <OfflineView
              loading={state.phase === 'loading'}
              message={state.phase === 'error' ? state.message : ''}
              onOpenSettings={() => setSettingsOpen(true)}
              onRetry={() => {
                void load(settings.base, false)
              }}
              probeUrl={probeUrl}
            />
          ) : tabState.tabs.length === 0 ? (
            <div className='flex h-full flex-col items-center justify-center gap-1.5'>
              <span className='text-muted text-[13px]'>Open a request from the sidebar</span>
              <span className='text-muted text-[11.5px] opacity-70'>
                {ready.entries.length} functions · {Object.keys(ready.manifest.services).length}{' '}
                services
              </span>
            </div>
          ) : (
            tabState.tabs.map(spec => {
              const id = tabIdOf(spec)

              return (
                <div key={id} className={id === tabState.active ? 'h-full' : 'hidden'}>
                  {renderTab(spec)}
                </div>
              )
            })
          )}
        </div>
      </main>

      <SettingsDialog
        isOpen={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSave={applySettings}
        settings={settings}
      />
    </div>
  )
}

export const App = () => (
  <ToastProvider>
    <PanelApp />
  </ToastProvider>
)
