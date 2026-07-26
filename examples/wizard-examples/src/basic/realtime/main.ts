import { Pool } from 'db:core'
import { table, RealtimeDb } from 'db:realtime'
import { Broker, DataType, DefaultBroker, Gateway } from 'server:core'
import { resource } from 'server:wizard'
import { main, sleep } from 'std:effect'
import { DefaultLogger, Logger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'
import type { AnyType } from 'std:shared'

import { createClient } from '@ozaco/client'
import { SqliteDriver } from 'db:impl/sqlite'
import { BunGateway } from 'server:gateway/bun'
import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'
import { z } from 'zod'

/**
 * The smallest realtime example: watch a collection and rows arrive live.
 *
 * `list` returns a page as a one-shot, but `.watch(...)` emits row DELTAS — a `sync` frame with the
 * current window, then `added`/`modified`/`removed` as the data changes. The client picks the
 * transport itself (WebSocket here); you never configure it.
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
  yield* install(SqliteDriver)
  yield* install(Pool, { connectionUri: ':memory:' })
  yield* install(RealtimeDb, { tables: [notes] })
  yield* noteResource.actions.install()
  yield* Broker.actions.start()
  yield* Gateway.actions.start({ port: 4577, host: '127.0.0.1' })

  let last: AnyType

  for (let i = 1; i <= 100; i++) {
    if (i === 24) {
      last = yield* Broker.actions.call(noteResource, 'create', [
        { type: DataType.normal, value: { title: `original-${i}` } },
      ])
    } else {
      yield* Broker.actions.call(noteResource, 'create', [
        { type: DataType.normal, value: { title: `original-${i}` } },
      ])
    }
  }

  yield* Logger.actions.info('finished')

  const client = createClient<Api>({
    url: 'http://localhost:4577',
    meta: {
      notes: {
        realtime: 'sse',
      },
    },
  })
  const stop = yield* client.notes.list.watch({}, delta => {
    console.log(delta)

    if (delta.type === 'sync') {
      console.log('sync:', delta.data.map(note => note.title).join(', ') || '(empty)')
    } else if (delta.type === 'removed') {
      console.log('removed:', delta.id)
    } else {
      console.log(`${delta.type}:`, delta.row.title)
    }
  })

  // create + update a few notes — the watcher sees each change live
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
})
