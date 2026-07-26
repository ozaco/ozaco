import { Pool, usePool } from 'db:core'
import { table, RealtimeDb } from 'db:realtime'
import { Broker, DataType, DefaultBroker, Gateway } from 'server:core'
import { resource } from 'server:wizard'
import { main, sleep } from 'std:effect'
import { DefaultLogger, Logger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'
import type { AnyType } from 'std:shared'

import { createClient } from '@ozaco/client'
import { SurrealDriver } from 'db:impl/surreal'
import { BunGateway } from 'server:gateway/bun'
import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'
import { z } from 'zod'

/**
 * The SurrealDB twin of `basic/realtime`. Byte-for-byte the same script, with ONE line changed: the
 * SQLite driver is swapped for the embedded SurrealDB one (`SurrealDriver` + `mem://`). It is the A/B
 * test for "does the realtime layer work directly on SurrealDB?".
 *
 * VERIFIED (2026-07-23): YES — it prints the same live delta stream as the SQLite example
 * (`sync` → `added`/`modified`/`removed`). Making it work took a SurrealQL dialect branch in the DB
 * layer (`db/realtime/impl/{migrate,database}.ts` + `db/impl/surreal.ts`): `DEFINE TABLE … SCHEMALESS`
 * instead of `CREATE TABLE`, backtick identifiers, no `RETURNING *`, `count() … GROUP ALL`,
 * `DELETE … RETURN BEFORE`, and — crucially — the surreal driver now shares ONE client across the pool
 * (an embedded `mem://` database is scoped to its client, so a per-connection client would be a fresh
 * empty DB every time).
 *
 * NOTE: the embedded `@surrealdb/node` engine must be shut down before the process exits (Bun panics
 * unloading a still-open native engine), so the demo closes the pool at the end.
 */
const notes = table('notes', { title: z.string(), done: z.boolean().default(false) })
const noteResource = resource(notes, { type: 'crud', realtime: 'sse' })

type Note = { title: string; done: boolean }
type Delta =
  | { type: 'sync'; data: Note[] }
  | { type: 'added' | 'modified'; row: Note }
  | { type: 'removed'; id: string }

type Api = {
  notes: { list: { kind: 'query'; args: { limit?: number }; result: unknown; emits: Delta } }
}

await main(function* () {
  yield* install(BunIO)
  yield* install(DefaultLogger, { level: LogLevel.debug })
  yield* install(ConsoleTransport)
  yield* install(DefaultBroker)
  yield* install(BunGateway, {})
  // The ONLY difference from `basic/realtime`: an embedded SurrealDB instead of in-memory SQLite.
  yield* install(SurrealDriver, { namespace: 'demo', database: 'demo' })
  yield* install(Pool, { connectionUri: 'mem://' })
  yield* install(RealtimeDb, { tables: [notes] })
  yield* noteResource.actions.install()
  yield* Broker.actions.start()
  yield* Gateway.actions.start({ port: 4578, host: '127.0.0.1' })

  let last: AnyType

  for (let i = 1; i <= 10; i++) {
    if (i === 4) {
      last = yield* Broker.actions.call(noteResource, 'create', [
        { type: DataType.normal, value: { title: `original-${i}` } },
      ])
    } else {
      yield* Broker.actions.call(noteResource, 'create', [
        { type: DataType.normal, value: { title: `original-${i}` } },
      ])
    }
  }

  yield* Logger.actions.info('finished seeding')

  const client = createClient<Api>({
    url: 'http://localhost:4578',
    meta: {
      notes: {
        realtime: 'sse',
      },
    },
  })
  const stop = yield* client.notes.list.watch({}, delta => {
    if (delta.type === 'sync') {
      console.log('sync:', delta.data.map(note => note.title).join(', ') || '(empty)')
    } else if (delta.type === 'removed') {
      console.log('removed:', delta.id)
    } else {
      console.log(`${delta.type}:`, delta.row.title)
    }
  })

  // create + update a few notes — the watcher should see each change live
  yield* sleep(200)
  const first = yield* Broker.actions.call(noteResource, 'create', [
    { type: DataType.normal, value: { title: 'write docs' } },
  ])
  yield* Broker.actions.call(noteResource, 'create', [
    { type: DataType.normal, value: { title: 'ship it' } },
  ])
  yield* Broker.actions.call(noteResource, 'update', [
    { type: DataType.normal, value: { id: first._id, done: true } },
  ])
  yield* Broker.actions.call(noteResource, 'update', [
    { type: DataType.normal, value: { id: last._id, done: true } },
  ])
  yield* sleep(400)

  yield* stop()
  yield* Gateway.actions.destroy()
  // Close the pool explicitly so the shared embedded SurrealDB client shuts down cleanly. Skipping
  // this leaves the native engine open at process exit, and Bun panics unloading it.
  yield* (yield* usePool()).end()
})
