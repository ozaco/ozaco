import { Db, DbClient } from 'db:core'
import type { Operation } from 'std:effect'
import { install } from 'std:plugin'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunSqlAdapter } from 'db:impl/bun-sql'
import { PgAdapter } from 'db:impl/pg'

import { runScoped, users } from '../helpers'

import { runAdapterSuite } from './helpers'

/** Set DB_TEST_PG_URL (e.g. postgres://localhost/ozaco_test) to run these against a live server.
 * The suite drops and recreates its tables on every test. */
const url = process.env.DB_TEST_PG_URL

runAdapterSuite({
  label: 'pg',
  enabled: Boolean(url),
  live: true,
  raw: true,
  install: () => install(PgAdapter, { url: url! }),
})

runAdapterSuite({
  label: 'bun-sql',
  enabled: Boolean(url),
  live: false,
  raw: true,
  install: () => install(BunSqlAdapter, { url: url! }),
})

describe.skipIf(!url)('pg live resilience', () => {
  const bootstrap = function* (): Operation<AnyType> {
    // a tight redial budget keeps the reconnect test fast
    yield* install(PgAdapter, { url: url!, live: { delayMs: 50, retries: 10 } })
    const db = yield* install(DbClient, { tables: [users], migrations: 'manual' })
    yield* Db.actions.dropTable('users')
    yield* Db.actions.migrate()
    return db
  }

  it('redials a dropped listener and heals watchers with a catch-up touch', async () => {
    await runScoped(function* () {
      const db = yield* bootstrap()
      yield* db.insert('users', { name: 'ada', age: 1 })
      const snaps = yield* db.query('users').watch()
      yield* snaps.next()

      // kill the dedicated listener backend server-side
      yield* Db.actions.raw(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query = 'LISTEN ozaco_changes'",
      )
      // the successful redial synthesizes a table-level touch — the watcher re-reads
      const healed = yield* snaps.next()
      expect((healed.value as AnyType).rows[0].name).toBe('ada')

      // …and the NEW listener keeps reporting external (out-of-band) writes
      yield* Db.actions.raw('UPDATE "users" SET "age" = 42')
      const after = yield* snaps.next()
      expect((after.value as AnyType).rows[0].age).toBe(42)
    })
  }, 10_000)

  it('oversized NOTIFY payloads fall back to d:null and doc watchers re-fetch', async () => {
    await runScoped(function* () {
      const db = yield* bootstrap()
      const feed = yield* db.changes('users')
      const created = yield* db.insert('users', { name: 'ada' })
      const id = String(created._id)
      // consume the insert notification first, so the doc watcher below only sees the patch
      const insertEvent = yield* feed.next()
      expect((insertEvent.value as AnyType).op).toBe('insert')

      const docFeed = yield* db.watch('users', id)
      yield* docFeed.next()

      const huge = { blob: 'x'.repeat(20_000) }
      yield* db.patch('users', id, { meta: huge })

      const event = yield* feed.next()
      expect((event.value as AnyType).op).toBe('update')
      expect((event.value as AnyType).doc).toBeNull()

      const refreshed = yield* docFeed.next()
      expect((refreshed.value as AnyType).meta).toEqual(huge)
    })
  })
})
