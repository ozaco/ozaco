/**
 * Graceful-shutdown fixture: builds the FULL reactive stack (adapter + DbClient + parked watchers
 * + a connected bus with its forked bridge + a live-feed pump), lets every scope close, and then
 * relies on the process exiting NATURALLY. If any plugin leaks a handle or a forked pump survives
 * its scope, this process hangs and the lifecycle test times out. Prints `all-done` last.
 */
import type { AdapterDef, BusEvent, LiveChange } from 'db:core'
import { adapterDefaults, column, Db, DbAdapter, DbClient, table } from 'db:core'
import type { Operation } from 'std:effect'
import { createChannel, createSignal, operation, run, scoped } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { MemoryAdapter } from 'db:impl/memory'
import { SqliteAdapter } from 'db:impl/sqlite'

const items = table('items', { name: column.text() })

const busOf = (origin: string) => ({
  origin,
  publish: operation(function* () {}),
  events: createSignal<BusEvent, never>(),
})

const exercise = function* (): Operation<void> {
  const db = yield* install(DbClient, { tables: [items] })
  // park every kind of subscription, then let the scope close over them
  yield* db.changes('items')
  const snaps = yield* db.query('items').watch()
  yield* snaps.next()
  yield* Db.actions.connectBus(busOf('node-fixture'))
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

// a live-capable adapter: its forked feed pump must also die with the scope
const liveChannel = createChannel<LiveChange, void>()
const LiveAdapter = DbAdapter.implement<AdapterDef.Info, []>({
  name: 'fixture-live',
  version: '0.0.0',
  *setup() {
    return {
      adapter: 'fixture-live',
      capabilities: { transactions: false, live: true, raw: false },
    }
  },
}).build({
  ...adapterDefaults('fixture-live'),
  find: operation(function* () {
    return []
  }),
  count: operation(function* () {
    return 0
  }),
  insert: operation(function* (_table: AnyType, rows: AnyType) {
    return rows
  }),
  update: operation(function* () {
    return []
  }),
  remove: operation(function* () {
    return []
  }),
  introspect: operation(function* () {
    return { columns: [] }
  }),
  migrate: operation(function* () {}),
  live: operation(function* () {
    return liveChannel
  }),
})

await phase('live', function* () {
  yield* install(LiveAdapter)
  const db = yield* install(DbClient, { tables: [items] })
  const feed = yield* db.changes('items')
  yield* liveChannel.send({ table: 'items', id: 'ext', op: 'insert', doc: { _id: 'ext' } })
  yield* feed.next()
})

console.log('all-done')
