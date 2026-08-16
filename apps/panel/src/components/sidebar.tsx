import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, SearchField } from 'react-aria-components'

import type { FnEntry, Manifest, Theme } from '../lib'

import { KindTag, MethodTag, Pill, ProtoTag } from './badges'
import {
  BookIcon,
  ChevronIcon,
  CloseIcon,
  GearIcon,
  MarkIcon,
  MonitorIcon,
  MoonIcon,
  RefreshIcon,
  SearchIcon,
  SunIcon,
} from './icons'
import { tabIdOf } from './tab-strip'
import type { TabSpec } from './tab-strip'

/**
 * Insomnia-style left rail: app identity, environment/base row (click opens Settings), search,
 * and the collections tree — services as collapsible folders whose request rows carry colored
 * method tags (or WS/SSE badges for realtime channels). Footer: settings, manifest doc, theme.
 */

const CONN_TONE: Record<ConnState, string> = {
  loading: 'bg-mutation',
  ok: 'bg-ok',
  error: 'bg-danger',
}

const ICON_BUTTON =
  'text-muted data-hovered:text-ink data-hovered:bg-card flex h-7 w-7 items-center justify-center rounded'

const matches = (entry: FnEntry, needle: string): boolean =>
  entry.id.toLowerCase().includes(needle) ||
  (entry.title ?? '').toLowerCase().includes(needle) ||
  (entry.route?.path ?? '').toLowerCase().includes(needle) ||
  entry.tags.some(tag => tag.toLowerCase().includes(needle))

const realtimeMatches = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle)

const TreeRow = ({
  active,
  label,
  onPress,
  children,
}: {
  readonly active: boolean
  readonly label: string
  readonly onPress: () => void
  /** The leading tag element (method/kind/proto tag). */
  readonly children: ReactNode
}) => (
  <Button
    className={`flex h-7 w-full items-center gap-2 border-l-2 pr-2 pl-5 text-left text-[13px] outline-none ${
      active
        ? 'border-accent bg-accent/10 text-ink'
        : 'text-ink data-hovered:bg-card border-transparent'
    }`}
    onPress={onPress}>
    {children}
    <span className='min-w-0 flex-1 truncate'>{label}</span>
  </Button>
)

export type ConnState = 'loading' | 'ok' | 'error'

export const Sidebar = ({
  manifest,
  entries,
  activeTabId,
  connState,
  baseLabel,
  theme,
  onOpen,
  onRefresh,
  onOpenSettings,
  onToggleTheme,
}: {
  readonly manifest: Manifest | null
  readonly entries: readonly FnEntry[]
  readonly activeTabId: string | null
  readonly connState: ConnState
  readonly baseLabel: string
  readonly theme: Theme
  readonly onOpen: (spec: TabSpec) => void
  readonly onRefresh: () => void
  readonly onOpenSettings: () => void
  readonly onToggleTheme: () => void
}) => {
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  const needle = search.trim().toLowerCase()
  const searching = needle !== ''

  const toggleFolder = (service: string): void => {
    setCollapsed(prev => {
      const next = new Set(prev)

      if (next.has(service)) {
        next.delete(service)
      } else {
        next.add(service)
      }

      return next
    })
  }

  const isActive = (spec: TabSpec): boolean => tabIdOf(spec) === activeTabId

  const services = manifest === null ? [] : Object.keys(manifest.services)

  const sections = services.flatMap(service => {
    const fns = entries.filter(
      entry => entry.service === service && (!searching || matches(entry, needle)),
    )
    const realtime = manifest?.services[service]?.realtime
    const showWs =
      realtime !== undefined &&
      (!searching || realtimeMatches(`${service} ${realtime.path} ws realtime`, needle))
    const showSse =
      realtime?.sse === true &&
      (!searching || realtimeMatches(`${service} ${realtime.path}/sse sse realtime`, needle))

    if (fns.length === 0 && !showWs && !showSse) {
      return []
    }

    return [{ service, fns, realtime, showWs, showSse }]
  })

  return (
    <aside className='bg-panel flex h-full min-h-0 min-w-0 flex-1 flex-col'>
      <header className='border-line flex h-11 shrink-0 items-center gap-2 border-b px-3'>
        <MarkIcon className='text-accent shrink-0' height={16} width={16} />
        <h1
          className='text-ink min-w-0 flex-1 truncate text-[13px] font-semibold'
          title={manifest?.app.description ?? undefined}>
          {manifest?.app.title ?? 'Ozaco Panel'}
        </h1>
        {manifest === null ? null : <Pill>v{manifest.app.version}</Pill>}
      </header>

      <div className='border-line flex shrink-0 items-center gap-1 border-b p-2'>
        <Button
          aria-label='Environment — open settings'
          className='border-line bg-surface data-hovered:border-accent/50 flex h-7 min-w-0 flex-1 items-center gap-2 rounded border px-2'
          onPress={onOpenSettings}>
          <span
            aria-hidden='true'
            className={`h-2 w-2 shrink-0 rounded-full ${CONN_TONE[connState]}`}
          />
          <span className='text-muted min-w-0 flex-1 truncate text-left font-mono text-[11.5px]'>
            {baseLabel}
          </span>
          {manifest?.auth?.bearer === true ? (
            <span className='text-muted shrink-0 text-[10px] tracking-wider uppercase'>bearer</span>
          ) : null}
        </Button>
        <Button aria-label='Reload manifest' className={ICON_BUTTON} onPress={onRefresh}>
          <RefreshIcon />
        </Button>
      </div>

      <div className='shrink-0 p-2 pb-1'>
        <SearchField
          aria-label='Filter requests'
          className='border-line bg-surface data-focus-within:border-accent flex items-center gap-1.5 rounded border px-2'
          onChange={setSearch}
          value={search}>
          <SearchIcon className='text-muted shrink-0' />
          <Input
            className='text-ink w-full min-w-0 bg-transparent py-1 text-[12.5px] outline-none [&::-webkit-search-cancel-button]:hidden'
            placeholder='Filter'
          />
          {search === '' ? null : (
            <Button
              aria-label='Clear filter'
              className='text-muted data-hovered:text-ink rounded p-0.5'>
              <CloseIcon />
            </Button>
          )}
        </SearchField>
      </div>

      <nav aria-label='Collections' className='min-h-0 flex-1 overflow-y-auto py-1'>
        {sections.length === 0 ? (
          <p className='text-muted px-3 py-4 text-center text-[12.5px]'>
            {manifest === null
              ? 'No manifest loaded'
              : searching
                ? 'Nothing matches the filter'
                : 'No services published yet'}
          </p>
        ) : (
          sections.map(({ service, fns, realtime, showWs, showSse }) => {
            const open = searching || !collapsed.has(service)

            return (
              <section key={service}>
                <Button
                  aria-expanded={open}
                  className='text-ink data-hovered:bg-card flex h-7 w-full items-center gap-1.5 px-2 text-left text-[12.5px] font-semibold outline-none'
                  onPress={() => toggleFolder(service)}>
                  <ChevronIcon
                    className={`text-muted shrink-0 ${open ? 'rotate-90' : ''}`}
                    height={11}
                    width={11}
                  />
                  <span className='min-w-0 flex-1 truncate'>{service}</span>
                  <span className='text-muted shrink-0 text-[11px] font-normal'>{fns.length}</span>
                </Button>
                {open ? (
                  <ul>
                    {fns.map(entry => (
                      <li key={entry.id}>
                        <TreeRow
                          active={isActive({ kind: 'http', fnId: entry.id })}
                          label={entry.key}
                          onPress={() => onOpen({ kind: 'http', fnId: entry.id })}>
                          {entry.route === undefined ? (
                            <KindTag kind={entry.kind} />
                          ) : (
                            <MethodTag method={entry.route.method} />
                          )}
                        </TreeRow>
                      </li>
                    ))}
                    {realtime !== undefined && showWs ? (
                      <li>
                        <TreeRow
                          active={isActive({ kind: 'ws', service })}
                          label='realtime'
                          onPress={() => onOpen({ kind: 'ws', service })}>
                          <ProtoTag proto='WS' />
                        </TreeRow>
                      </li>
                    ) : null}
                    {realtime !== undefined && showSse ? (
                      <li>
                        <TreeRow
                          active={isActive({ kind: 'sse', service })}
                          label='realtime (sse)'
                          onPress={() => onOpen({ kind: 'sse', service })}>
                          <ProtoTag proto='SSE' />
                        </TreeRow>
                      </li>
                    ) : null}
                  </ul>
                ) : null}
              </section>
            )
          })
        )}

        {manifest === null || searching ? null : (
          <div className='border-line mt-2 border-t pt-1'>
            <TreeRow
              active={isActive({ kind: 'ws', service: null })}
              label='custom socket…'
              onPress={() => onOpen({ kind: 'ws', service: null })}>
              <ProtoTag proto='WS' />
            </TreeRow>
          </div>
        )}
      </nav>

      <footer className='border-line flex shrink-0 items-center gap-1 border-t p-1.5'>
        <Button aria-label='Open settings' className={ICON_BUTTON} onPress={onOpenSettings}>
          <GearIcon />
        </Button>
        <Button
          aria-label='Open manifest document'
          className={ICON_BUTTON}
          isDisabled={manifest === null}
          onPress={() => onOpen({ kind: 'manifest' })}>
          <BookIcon />
        </Button>
        <span className='flex-1' />
        <Button
          aria-label={`Theme: ${theme} — click to switch`}
          className={ICON_BUTTON}
          onPress={onToggleTheme}>
          {theme === 'dark' ? <MoonIcon /> : theme === 'light' ? <SunIcon /> : <MonitorIcon />}
        </Button>
      </footer>
    </aside>
  )
}
