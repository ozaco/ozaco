/**
 * Graceful-shutdown fixture: builds the FULL reactive stack (adapter + DbClient + parked watchers
 * + a connected bus with its forked bridge + a live-feed pump), lets every scope close, and then
 * relies on the process exiting NATURALLY. If any plugin leaks a handle or a forked pump survives
 * its scope, this process hangs and the lifecycle test times out. Prints `all-done` last.
 */
import { column, Db, DbBus, DbClient, table } from 'db:core'
import type { Operation } from 'std:effect'
import { run, scoped } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { MemoryAdapter } from 'db:impl/memory'
import { SqliteAdapter } from 'db:impl/sqlite'
import { BunIO } from 'std:io/impl/bun'
import { MemoryTransport } from 'transport:impl/memory'

const items = table('items', { name: column.text() })

const exercise = function* (): Operation<void> {
  yield* install(BunIO)
  const db = yield* install(DbClient, { tables: [items] })
  // park every kind of subscription, then let the scope close over them
  yield* db.changes('items')
  const snaps = yield* db.query('items').watch()
  yield* snaps.next()
  yield* install(MemoryTransport, { prefix: 'shutdown' })
  yield* install(DbBus)
  yield* Db.actions.bridge()
  const created = yield* db.insert('items', { name: 'x' })
  yield* db.watch('items', String((created as AnyType)._id))
}

const phase = async (label: string, body: () => Operation<void>): Promise<void> => {
  const outcome = await run(() => scoped(body))
  unwrap(outcome)
  console.log(`${label}-done`)
}

await phase('memory', function* () {
  yield* install(MemoryAdapter)
  yield* exercise()
})

await phase('sqlite', function* () {
  yield* install(SqliteAdapter)
  yield* exercise()
})

console.log('all-done')
