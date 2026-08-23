/**
 * The workspace shell: sidebar (collections) · tab strip · the active tab. Every open tab stays
 * MOUNTED (hidden with display:none) so in-flight requests and live sockets survive switching.
 */
import { useCallback, useEffect, useState } from 'react'

import { SettingsDialog } from './components/settings-dialog'
import { Sidebar } from './components/sidebar'
import { SideResizer, usePersistedNumber } from './components/split'
import type { TabSpec } from './components/tab-strip'
import { TabStrip } from './components/tab-strip'
import type { Connection, Theme } from './lib/config'
import {
  applyTheme,
  connection as readConnection,
  KEYS,
  storage,
  theme as readTheme,
} from './lib/config'
import type { Entry, Manifest } from './lib/manifest'
import { findEntry } from './lib/manifest'
import type { WireFailure } from './lib/ozaco'
import { loadManifest } from './lib/ozaco'
import { HttpTab } from './views/http-tab'
import { ManifestTab } from './views/manifest-tab'
import { SocketTab } from './views/socket-tab'

type Status = { kind: 'loading' } | { kind: 'ok' } | { kind: 'offline'; error: WireFailure }

export const App = () => {
  const [connection, setConnection] = useState<Connection>(readConnection)
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  // the manifest outlives a reload (a token change refetches it): open tabs keep their state
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [tabs, setTabs] = useState<TabSpec[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)
  const [sidebarWidth, setSidebarWidth, resetSidebar] = usePersistedNumber({
    key: KEYS.sidebar,
    fallback: 280,
    min: 200,
    max: 480,
  })

  useEffect(() => applyTheme(theme), [theme])

  const refresh = useCallback(() => {
    setStatus({ kind: 'loading' })
    void loadManifest(connection).then(
      loaded => {
        setManifest(loaded)
        setStatus({ kind: 'ok' })
        return loaded
      },
      (error: WireFailure) => {
        setStatus({ kind: 'offline', error })
        return null
      },
    )
  }, [connection])
  useEffect(refresh, [refresh])

  const open = (entry: Entry) => {
    const spec: TabSpec =
      entry.kind === 'action'
        ? { id: entry.id, kind: 'http', title: entry.action.id, method: entry.action.route.method }
        : { id: entry.id, kind: 'socket', title: entry.socket.path }
    setTabs(prior => (prior.some(tab => tab.id === spec.id) ? prior : [...prior, spec]))
    setActive(spec.id)
  }
  const close = (id: string) => {
    setTabs(prior => {
      const next = prior.filter(tab => tab.id !== id)
      if (active === id) {
        setActive(next.at(-1)?.id ?? null)
      }
      return next
    })
  }

  const setToken = (token: string | null) => {
    storage.set(KEYS.token, token)
    setConnection(readConnection())
  }

  return (
    <div className='flex h-full w-full overflow-hidden'>
      <div className='h-full shrink-0' style={{ width: sidebarWidth }}>
        <Sidebar
          manifest={manifest}
          connection={connection}
          selected={active}
          onOpen={open}
          onSettings={() => setSettings(true)}
          onManifest={() => {
            setTabs(prior =>
              prior.some(tab => tab.id === 'manifest')
                ? prior
                : [...prior, { id: 'manifest', kind: 'manifest', title: 'manifest' }],
            )
            setActive('manifest')
          }}
          onTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          observeUrl={
            manifest?.observe?.console ? `${connection.base}${manifest.observe.console}` : null
          }
        />
      </div>
      <SideResizer onResize={setSidebarWidth} onReset={resetSidebar} />
      <div className='flex min-w-0 flex-1 flex-col'>
        <TabStrip tabs={tabs} active={active} onSelect={setActive} onClose={close} />
        <div className='relative min-h-0 flex-1'>
          {status.kind === 'loading' && (
            <div className='p-6' style={{ color: 'var(--dim)' }}>
              loading the manifest from {connection.base}
              {connection.docsPath}/manifest…
            </div>
          )}
          {status.kind === 'offline' && (
            <div className='p-6'>
              <div style={{ color: 'var(--bad)' }}>
                cannot reach {connection.base}
                {connection.docsPath}/manifest
              </div>
              <div className='mono mt-1' style={{ color: 'var(--dim)' }}>
                {status.error.tag}: {status.error.message}
              </div>
              <div className='mt-3 flex gap-2'>
                <button className='btn btn-accent' onClick={refresh}>
                  retry
                </button>
                <button className='btn' onClick={() => setSettings(true)}>
                  settings
                </button>
              </div>
            </div>
          )}
          {manifest &&
            tabs.map(tab => {
              const entry = tab.kind === 'manifest' ? null : findEntry(manifest, tab.id)
              return (
                <div
                  key={tab.id}
                  className='absolute inset-0'
                  style={{ display: tab.id === active ? 'block' : 'none' }}>
                  {tab.kind === 'manifest' && <ManifestTab manifest={manifest} />}
                  {entry?.kind === 'action' && (
                    <HttpTab action={entry.action} connection={connection} onToken={setToken} />
                  )}
                  {entry?.kind === 'socket' && (
                    <SocketTab socket={entry.socket} connection={connection} />
                  )}
                  {tab.kind !== 'manifest' && !entry && (
                    <div className='p-6' style={{ color: 'var(--dim)' }}>
                      gone from the manifest
                    </div>
                  )}
                </div>
              )
            })}
          {manifest && tabs.length === 0 && (
            <div className='p-6' style={{ color: 'var(--dim)' }}>
              {manifest.name} {manifest.version} · {manifest.services.length} service(s) — pick a
              request on the left
            </div>
          )}
        </div>
      </div>
      {settings && (
        <SettingsDialog
          connection={connection}
          theme={theme}
          onClose={() => setSettings(false)}
          onSave={next => {
            storage.set(KEYS.base, next.base)
            storage.set(KEYS.docsPath, next.docsPath)
            storage.set(KEYS.token, next.token)
            setTheme(next.theme)
            setConnection(readConnection())
            setSettings(false)
          }}
        />
      )}
    </div>
  )
}
