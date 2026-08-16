/**
 * WebSocket watch engine against the `server:core` realtime frame vocabulary:
 * `{event:'watch'|'unwatch',...}` out, `{type:'sync'|'delta'|'reset'|'error',...}` in. Rows are
 * kept in an insertion-ordered map keyed by `_id` (synthetic keys when rows carry none), `version`
 * tracks the resume point: reconnects resend every watch with `since=<version>`, a `reset` frame
 * drops `since` and resubscribes for a fresh `sync`. Auth rides the `?token=` query parameter —
 * the gateway edge promotes it to a bearer `authorization` header on upgrade.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const keyOf = (row: unknown): string | null =>
  isRecord(row) && typeof row['_id'] === 'string' ? row['_id'] : null

const DEFAULT_RECONNECT = { retries: 10, delayMs: 300, maxDelayMs: 10_000 }

export type ClientFrame =
  | {
      readonly event: 'watch'
      readonly id: string
      readonly fn: string
      readonly args?: unknown
      readonly since?: number
    }
  | { readonly event: 'unwatch'; readonly id: string }

export type ServerFrame =
  | {
      readonly type: 'sync'
      readonly id: string
      readonly version: number
      readonly rows: readonly unknown[]
    }
  | {
      readonly type: 'delta'
      readonly id: string
      readonly version: number
      readonly added: readonly unknown[]
      readonly changed: readonly unknown[]
      readonly removed: readonly string[]
    }
  | { readonly type: 'reset'; readonly id: string }
  | {
      readonly type: 'error'
      readonly id: string
      readonly error: string
      readonly message: string
      readonly requestId: string
    }

/** Minimal shape check for incoming frames (the server validates outgoing ones with zod). */
export const parseServerFrame = (data: unknown): ServerFrame | null => {
  if (typeof data !== 'string') {
    return null
  }

  let raw: unknown

  try {
    raw = JSON.parse(data)
  } catch {
    return null
  }

  if (!isRecord(raw) || typeof raw['id'] !== 'string') {
    return null
  }

  const type = raw['type']

  if (type === 'sync' && Array.isArray(raw['rows']) && typeof raw['version'] === 'number') {
    return raw as unknown as ServerFrame
  }

  if (
    type === 'delta' &&
    typeof raw['version'] === 'number' &&
    Array.isArray(raw['added']) &&
    Array.isArray(raw['changed']) &&
    Array.isArray(raw['removed'])
  ) {
    return raw as unknown as ServerFrame
  }

  if (type === 'reset') {
    return raw as unknown as ServerFrame
  }

  if (type === 'error' && typeof raw['error'] === 'string') {
    return raw as unknown as ServerFrame
  }

  return null
}

/** Rows → insertion-ordered map. `_id`-keyed when EVERY row has one, synthetic keys otherwise. */
export const keyRows = (
  rows: readonly unknown[],
): { rows: Map<string, unknown>; keyed: boolean } => {
  const keyed = rows.every(row => keyOf(row) !== null)
  const map = new Map<string, unknown>()

  for (const [index, row] of rows.entries()) {
    map.set(keyed ? (keyOf(row) as string) : `#${index}`, row)
  }

  return { rows: map, keyed }
}

export interface WatchEntry {
  readonly id: string
  readonly fn: string
  readonly args: unknown
  rows: Map<string, unknown>
  keyed: boolean
  /** Last observed server version; `-1` = none (a fresh subscribe sends no `since`). */
  version: number
  /** True once a `sync` landed (the watch is live). */
  live: boolean
}

export const createWatchEntry = (id: string, fn: string, args?: unknown): WatchEntry => ({
  id,
  fn,
  args,
  rows: new Map(),
  keyed: false,
  version: -1,
  live: false,
})

/** The `since` a (re)subscribe should carry: the observed version, or nothing before first sync. */
export const resumeSince = (entry: WatchEntry): number | undefined =>
  entry.version >= 0 ? entry.version : undefined

/** The outgoing watch frame for an entry (no `since` key at all when there is none). */
export const buildWatchFrame = (entry: WatchEntry, since?: number): ClientFrame => ({
  event: 'watch',
  id: entry.id,
  fn: entry.fn,
  ...(entry.args === undefined ? {} : { args: entry.args }),
  ...(since === undefined ? {} : { since }),
})

export type FrameEffect =
  | { readonly kind: 'rows' }
  | { readonly kind: 'resubscribe' }
  | {
      readonly kind: 'error'
      readonly error: string
      readonly message: string
      readonly requestId: string
    }

/** Fold one server frame into its entry; the returned effect tells the engine what to do next. */
export const applyServerFrame = (entry: WatchEntry, frame: ServerFrame): FrameEffect => {
  if (frame.type === 'sync') {
    const next = keyRows(frame.rows)

    entry.rows = next.rows
    entry.keyed = next.keyed
    entry.version = frame.version
    entry.live = true

    return { kind: 'rows' }
  }

  if (frame.type === 'delta') {
    for (const row of [...frame.added, ...frame.changed]) {
      const key = keyOf(row)

      if (key !== null && entry.keyed) {
        entry.rows.set(key, row)
      } else {
        // unkeyed rows cannot be diffed — append synthetically, the next sync replaces all
        entry.rows.set(`#${entry.rows.size}`, row)
      }
    }

    for (const id of frame.removed) {
      entry.rows.delete(id)
    }

    entry.version = frame.version

    return { kind: 'rows' }
  }

  if (frame.type === 'reset') {
    // our `since` is stale — resubscribe WITHOUT since and expect a fresh sync
    entry.version = -1
    entry.live = false

    return { kind: 'resubscribe' }
  }

  return {
    kind: 'error',
    error: frame.error,
    message: frame.message,
    requestId: frame.requestId,
  }
}

/** http(s) base + path (+ `?token=`) → ws(s) url; empty base falls back to `location`. */
export const wsUrl = (base: string, path: string, token?: string): string => {
  const query = token === undefined || token === '' ? '' : `?token=${encodeURIComponent(token)}`

  if (base === '') {
    const scheme = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss' : 'ws'
    const host = typeof location === 'undefined' ? 'localhost' : location.host

    return `${scheme}://${host}${path}${query}`
  }

  return `${base.replace(/^http/u, 'ws')}${path}${query}`
}

export type EngineStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export type LogDirection = 'in' | 'out' | 'sys' | 'err'

export interface LogEntry {
  readonly at: number
  readonly dir: LogDirection
  readonly text: string
}

export interface RealtimeEngineInput {
  /** http(s) base (`''` = same origin via `location`). */
  readonly base: string
  /** The realtime path from the manifest (`services.<name>.realtime.path`). */
  readonly path: string
  /** Bearer token supplier — sent as `?token=` on every (re)connect. */
  readonly token?: () => string
  readonly onRows?: (id: string, rows: readonly unknown[], version: number) => void
  readonly onStatus?: (status: EngineStatus) => void
  readonly onLog?: (entry: LogEntry) => void
  readonly reconnect?: {
    readonly retries?: number
    readonly delayMs?: number
    readonly maxDelayMs?: number
  }
  /** Injectable ctor for tests. */
  readonly webSocket?: new (url: string) => WebSocket
}

export interface RealtimeEngine {
  readonly connect: () => void
  /** Register a watch (subscribes now when open, on connect otherwise); returns the watch id. */
  readonly watch: (fn: string, args?: unknown) => string
  readonly unwatch: (id: string) => void
  readonly rows: (id: string) => readonly unknown[]
  readonly entry: (id: string) => WatchEntry | undefined
  readonly status: () => EngineStatus
  /** Disconnect and drop every watch — terminal. */
  readonly stop: () => void
}

export const createRealtimeEngine = (input: RealtimeEngineInput): RealtimeEngine => {
  const retries = input.reconnect?.retries ?? DEFAULT_RECONNECT.retries
  const delayMs = input.reconnect?.delayMs ?? DEFAULT_RECONNECT.delayMs
  const maxDelayMs = input.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT.maxDelayMs
  const SocketCtor = input.webSocket ?? WebSocket

  const entries = new Map<string, WatchEntry>()
  let socket: WebSocket | null = null
  let currentStatus: EngineStatus = 'idle'
  let attempts = 0
  let seq = 0
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const log = (dir: LogDirection, text: string): void => {
    input.onLog?.({ at: Date.now(), dir, text })
  }

  const setStatus = (status: EngineStatus): void => {
    currentStatus = status
    input.onStatus?.(status)
  }

  const send = (frame: ClientFrame): boolean => {
    if (socket === null || socket.readyState !== 1) {
      return false
    }

    const text = JSON.stringify(frame)

    socket.send(text)
    log('out', text)

    return true
  }

  const subscribe = (entry: WatchEntry, since: number | undefined): void => {
    send(buildWatchFrame(entry, since))
  }

  const handleMessage = (data: unknown): void => {
    log('in', typeof data === 'string' ? data : '[binary frame]')

    const frame = parseServerFrame(data)

    if (frame === null) {
      return
    }

    const entry = entries.get(frame.id)

    if (entry === undefined) {
      return
    }

    const effect = applyServerFrame(entry, frame)

    if (effect.kind === 'rows') {
      input.onRows?.(entry.id, [...entry.rows.values()], entry.version)

      return
    }

    if (effect.kind === 'resubscribe') {
      log('sys', `reset: resubscribing "${entry.id}" without since`)
      subscribe(entry, undefined)

      return
    }

    log('err', `watch "${entry.id}" failed: ${effect.error} — ${effect.message}`)
  }

  const scheduleReconnect = (): void => {
    if (stopped || attempts >= retries) {
      setStatus('closed')

      if (!stopped) {
        log('err', 'reconnect attempts exhausted')
      }

      return
    }

    const delay = Math.min(delayMs * 2 ** attempts, maxDelayMs)

    attempts += 1
    setStatus('reconnecting')
    log('sys', `reconnecting in ${delay}ms (attempt ${attempts}/${retries})`)

    timer = setTimeout(() => {
      timer = null
      open()
    }, delay)
  }

  const open = (): void => {
    if (stopped || socket !== null) {
      return
    }

    const url = wsUrl(input.base, input.path, input.token?.())

    if (currentStatus !== 'reconnecting') {
      setStatus('connecting')
    }

    const ws = new SocketCtor(url)

    socket = ws

    /* oxlint-disable unicorn/prefer-add-event-listener -- single-owner socket, assignment is intentional */
    ws.onopen = () => {
      attempts = 0
      setStatus('open')
      log('sys', 'connected')

      // the server forgets subscriptions on every drop — resend all watches with since
      for (const entry of entries.values()) {
        subscribe(entry, resumeSince(entry))
      }
    }

    ws.onmessage = event => {
      handleMessage(event.data)
    }

    ws.onerror = () => {
      log('err', 'socket error')
    }

    ws.onclose = () => {
      socket = null

      if (stopped) {
        setStatus('closed')

        return
      }

      log('sys', 'disconnected')
      scheduleReconnect()
    }
    /* oxlint-enable unicorn/prefer-add-event-listener */
  }

  return {
    connect: () => {
      stopped = false
      open()
    },

    watch: (fn, args) => {
      seq += 1

      const entry = createWatchEntry(`w${seq}`, fn, args)

      entries.set(entry.id, entry)
      subscribe(entry, undefined)

      return entry.id
    },

    unwatch: id => {
      if (entries.delete(id)) {
        send({ event: 'unwatch', id })
      }
    },

    rows: id => {
      const entry = entries.get(id)

      return entry === undefined ? [] : [...entry.rows.values()]
    },

    entry: id => entries.get(id),

    status: () => currentStatus,

    stop: () => {
      stopped = true
      entries.clear()

      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }

      if (socket === null) {
        setStatus('closed')
      } else {
        socket.close()
      }
    },
  }
}
