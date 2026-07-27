import { describe, expect, it } from 'bun:test'

import { Pool, usePool } from '@ozaco/db'
import { SurrealDriver } from '@ozaco/db/impl/surreal'
import { RealtimeDb, table, useDatabase } from '@ozaco/db/realtime'
import { run } from '@ozaco/std/effect'
import { BunIO } from '@ozaco/std/io/impl/bun'
import { DefaultLogger, LogLevel } from '@ozaco/std/logger'
import { install } from '@ozaco/std/plugin'
import { isSuccess } from '@ozaco/std/result'
import { z } from 'zod'

// The embedded engines (`mem://`, `surrealkv://`) auto-create namespace/database even on v3, so
// they can never reproduce the remote-only failure this suite guards against: a SurrealDB 3.x
// SERVER rejects `use` of a namespace that does not exist yet. Opt in with a throwaway server:
//
//   docker run --rm -p 8000:8000 surrealdb/surrealdb:v3 start --user root --pass root
//   SURREAL_TEST_URL=ws://localhost:8000 bun test tests/surreal-remote.test.ts
const SURREAL_URL = process.env.SURREAL_TEST_URL
const auth = {
  username: process.env.SURREAL_TEST_USER ?? 'root',
  password: process.env.SURREAL_TEST_PASS ?? 'root',
}

describe.skipIf(!SURREAL_URL)('SurrealDriver against a remote server', () => {
  it('auto-defines a fresh namespace/database on connect and round-trips a row', async () => {
    // a random namespace per run: the point is `use` of a pair the server has NEVER seen
    const namespace = `ozaco_test_${Math.random().toString(36).slice(2, 10)}`
    const notes = table('notes', { title: z.string() })

    const result = await run(function* () {
      yield* install(BunIO)
      yield* install(DefaultLogger, { level: LogLevel.silent })
      yield* install(SurrealDriver, { namespace, database: 'driver_smoke', auth })
      yield* install(Pool, { connectionUri: SURREAL_URL! })
      yield* install(RealtimeDb, { tables: [notes] })

      const db = yield* useDatabase([notes])
      const created = yield* db.insert('notes', { title: 'remote smoke' })
      const fetched = yield* db.get('notes', created._id)
      yield* (yield* usePool()).end()
      return fetched?.title
    })

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toBe('remote smoke')
    }
  })
})
