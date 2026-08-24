/**
 * A socket tab: a resource's realtime feed (watch frames materialized into live rows + a frame
 * timeline) or a custom socket (send any JSON frame, see what comes back).
 */
import { useEffect, useRef, useState } from 'react'

import { SplitLayout } from '../components/split'
import type { Line } from '../components/timeline'
import { Timeline } from '../components/timeline'
import type { Connection } from '../lib/config'
import { KEYS } from '../lib/config'
import type { Socket, WatchFrame, Watching, WindowInfo } from '../lib/ozaco'
import { clientOf, watch } from '../lib/ozaco'

interface Props {
  readonly socket: Socket
  readonly connection: Connection
}

const resourceOf = (socket: Socket): string => socket.service ?? socket.path.split('/')[1] ?? ''

const socketUrl = (connection: Connection, path: string): string => {
  const url = new URL(path, connection.base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  if (connection.token) {
    url.searchParams.set('token', connection.token)
  }
  return url.toString()
}

export const SocketTab = ({ socket, connection }: Props) => {
  const isResource = socket.protocol === 'resource'
  const defaults = (socket.defaults ?? {}) as { cursor?: number | string }
  const [filter, setFilter] = useState('')
  const [order, setOrder] = useState('')
  const [since, setSince] = useState('')
  const [limit, setLimit] = useState('')
  const [cursor, setCursor] = useState(String(defaults.cursor ?? 0))
  const [page, setPage] = useState<WindowInfo | null>(null)
  const [frameText, setFrameText] = useState('{ "text": "hello" }')
  const [connected, setConnected] = useState(false)
  const [lines, setLines] = useState<Line[]>([])
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [token, setToken] = useState<string | null>(null)
  const watching = useRef<Watching | null>(null)
  const raw = useRef<WebSocket | null>(null)
  const startedAt = useRef(0)

  const log = (tone: Line['tone'], text: string) =>
    setLines(prior =>
      [...prior, { at: performance.now() - startedAt.current, tone, text }].slice(-500),
    )

  const apply = (frame: WatchFrame) => {
    setToken(frame.token)
    if (frame.t === 'notify') {
      setPage(frame.page)
      log('info', `notify · the set changed around this window · total ${frame.page.total}`)
      return
    }
    if (frame.page) {
      setPage(frame.page)
    }
    if (frame.t === 'sync') {
      setRows([...frame.rows])
      log('in', `sync ${frame.rows.length} row(s) · ${frame.token}`)
      return
    }
    setRows(prior => {
      const byId = new Map(prior.map(row => [String(row['_id']), row]))
      for (const row of [...frame.added, ...frame.changed]) {
        byId.set(String(row['_id']), row)
      }
      for (const id of frame.removed) {
        byId.delete(id)
      }
      return [...byId.values()]
    })
    log(
      'in',
      `delta +${frame.added.length} ~${frame.changed.length} -${frame.removed.length} · ${frame.token}`,
    )
  }

  const disconnect = async () => {
    await watching.current?.stop()
    watching.current = null
    raw.current?.close()
    raw.current = null
    setConnected(false)
    log('info', 'disconnected')
  }

  const openWatch = (turnCursor: string | null) => {
    let parsedFilter: unknown
    let parsedOrder: { field: string; direction?: 'asc' | 'desc' } | undefined
    try {
      parsedFilter = filter.trim() ? JSON.parse(filter) : undefined
      parsedOrder = order.trim() ? (JSON.parse(order) as typeof parsedOrder) : undefined
    } catch {
      log('error', 'filter/order must be JSON')
      setConnected(false)
      return
    }
    const window = Number(limit)
    const opening = turnCursor ?? cursor.trim() ?? ''
    log(
      'out',
      `watch ${resourceOf(socket)} ${filter.trim() || ''}${window > 0 ? ` limit ${window}` : ''}${opening && opening !== '0' ? ' (cursor)' : ''}${since.trim() ? ` since ${since}` : ''}`,
    )
    watching.current = watch(
      clientOf(connection),
      resourceOf(socket),
      {
        filter: parsedFilter,
        order: parsedOrder,
        since: since.trim() || undefined,
        ...(window > 0 ? { limit: window, cursor: opening || undefined } : {}),
      },
      {
        onFrame: apply,
        onEnd: error => {
          log(error ? 'error' : 'info', error ? `${error.tag}: ${error.message}` : 'closed')

          if (error && !connection.token) {
            log(
              'info',
              'no connection token is set — guarded resources reject the handshake (login, then “use accessToken as the connection token”)',
            )
          } else if (error) {
            log(
              'info',
              'the handshake may have been rejected — expired or invalid tokens are refused; refresh the token in Settings',
            )
          }

          setConnected(false)
        },
      },
    )
  }

  // a page turn replaces ONLY this subscription's window — same socket, no reconnect;
  // the fresh sync of the new page swaps the rows when it lands
  const turnTo = (to: string | null, back = false) => {
    log('out', `turn ${back ? '‹ ' : ''}${to ?? '(first page)'}`)
    watching.current?.turn(to, back)
  }

  const connect = () => {
    startedAt.current = performance.now()
    setLines([])
    setRows([])
    setPage(null)
    setConnected(true)
    if (isResource) {
      openWatch(null)
      return
    }
    const ws = new WebSocket(socketUrl(connection, socket.path))
    raw.current = ws
    log('out', `connect ${socket.path}`)
    ws.addEventListener('open', () => log('info', 'open'))
    ws.addEventListener('message', event => log('in', String(event.data)))
    ws.addEventListener('close', event => {
      log('info', `close ${event.code} ${event.reason}`)
      setConnected(false)
    })
    ws.addEventListener('error', () =>
      log('error', 'socket error — the upgrade may have been rejected (missing/expired token?)'),
    )
  }

  const sendFrame = () => {
    if (!raw.current || raw.current.readyState !== WebSocket.OPEN) {
      log('error', 'not connected')
      return
    }
    raw.current.send(frameText)
    log('out', frameText)
  }

  useEffect(() => () => void disconnect(), [])

  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))].filter(
    key => !key.startsWith('_') || key === '_id',
  )

  const left = (
    <div className='flex h-full flex-col'>
      <div
        className='flex items-center gap-2 border-b px-3 py-2'
        style={{ borderColor: 'var(--line)' }}>
        <span className='mono font-bold' style={{ color: 'var(--ws)' }}>
          WS
        </span>
        <div
          className='mono flex-1 truncate rounded px-2 py-1'
          style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}>
          {socket.path}
        </div>
        <button
          className={`btn ${connected ? 'btn-bad' : 'btn-accent'}`}
          onClick={() => (connected ? void disconnect() : connect())}>
          {connected ? 'Disconnect' : 'Connect'}
        </button>
      </div>
      <div className='flex flex-col gap-2 overflow-auto p-2'>
        {socket.description && <div style={{ color: 'var(--dim)' }}>{socket.description}</div>}
        {isResource ? (
          <>
            <label className='flex items-center gap-2'>
              <span className='mono w-[80px]'>filter</span>
              <input
                className='input mono'
                placeholder='{"op":"eq","field":"done","value":false}'
                value={filter}
                onChange={event => setFilter(event.target.value)}
              />
            </label>
            <label className='flex items-center gap-2'>
              <span className='mono w-[80px]'>order</span>
              <input
                className='input mono'
                placeholder='{"field":"_createdAt","direction":"desc"}'
                value={order}
                onChange={event => setOrder(event.target.value)}
              />
            </label>
            <label className='flex items-center gap-2'>
              <span className='mono w-[80px]'>since</span>
              <input
                className='input mono'
                placeholder='a token from a previous frame'
                value={since}
                onChange={event => setSince(event.target.value)}
              />
              {token && (
                <button className='btn' onClick={() => setSince(token)}>
                  use last
                </button>
              )}
            </label>
            <label className='flex items-center gap-2'>
              <span className='mono w-[80px]'>limit</span>
              <input
                className='input mono'
                placeholder='window size (empty = unbounded watch)'
                value={limit}
                onChange={event => setLimit(event.target.value)}
              />
            </label>
            <label className='flex items-center gap-2'>
              <span className='mono w-[80px]'>cursor</span>
              <input
                className='input mono'
                placeholder='0 = start · a row _id starts the window at that row'
                value={cursor}
                onChange={event => setCursor(event.target.value)}
              />
            </label>
            {page && (
              <div className='flex items-center gap-2'>
                <span className='mono' style={{ color: 'var(--dim)' }}>
                  window · total {page.total}
                </span>
                <button
                  className='btn'
                  disabled={!connected || page.prev === null}
                  onClick={() => turnTo(page.prev, page.prev !== null)}>
                  ‹ prev
                </button>
                <button
                  className='btn'
                  disabled={!connected || page.next === null}
                  onClick={() => turnTo(page.next)}>
                  next ›
                </button>
              </div>
            )}
            <div className='mt-2 font-semibold'>live rows ({rows.length})</div>
            <div className='overflow-auto'>
              <table className='mono w-full border-collapse text-[11px]'>
                <thead>
                  <tr>
                    {columns.map(column => (
                      <th
                        key={column}
                        className='border-b px-1 py-0.5 text-left'
                        style={{ borderColor: 'var(--line)', color: 'var(--dim)' }}>
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={String(row['_id'])} className='row-hover'>
                      {columns.map(column => (
                        <td key={column} className='max-w-[220px] truncate px-1 py-0.5'>
                          {typeof row[column] === 'string'
                            ? String(row[column])
                            : JSON.stringify(row[column])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <>
            <textarea
              className='input'
              rows={6}
              value={frameText}
              onChange={event => setFrameText(event.target.value)}
            />
            <div>
              <button className='btn' onClick={sendFrame}>
                send frame
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )

  return <SplitLayout left={left} right={<Timeline lines={lines} />} storageKey={KEYS.split} />
}
