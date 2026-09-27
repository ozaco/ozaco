/**
 * What each adapter / store reports as its telemetry identity (`db.system.name`, `db.namespace`,
 * `server.*`) — read from the install contexts, no server needed (the drivers connect lazily).
 */
import { DbAdapter, Kv } from 'db:core'
import { adapterIdentity, dbSystemOf } from 'db:internal'
import { run, useContext } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryAdapter } from 'db:impl/memory'
import { MemoryKv } from 'db:impl/memory-kv'
import { PgAdapter } from 'db:impl/pg'
import { RedisKv, redisKvImpl } from 'db:impl/redis-kv'
import { SqliteAdapter } from 'db:impl/sqlite'
import { TableKv } from 'db:impl/table-kv'

describe('adapter identity', () => {
  it('memory, sqlite (file basename / :memory:) and pg (database, host, port)', async () => {
    unwrap(
      await run(function* () {
        yield* MemoryAdapter.use()
        expect(adapterIdentity(yield* useContext(DbAdapter))).toEqual({
          system: 'ozaco.memory',
          namespace: 'memory',
          kind: 'internal',
          address: undefined,
          port: undefined,
        })

        yield* SqliteAdapter.use({ path: join(mkdtempSync(join(tmpdir(), 'ozaco-id-')), 'a.db') })
        expect((yield* useContext(DbAdapter)).telemetry).toEqual({
          system: 'sqlite',
          namespace: 'a.db',
        })
        yield* SqliteAdapter.use()
        expect((yield* useContext(DbAdapter)).telemetry?.namespace).toBe(':memory:')

        yield* PgAdapter.use({ url: 'postgres://app:secret@db.internal:6543/orders?sslmode=off' })
        expect(adapterIdentity(yield* useContext(DbAdapter))).toEqual({
          system: 'postgresql',
          namespace: 'orders',
          kind: 'client',
          address: 'db.internal',
          port: 6543,
        })

        // no database in the URL: Postgres' own default, the user name; the default port
        yield* PgAdapter.use({ url: 'postgres://app@[::1]' })
        expect((yield* useContext(DbAdapter)).telemetry).toEqual({
          system: 'postgresql',
          namespace: 'app',
          address: '::1',
          port: 5432,
        })
      }),
    )
  })

  it('an adapter without telemetry: the name implies the system, the name is the namespace', () => {
    expect(dbSystemOf('bun-sql')).toBe('postgresql')
    expect(dbSystemOf('surreal')).toBe('surreal')
    expect(
      adapterIdentity({
        adapter: 'surreal',
        capabilities: { transactions: true, raw: false, alterColumn: false },
      }),
    ).toMatchObject({ system: 'surreal', namespace: 'surreal', kind: 'client' })
  })
})

describe('kv store identity', () => {
  it('memory: ozaco.memory over the prefix; table: the backing database, the table', async () => {
    unwrap(
      await run(function* () {
        yield* MemoryKv.use({ prefix: 'cache' })
        expect((yield* useContext(Kv)).telemetry).toEqual({
          system: 'ozaco.memory',
          namespace: 'memory',
          collection: 'cache',
        })

        yield* SqliteAdapter.use({ path: join(mkdtempSync(join(tmpdir(), 'ozaco-id-')), 'kv.db') })
        yield* TableKv.use({ prefix: 'app', table: 'entries' })
        expect((yield* useContext(Kv)).telemetry).toEqual({
          system: 'sqlite',
          namespace: 'kv.db',
          collection: 'entries',
          address: undefined,
          port: undefined,
        })
      }),
    )
  })

  it('redis: the database index, host and port from the URL', async () => {
    const fake = {
      on() {},
      connect: async () => {},
      quit: async () => {},
      withTypeMapping() {
        return fake
      },
    }

    unwrap(
      await run(function* () {
        yield* redisKvImpl.set({ createClient: () => fake as AnyType })
        yield* RedisKv.use({ prefix: 'sessions', url: 'redis://cache.internal:6380/3' })
        expect((yield* useContext(Kv)).telemetry).toEqual({
          system: 'redis',
          namespace: '3',
          collection: 'sessions',
          address: 'cache.internal',
          port: 6380,
        })

        yield* RedisKv.use({ prefix: 'x', url: 'redis://localhost' })
        expect((yield* useContext(Kv)).telemetry).toMatchObject({
          namespace: '0',
          address: 'localhost',
          port: 6379,
        })
      }),
    )
  })
})
