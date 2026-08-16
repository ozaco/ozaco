import { describe, expect, test } from 'bun:test'

import {
  applyServerFrame,
  buildWatchFrame,
  createRealtimeEngine,
  createWatchEntry,
  keyRows,
  parseServerFrame,
  resumeSince,
  wsUrl,
} from '../src/lib/realtime'
import type { ServerFrame } from '../src/lib/realtime'

const sync = (rows: unknown[], version = 1): ServerFrame => ({
  type: 'sync',
  id: 'w1',
  version,
  rows,
})

describe('keyRows', () => {
  test('keys by _id when every row has one', () => {
    const { rows, keyed } = keyRows([{ _id: 'a' }, { _id: 'b' }])

    expect(keyed).toBe(true)
    expect([...rows.keys()]).toEqual(['a', 'b'])
  })

  test('falls back to synthetic keys when ANY row lacks _id', () => {
    const { rows, keyed } = keyRows([{ _id: 'a' }, { name: 'no id' }])

    expect(keyed).toBe(false)
    expect([...rows.keys()]).toEqual(['#0', '#1'])
  })
})

describe('applyServerFrame', () => {
  test('sync replaces rows, records version and marks live', () => {
    const entry = createWatchEntry('w1', 'list')
    const effect = applyServerFrame(entry, sync([{ _id: 'a', n: 1 }], 5))

    expect(effect).toEqual({ kind: 'rows' })
    expect(entry.live).toBe(true)
    expect(entry.version).toBe(5)
    expect([...entry.rows.values()]).toEqual([{ _id: 'a', n: 1 }])
  })

  test('delta applies added, changed and removed in order', () => {
    const entry = createWatchEntry('w1', 'list')

    applyServerFrame(
      entry,
      sync(
        [
          { _id: 'a', n: 1 },
          { _id: 'b', n: 2 },
        ],
        1,
      ),
    )

    const effect = applyServerFrame(entry, {
      type: 'delta',
      id: 'w1',
      version: 2,
      added: [{ _id: 'c', n: 3 }],
      changed: [{ _id: 'a', n: 10 }],
      removed: ['b'],
    })

    expect(effect).toEqual({ kind: 'rows' })
    expect(entry.version).toBe(2)
    expect([...entry.rows.values()]).toEqual([
      { _id: 'a', n: 10 },
      { _id: 'c', n: 3 },
    ])
  })

  test('delta on unkeyed rows appends synthetically instead of diffing', () => {
    const entry = createWatchEntry('w1', 'stats')

    applyServerFrame(entry, sync([{ total: 1 }], 1))
    applyServerFrame(entry, {
      type: 'delta',
      id: 'w1',
      version: 2,
      added: [{ total: 2 }],
      changed: [],
      removed: [],
    })

    expect([...entry.rows.values()]).toEqual([{ total: 1 }, { total: 2 }])
  })

  test('reset clears the resume point and asks for a resubscribe', () => {
    const entry = createWatchEntry('w1', 'list')

    applyServerFrame(entry, sync([{ _id: 'a' }], 7))

    const effect = applyServerFrame(entry, { type: 'reset', id: 'w1' })

    expect(effect).toEqual({ kind: 'resubscribe' })
    expect(entry.version).toBe(-1)
    expect(entry.live).toBe(false)
    expect(resumeSince(entry)).toBeUndefined()
  })

  test('error surfaces the failure triple', () => {
    const entry = createWatchEntry('w1', 'list')
    const effect = applyServerFrame(entry, {
      type: 'error',
      id: 'w1',
      error: 'server:wizard.not-watchable',
      message: 'nope',
      requestId: 'r1',
    })

    expect(effect).toEqual({
      kind: 'error',
      error: 'server:wizard.not-watchable',
      message: 'nope',
      requestId: 'r1',
    })
  })
})

describe('since resume decision', () => {
  test('fresh entries send no since, synced entries resume from their version', () => {
    const entry = createWatchEntry('w1', 'list', { filter: { done: false } })

    expect(resumeSince(entry)).toBeUndefined()
    expect(buildWatchFrame(entry, resumeSince(entry))).toEqual({
      event: 'watch',
      id: 'w1',
      fn: 'list',
      args: { filter: { done: false } },
    })

    applyServerFrame(entry, sync([], 9))

    expect(resumeSince(entry)).toBe(9)
    expect(buildWatchFrame(entry, resumeSince(entry))).toEqual({
      event: 'watch',
      id: 'w1',
      fn: 'list',
      args: { filter: { done: false } },
      since: 9,
    })
  })

  test('argless frames omit the args key entirely', () => {
    const entry = createWatchEntry('w2', 'list')

    expect(Object.keys(buildWatchFrame(entry))).toEqual(['event', 'id', 'fn'])
  })
})

describe('parseServerFrame', () => {
  test('accepts every server frame variant', () => {
    expect(parseServerFrame('{"type":"sync","id":"a","version":1,"rows":[]}')).not.toBeNull()
    expect(
      parseServerFrame(
        '{"type":"delta","id":"a","version":2,"added":[],"changed":[],"removed":[]}',
      ),
    ).not.toBeNull()
    expect(parseServerFrame('{"type":"reset","id":"a"}')).not.toBeNull()
    expect(
      parseServerFrame('{"type":"error","id":"a","error":"e","message":"m","requestId":"r"}'),
    ).not.toBeNull()
  })

  test('rejects malformed frames', () => {
    expect(parseServerFrame('not json')).toBeNull()
    expect(parseServerFrame('{"type":"sync"}')).toBeNull()
    expect(parseServerFrame('{"type":"nope","id":"a"}')).toBeNull()
    expect(parseServerFrame(123)).toBeNull()
  })
})

describe('wsUrl', () => {
  test('maps http(s) bases to ws(s) and appends the token', () => {
    expect(wsUrl('http://localhost:3000', '/todos/_realtime')).toBe(
      'ws://localhost:3000/todos/_realtime',
    )
    expect(wsUrl('https://api.example.com', '/todos/_realtime', 'se cret')).toBe(
      'wss://api.example.com/todos/_realtime?token=se%20cret',
    )
  })
})

interface FakeSocket {
  url: string
  sent: string[]
  readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  open: () => void
  receive: (frame: ServerFrame) => void
  drop: () => void
}

const fakeSockets = (): { sockets: FakeSocket[]; ctor: new (url: string) => WebSocket } => {
  const sockets: FakeSocket[] = []

  class Fake {
    url: string
    sent: string[] = []
    readyState = 0
    onopen: (() => void) | null = null
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: (() => void) | null = null
    onclose: (() => void) | null = null

    constructor(url: string) {
      this.url = url
      sockets.push(this as unknown as FakeSocket)
    }

    send(text: string) {
      this.sent.push(text)
    }

    close() {
      this.drop()
    }

    open() {
      this.readyState = 1
      this.onopen?.()
    }

    receive(frame: ServerFrame) {
      this.onmessage?.({ data: JSON.stringify(frame) })
    }

    drop() {
      this.readyState = 3
      this.onclose?.()
    }
  }

  return { sockets, ctor: Fake as unknown as new (url: string) => WebSocket }
}

const wait = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })

describe('createRealtimeEngine', () => {
  test('subscribes on open, resends with since on reconnect, resubscribes on reset', async () => {
    const { sockets, ctor } = fakeSockets()
    const rowUpdates: unknown[][] = []

    const engine = createRealtimeEngine({
      base: 'http://localhost:3000',
      path: '/todos/_realtime',
      token: () => 'tok',
      webSocket: ctor,
      reconnect: { retries: 3, delayMs: 1, maxDelayMs: 2 },
      onRows: (_id, rows) => rowUpdates.push([...rows]),
    })

    engine.connect()
    const id = engine.watch('list', { limit: 10 })

    const first = sockets[0] as FakeSocket

    expect(first.url).toBe('ws://localhost:3000/todos/_realtime?token=tok')

    first.open()

    // fresh watch → no since
    expect(JSON.parse(first.sent[0] as string)).toEqual({
      event: 'watch',
      id,
      fn: 'list',
      args: { limit: 10 },
    })

    first.receive({ type: 'sync', id, version: 4, rows: [{ _id: 'a' }] })

    expect(engine.rows(id)).toEqual([{ _id: 'a' }])
    expect(rowUpdates).toHaveLength(1)

    // drop the socket — the engine reconnects and resumes with since=4
    first.drop()
    await wait(10)

    const second = sockets[1] as FakeSocket

    second.open()

    expect(JSON.parse(second.sent[0] as string)).toEqual({
      event: 'watch',
      id,
      fn: 'list',
      args: { limit: 10 },
      since: 4,
    })

    // stale since → reset → resubscribe WITHOUT since
    second.receive({ type: 'reset', id })

    expect(JSON.parse(second.sent[1] as string)).toEqual({
      event: 'watch',
      id,
      fn: 'list',
      args: { limit: 10 },
    })

    engine.stop()

    expect(engine.status()).toBe('closed')
  })

  test('unwatch sends the unwatch frame and drops the entry', () => {
    const { sockets, ctor } = fakeSockets()
    const engine = createRealtimeEngine({
      base: 'http://x',
      path: '/p',
      webSocket: ctor,
    })

    engine.connect()

    const socket = sockets[0] as FakeSocket

    socket.open()

    const id = engine.watch('list')

    engine.unwatch(id)

    expect(JSON.parse(socket.sent[1] as string)).toEqual({ event: 'unwatch', id })
    expect(engine.entry(id)).toBeUndefined()

    engine.stop()
  })
})
