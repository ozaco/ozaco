import { Pool } from 'db:core'
import { RealtimeDb, table, useDatabase } from 'db:realtime'
import { Broker, DataType, DefaultBroker } from 'server:core'
import { doc, mutation, query, resource } from 'server:wizard'
import { main } from 'std:effect'
import { DefaultLogger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'

import { SqliteDriver } from 'db:impl/sqlite'
import { BunGateway } from 'server:gateway/bun'
import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'
import { z } from 'zod'

/**
 * A resource built from CUSTOM functions instead of `defineCrud`: a `mutation` (writes, validated by
 * `args`) and a `query` (reads, shaped by a `returns` validator → a precise client type). Both are
 * effect-native generators — `yield* useDatabase([counters])` types the handle to just this table, and
 * the whole handler runs in the action's scope. `resource('metrics', { … })` groups them under
 * `/metrics/*` with no backing table of its own.
 */
const counters = table('counters', {
  name: z.string().min(1),
  value: z.number().int().default(0),
})

// custom mutation: bump a named counter (create it on first touch)
const bump = mutation({
  args: z.object({ name: z.string(), by: z.number().int().default(1) }),
  returns: doc(counters),
  *handler(body) {
    const db = yield* useDatabase([counters])
    const existing = yield* db.query('counters').where({ name: body.name }).first()
    if (existing) {
      return yield* db.patch('counters', existing._id, { value: existing.value + body.by })
    }
    return yield* db.insert('counters', { name: body.name, value: body.by })
  },
})

// custom query: a derived summary — `returns` feeds validation and OpenAPI output metadata
const total = query({
  returns: z.object({ counters: z.number(), sum: z.number() }),
  *handler() {
    const db = yield* useDatabase([counters])
    const all = yield* db.query('counters').collect()
    return { counters: all.length, sum: all.reduce((acc, counter) => acc + counter.value, 0) }
  },
})

const metrics = resource('metrics', { bump, total })

await main(function* () {
  yield* install(BunIO)
  yield* install(DefaultLogger, { level: LogLevel.warn })
  yield* install(ConsoleTransport)
  yield* install(DefaultBroker)
  yield* install(BunGateway, {})
  yield* install(SqliteDriver)
  yield* install(Pool, { connectionUri: ':memory:' })
  yield* install(RealtimeDb, { tables: [counters] })
  yield* metrics.actions.install()
  yield* Broker.actions.start()

  yield* Broker.actions.call(metrics, 'bump', [
    { type: DataType.normal, value: { name: 'signups' } },
  ])
  yield* Broker.actions.call(metrics, 'bump', [
    { type: DataType.normal, value: { name: 'signups', by: 4 } },
  ])
  yield* Broker.actions.call(metrics, 'bump', [
    { type: DataType.normal, value: { name: 'logins', by: 2 } },
  ])
  const summary = yield* Broker.actions.call(metrics, 'total', [])
  console.log('metrics:', summary.counters, 'counters, sum', summary.sum)
})
