/** The collections rail: connection row, search, services → actions/sockets, footer. */
import { useState } from 'react'

import type { Connection } from '../lib/config'
import type { Entry, Manifest } from '../lib/manifest'
import { groupsOf, matches, orphanSockets } from '../lib/manifest'

import { MethodTag, WsTag } from './badges'

interface Props {
  readonly manifest: Manifest | null
  readonly connection: Connection
  readonly selected: string | null
  readonly onOpen: (entry: Entry) => void
  readonly onSettings: () => void
  readonly onManifest: () => void
  readonly onTheme: () => void
  readonly observeUrl: string | null
}

const Row = ({
  entry,
  selected,
  onOpen,
}: {
  entry: Entry
  selected: boolean
  onOpen: (entry: Entry) => void
}) => (
  <div
    className='tree-row row-hover flex cursor-pointer items-center gap-2 py-[3px] pr-2 pl-5'
    data-selected={selected || undefined}
    onClick={() => onOpen(entry)}
    title={
      entry.kind === 'action' ? entry.action.description : (entry.socket.description ?? undefined)
    }>
    {entry.kind === 'action' ? <MethodTag method={entry.action.route.method} /> : <WsTag />}
    <span className='truncate'>
      {entry.kind === 'action' ? entry.action.action : entry.socket.path}
    </span>
    {entry.kind === 'action' && entry.action.output.plane === 'stream' && (
      <span className='pill ml-auto' style={{ background: 'var(--panel-2)', color: 'var(--dim)' }}>
        {entry.action.output.brand?.split(':')[0]}
      </span>
    )}
  </div>
)

export const Sidebar = ({
  manifest,
  connection,
  selected,
  onOpen,
  onSettings,
  onManifest,
  onTheme,
  observeUrl,
}: Props) => {
  const [query, setQuery] = useState('')
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const toggle = (name: string) => {
    const next = new Set(closed)
    if (next.has(name)) {
      next.delete(name)
    } else {
      next.add(name)
    }
    setClosed(next)
  }
  const groups = manifest ? groupsOf(manifest) : []
  const orphans = manifest ? orphanSockets(manifest) : []
  return (
    <div className='flex h-full flex-col' style={{ background: 'var(--panel)' }}>
      <div
        className='flex items-center gap-2 border-b px-3 py-2'
        style={{ borderColor: 'var(--line)' }}>
        <b style={{ color: 'var(--accent)' }}>ozaco</b>
        <button
          className='mono ml-auto truncate text-left'
          style={{ color: 'var(--dim)', maxWidth: 150 }}
          onClick={onSettings}
          title={connection.base}>
          {connection.base.replace(/^https?:\/\//u, '')}
        </button>
        <span
          title={connection.token ? 'bearer token set' : 'no token'}
          style={{ color: connection.token ? 'var(--ok)' : 'var(--dim)' }}>
          ●
        </span>
      </div>
      <div className='px-2 py-2'>
        <input
          className='input'
          placeholder='filter (name, path, method, tag)'
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
      </div>
      <div className='min-h-0 flex-1 overflow-auto pb-2'>
        {manifest === null && (
          <div className='p-3' style={{ color: 'var(--dim)' }}>
            no manifest
          </div>
        )}
        {groups.map(group => {
          const entries = group.entries.filter(entry => matches(entry, query))
          if (entries.length === 0) {
            return null
          }
          const open = query.length > 0 || !closed.has(group.name)
          return (
            <div key={group.name}>
              <div
                className='row-hover flex cursor-pointer items-center gap-1 px-2 py-1'
                onClick={() => toggle(group.name)}
                title={group.description}>
                <span style={{ color: 'var(--dim)', width: 12 }}>{open ? '▾' : '▸'}</span>
                <span className='font-semibold'>{group.name}</span>
                <span className='mono ml-auto' style={{ color: 'var(--dim)' }}>
                  {group.version}
                </span>
              </div>
              {open &&
                entries.map(entry => (
                  <Row
                    key={entry.id}
                    entry={entry}
                    selected={entry.id === selected}
                    onOpen={onOpen}
                  />
                ))}
            </div>
          )
        })}
        {orphans.length > 0 && (
          <div>
            <div className='px-2 py-1 font-semibold'>sockets</div>
            {orphans.map(socket => (
              <Row
                key={socket.path}
                entry={{ kind: 'socket', id: `ws:${socket.path}`, socket }}
                selected={`ws:${socket.path}` === selected}
                onOpen={onOpen}
              />
            ))}
          </div>
        )}
      </div>
      <div
        className='flex items-center gap-2 border-t px-3 py-2'
        style={{ borderColor: 'var(--line)' }}>
        <button className='btn' onClick={onSettings} title='settings'>
          ⚙
        </button>
        <button className='btn' onClick={onManifest} title='manifest'>
          {'{}'}
        </button>
        {observeUrl && (
          <a
            className='btn'
            href={observeUrl}
            target='_blank'
            rel='noreferrer'
            title='observe console'>
            ◉ observe
          </a>
        )}
        <button className='btn ml-auto' onClick={onTheme} title='theme'>
          ◐
        </button>
      </div>
    </div>
  )
}
