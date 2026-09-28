/**
 * Bus meta reaches the change feed (`Change.Event.meta` — how a consumer links the writer), and the
 * hub's operational problems (gaps, a peer clock running ahead) are logged through the Logger.
 */
import type { Change, Schema } from 'db:core'
import { column, Db, DbBus, DbClient, table, withBusMeta } from 'db:core'
import type { Operation } from 'std:effect'
import { all, fork, run, scoped, sleep, suspend, withResolvers } from 'std:effect'
import { IO } from 'std:io'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import { Trace } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { MemoryAdapter } from 'db:impl/memory'
import { BunIO } from 'std:io/impl/bun'
import { Transport } from 'transport:core'
import { createLink, MemoryTransport } from 'transport:impl/memory'

import { users } from '../helpers'

import { captureLogs } from './helpers'

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

/** An HLC token of `origin` minted by a clock `aheadMs` in the future: Crockford(ms, 10) +
 * counter(4) + origin(8). */
const tokenAhead = (aheadMs: number, origin: string): string => {
  const encode = (value: number, length: number) => {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    let out = ''
    let rest = value

    for (let index = 0; index < length; index += 1) {
      out = alphabet[rest % 32]! + out
      rest = Math.floor(rest / 32)
    }

    return out
  }

  return `${encode(Date.now() + aheadMs, 10)}${encode(1, 4)}${origin}`
}

/** An exporter's own store: every table `log: false`. */
const quiet = table('quiet', { note: column.text() }, { log: false })

/**
 * Boot in-process nodes over one shared link — each its own transport, bus and client (of
 * `tables`, its telemetry `suppressed` if asked) — let a never-heard peer `origin` publish one
 * envelope, and answer the log lines about that peer once every hub applied it.
 */
const announcements = async (
  origin: string,
  nodes: readonly { tables: readonly Schema.Table[]; suppressed?: boolean }[],
) =>
  unwrap(
    await run(function* () {
      const logs = yield* captureLogs()

      yield* BunIO.use()

      const link = createLink()

      // `heard` settles once the node's hub applied the envelope (any line is logged before)
      const node = function* (options: (typeof nodes)[number]): Operation<Operation<void>> {
        const up = withResolvers<void>('node up')
        const heard = withResolvers<void>('node heard')

        const body = function* (): Operation<void> {
          yield* MemoryAdapter.use()
          yield* MemoryTransport.use({ prefix: 'app', link })
          yield* DbBus.use()

          const db = (yield* DbClient.use({ tables: options.tables })) as AnyType
          const feed = yield* db.changes()

          up.resolve()
          yield* feed.next()
          heard.resolve()
          yield* suspend()
        }

        yield* fork(() =>
          scoped(() => (options.suppressed ? Trace.actions.suppressed(body) : body())),
        )
        yield* up.operation

        return heard.operation
      }

      const heard: Operation<void>[] = []

      for (const options of nodes) {
        heard.push(yield* node(options))
      }

      yield* scoped(function* () {
        yield* MemoryTransport.use({ prefix: 'app', link })

        const token = yield* IO.actions.hlc({ origin })

        yield* Transport.actions.publish('db.change', {
          origin,
          seq: 1,
          tx: token,
          events: [{ table: 'users', id: 'r1', op: 'insert', token }],
        })
      })
      yield* all(heard)
      yield* sleep(5)

      return logs.filter(entry => entry.data?.['ozaco.db.bus.origin'] === origin)
    }),
  )

describe('bus meta on the change feed', () => {
  it('a local write carries the correlation data it ran under (string values only)', async () => {
    unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* MemoryAdapter.use()

        const db = (yield* DbClient.use({ tables: [users] })) as AnyType
        const feed = yield* db.changes('users')

        yield* withBusMeta({ traceparent: TRACEPARENT, tracestate: 'ozaco=1', hops: 2 }, () =>
          db.insert('users', { name: 'ada' }),
        )

        const traced = (yield* feed.next()).value as Change.Event

        expect(traced.source).toBe('local')
        expect(traced.meta).toEqual({ traceparent: TRACEPARENT, tracestate: 'ozaco=1' })

        // inside a transaction: the committed batch carries it too
        yield* withBusMeta({ traceparent: TRACEPARENT }, () =>
          db.transaction(function* (tx: AnyType) {
            yield* tx.insert('users', { name: 'bob' })
          }),
        )
        expect(((yield* feed.next()).value as Change.Event).meta).toEqual({
          traceparent: TRACEPARENT,
        })

        yield* db.insert('users', { name: 'cy' })
        expect(((yield* feed.next()).value as Change.Event).meta).toBeUndefined()
      }),
    )
  })

  it('a foreign envelope’s meta reaches its events', async () => {
    unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* MemoryAdapter.use()
        yield* MemoryTransport.use({ prefix: 'app' })
        yield* DbBus.use()

        const db = (yield* DbClient.use({ tables: [users] })) as AnyType
        const feed = yield* db.changes('users')
        const token = yield* Db.actions.version()

        yield* Transport.actions.publish('db.change', {
          origin: 'NDEA0001',
          seq: 1,
          tx: token,
          events: [{ table: 'users', id: 'remote-1', op: 'insert', token }],
          meta: { traceparent: TRACEPARENT, attempt: 1 },
        })

        const event = (yield* feed.next()).value as Change.Event

        expect(event.source).toBe('bus')
        expect(event.id).toBe('remote-1')
        expect(event.meta).toEqual({ traceparent: TRACEPARENT })
      }),
    )
  })
})

describe('hub operational logging', () => {
  it('a new peer is INFO, lost envelopes and a clock ahead are WARN — logger @ozaco/db', async () => {
    const entries = unwrap(
      await run(function* () {
        const logs = yield* captureLogs()

        yield* BunIO.use()
        yield* MemoryAdapter.use()
        yield* MemoryTransport.use({ prefix: 'app' })
        yield* DbBus.use()

        const db = (yield* DbClient.use({ tables: [users] })) as AnyType
        const feed = yield* db.changes('users')
        const envelope = function* (seq: number) {
          const token = yield* Db.actions.version()

          return {
            origin: 'NDEA0001',
            seq,
            tx: token,
            events: [{ table: 'users', id: `r${seq}`, op: 'insert', token }],
          }
        }

        yield* Transport.actions.publish('db.change', yield* envelope(1))
        yield* feed.next()
        yield* Transport.actions.publish('db.change', yield* envelope(4))
        yield* feed.next()

        const ahead = tokenAhead(10 * 60 * 1000, 'NDEA0001')

        yield* Transport.actions.publish('db.change', {
          origin: 'NDEA0001',
          seq: 5,
          tx: ahead,
          events: [{ table: 'users', id: 'future', op: 'insert', token: ahead }],
        })
        yield* feed.next()
        // the drift line is written right after the envelope's events were applied
        yield* sleep(5)

        return logs
      }),
    )

    const hub = entries.filter(entry => entry.bindings.logger === '@ozaco/db')

    expect(hub.map(entry => [entry.level, entry.msg])).toEqual([
      [30, 'db bus: first envelope from a peer — replaying the change logs'],
      [40, 'db bus: envelopes lost — replaying the change logs'],
      [40, "db bus: peer tokens too far ahead — this node's clock kept its own"],
    ])
    expect(hub[0]!.data).toEqual({ 'ozaco.db.bus.origin': 'NDEA0001', 'ozaco.db.bus.seq': 1 })
    expect(hub[1]!.data).toEqual({
      'ozaco.db.bus.origin': 'NDEA0001',
      'ozaco.db.bus.expected_seq': 2,
      'ozaco.db.bus.seq': 4,
    })
    expect(hub[2]!.data).toEqual({ 'ozaco.db.bus.origin': 'NDEA0001', 'ozaco.db.bus.rejected': 1 })
  })

  it('a new peer is announced ONCE per process, however many hubs meet it', async () => {
    const entries = await announcements('NDEC0003', [
      { tables: [users] },
      { tables: [users] },
      { tables: [users] },
    ])

    // three hubs met the peer; one line says so
    expect(entries.map(entry => [entry.level, entry.msg, entry.bindings.logger])).toEqual([
      [30, 'db bus: first envelope from a peer — replaying the change logs', '@ozaco/db'],
    ])
  })

  it('a client without change logs and suppressed work (an exporter’s store) say nothing', async () => {
    const entries = await announcements('NDED0004', [
      { tables: [quiet] },
      { tables: [users], suppressed: true },
    ])

    expect(entries).toEqual([])

    // and neither took the announcement from a hub that can make it
    const later = await announcements('NDEE0005', [
      { tables: [quiet] },
      { tables: [users], suppressed: true },
      { tables: [users] },
    ])

    expect(later.map(entry => entry.msg)).toEqual([
      'db bus: first envelope from a peer — replaying the change logs',
    ])
  })

  it('without a Logger nothing is logged and nothing fails', async () => {
    unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* MemoryAdapter.use()
        yield* MemoryTransport.use({ prefix: 'app' })
        yield* DbBus.use()

        const db = (yield* DbClient.use({ tables: [users] })) as AnyType
        const feed = yield* db.changes('users')
        const token = yield* Db.actions.version()

        yield* Transport.actions.publish('db.change', {
          origin: 'NDEA0002',
          seq: 7,
          tx: token,
          events: [{ table: 'users', id: 'r7', op: 'insert', token }],
        })
        expect(((yield* feed.next()).value as Change.Event).id).toBe('r7')
      }),
    )
  })
})
