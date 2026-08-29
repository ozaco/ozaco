import { Db, DbBus, DbClient } from 'db:core'
import type { Operation } from 'std:effect'
import { createQueue, fork, race, run, scoped, sleep, useContext } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SqliteAdapter } from 'db:impl/sqlite'
import { BunIO } from 'std:io/impl/bun'
import type { TransportDef } from 'transport:core'
import { NatsTransport } from 'transport:impl/nats'
import { RedisTransport } from 'transport:impl/redis'

import { users } from './helpers'

/**
 * The bus over REAL brokers: two sqlite nodes on one file hear each other through NATS
 * (JetStream) or Redis — envelopes round-trip the codec, the transport prefix and the broker.
 * Set TRANSPORT_TEST_NATS_URL / TRANSPORT_TEST_REDIS_URL, or `moon run db:test-bus`.
 */

interface Network {
  readonly label: string
  readonly url: string | undefined
  readonly transport: () => Operation<TransportDef.Options>
}

const nats = process.env.TRANSPORT_TEST_NATS_URL
const redis = process.env.TRANSPORT_TEST_REDIS_URL
const prefix = `dbbus.${crypto.randomUUID().slice(0, 8)}`

const networks: Network[] = [
  {
    label: 'nats',
    url: nats,
    transport: () => install(NatsTransport, { prefix, servers: nats!, storage: 'memory' }),
  },
  {
    label: 'redis',
    url: redis,
    transport: () => install(RedisTransport, { prefix, url: redis! }),
  },
]

for (const network of networks) {
  describe.skipIf(!network.url)(`bus over ${network.label}`, () => {
    it('a write on one node wakes the watchers of another; stats see the peer', async () => {
      const dir = mkdtempSync(join(tmpdir(), `ozaco-db-bus-${network.label}-`))
      const path = join(dir, 'shared.sqlite')
      const nodeOf = function* (origin: string): Operation<AnyType> {
        yield* install(SqliteAdapter, { path })
        yield* install(BunIO)
        yield* network.transport()
        yield* install(DbBus)
        return yield* install(DbClient, { tables: [users], origin })
      }
      try {
        unwrap(
          await run(function* () {
            const ready = createQueue<void, void>()
            const listener = yield* fork(() =>
              scoped(function* () {
                const db = yield* nodeOf('NDEB0002')
                const feed = yield* db.changes('users')
                const snaps = yield* db.query('users').watch()
                yield* snaps.next()
                ready.add(undefined)
                const event = yield* race([
                  feed.next(),
                  (function* () {
                    yield* sleep(5000)
                    return { done: true as const, value: undefined }
                  })(),
                ])
                expect((event as AnyType).done).toBe(false)
                expect(['bus', 'replay']).toContain((event as AnyType).value.source)
                expect((event as AnyType).value.token.endsWith('NDEA0001')).toBe(true)
                const snap = yield* snaps.next()
                const stats = yield* Db.actions.busStats()
                expect(stats.received).toBeGreaterThan(0)
                expect(stats.peers.NDEA0001).toBeDefined()
                return (snap.value as AnyType).rows.map((row: AnyType) => row.name)
              }),
            )
            yield* ready.next()
            yield* scoped(function* () {
              const db = yield* nodeOf('NDEA0001')
              expect((yield* useContext(DbBus)).transportName).toBe(network.label)
              yield* db.insert('users', { name: `over-${network.label}` })
              // let the outbox ship before this node's transport closes with the scope
              yield* sleep(200)
              expect((yield* Db.actions.busStats()).published).toBe(1)
            })
            expect(yield* listener).toEqual([`over-${network.label}`])
          }),
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
}

describe.skipIf(!(nats && redis))('bus pinned to one of two installed transports', () => {
  it('ships through the pinned transport even when another was installed later', async () => {
    unwrap(
      await run(function* () {
        yield* install(RedisTransport, { prefix, url: redis! })
        yield* install(NatsTransport, { prefix, servers: nats!, storage: 'memory' })
        // routed calls now hit NATS (most recent) — the bus is told to use Redis instead
        yield* install(DbBus, { transport: RedisTransport })
        expect((yield* useContext(DbBus)).transportName).toBe('redis')
        const onRedis = yield* RedisTransport.actions.subscribe<AnyType>('db.change')
        const onNats = yield* NatsTransport.actions.subscribe<AnyType>('db.change')
        yield* sleep(50)
        yield* DbBus.actions.publish({ origin: 'NDEA0001', seq: 1, tx: 'T', events: [] })
        expect(((yield* onRedis.next()) as AnyType).value.value.seq).toBe(1)
        const silent = yield* race([
          onNats.next(),
          (function* () {
            yield* sleep(300)
            return { done: true as const, value: undefined }
          })(),
        ])
        expect((silent as AnyType).done).toBe(true)
      }),
    )
  })
})
