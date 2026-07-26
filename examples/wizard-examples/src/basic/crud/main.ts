import { Pool } from 'db:core'
import { RealtimeDb, table } from 'db:realtime'
import { Broker, DataType, DefaultBroker } from 'server:core'
import { resource } from 'server:wizard'
import { main } from 'std:effect'
import { DefaultLogger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'

import { SqliteDriver } from 'db:impl/sqlite'
import { BunGateway } from 'server:gateway/bun'
import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'
import { z } from 'zod'

/**
 * The smallest wizard resource: ONE table declared as `type: 'crud'`. That generates the standard
 * REST collection (spec §0.1) — `GET /notes` (cursor list), `GET /notes/:id`, `POST /notes`,
 * `PATCH /notes/:id`, `PUT /notes/:id`, `DELETE /notes/:id`, `PATCH /notes/batch` — plus a live
 * `/notes/_realtime` delta channel. No access guards, no custom functions, no realtime wiring by
 * hand. Here we call the actions in-process through the broker (a browser would hit the same routes).
 */
const notes = table('notes', {
  title: z.string().min(1),
  done: z.boolean().default(false),
})

const noteResource = resource(notes, { type: 'crud' })

await main(function* () {
  yield* install(BunIO)
  yield* install(DefaultLogger, { level: LogLevel.warn })
  yield* install(ConsoleTransport)
  yield* install(DefaultBroker)
  yield* install(BunGateway, {})
  yield* install(SqliteDriver)
  yield* install(Pool, { connectionUri: ':memory:' })
  yield* install(RealtimeDb, { tables: [notes] })
  yield* noteResource.actions.install()
  yield* Broker.actions.start()

  // create → update → list → remove, using the same native service actions Docs can inspect
  const created = yield* Broker.actions.call(noteResource, 'create', [
    { type: DataType.normal, value: { title: 'write the docs' } },
  ])
  yield* Broker.actions.call(noteResource, 'create', [
    { type: DataType.normal, value: { title: 'cut a release' } },
  ])
  console.log('created:', created.title, `(${created._id})`)

  const done = yield* Broker.actions.call(noteResource, 'update', [
    { type: DataType.normal, value: { id: created._id, done: true } },
  ])
  console.log('updated:', done.title, '→ done =', done.done)

  const page = yield* Broker.actions.call(noteResource, 'list', [
    { type: DataType.normal, value: {} },
  ])
  console.log('list:', page.data.map((note: { title: string }) => note.title).join(', '))
  console.log('pageInfo:', JSON.stringify(page.pageInfo), 'rv:', page.resourceVersion)

  yield* Broker.actions.call(noteResource, 'remove', [
    { type: DataType.normal, value: { id: created._id } },
  ])
  const after = yield* Broker.actions.call(noteResource, 'list', [
    { type: DataType.normal, value: {} },
  ])
  console.log('after remove:', after.data.length, 'note(s) left')
})
