import { Pool } from 'db:core'
import { RealtimeDb } from 'db:realtime'
import { Broker, DefaultBroker, Gateway } from 'server:core'
import { ensure, main, suspend } from 'std:effect'
import { DefaultLogger, Logger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'

import { SqliteDriver } from 'db:impl/sqlite'
import { BunGateway } from 'server:gateway/bun'
import { Cors } from 'server:plugin/cors'
import { Docs } from 'server:plugin/docs'
import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'

import { comments, projects, stats, tasks } from './resources'
import { tables } from './schema'

await main(function* () {
  yield* install(BunIO)
  yield* install(DefaultLogger, { level: LogLevel.info })
  yield* install(ConsoleTransport)
  yield* install(DefaultBroker)
  yield* install(BunGateway, {})
  yield* install(Cors, { origin: '*', credentials: true })
  yield* install(Docs, {})

  // the db driver — piece-by-piece tables passed as a plain array (no defineSchema)
  yield* install(SqliteDriver)
  yield* install(Pool, { connectionUri: ':memory:' })
  yield* install(RealtimeDb, { tables })

  // Each resource is a native service: install registers + mounts it and serves its own realtime
  // channel. The same service values feed the existing Docs/OpenAPI plugin.
  yield* install(projects)
  yield* install(tasks)
  yield* install(comments)
  yield* install(stats)
  yield* Docs.actions.from(projects, tasks, comments, stats)

  yield* Broker.actions.start()
  const { host, port } = yield* Gateway.actions.start({ port: 3000, host: '127.0.0.1' })

  yield* Logger.actions.info(`wizard-todo ready → http://${host}:${port}`)
  yield* Logger.actions.info('  functions  POST /<ns>/<fn>   (/tasks/create, /tasks/complete, …)')
  yield* Logger.actions.info('  realtime   ws://…/<ns>/_realtime   { event:"watch", id, fn, args }')

  yield* ensure(function* () {
    yield* Gateway.actions.destroy()
    yield* Broker.actions.destroy()
  })
  yield* suspend()
})
