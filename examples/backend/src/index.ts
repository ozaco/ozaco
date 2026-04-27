import { Server } from 'server:core'
import { main, suspend } from 'std:effect'
import { IO } from 'std:io'
import { install } from 'std:plugin'

import { SqliteDB } from 'db:impl/sqlite'
import { BunServer } from 'server:impl/bun'
import { AccessRefreshAuth } from 'server:plugin/auth'
import { Cors } from 'server:plugin/cors'
import { Docs } from 'server:plugin/docs'
import { DefaultRouter } from 'server:plugin/router'
import { BunIO } from 'std:io/impl/bun'

import { AuthService } from './auth.service'
import { demoAuthProvider, seedIfEmpty } from './auth.store'
import { schema } from './db.schema'
import { TodoService } from './todo.service'

await main(function* () {
  yield* install(BunIO)
  yield* install(BunServer)
  yield* install(DefaultRouter)

  yield* IO.actions.ensureDir('./.ozaco/data')

  yield* install(SqliteDB, {
    url: 'file:./.ozaco/data/backend.sqlite',
    schema,
  })
  yield* seedIfEmpty()

  yield* install(AccessRefreshAuth, {
    secret: 'dev-only-change-me',
    issuer: 'ozaco-backend',
    access: { expiresIn: '15m' },
    refresh: { expiresIn: '7d' },
  })
  yield* AccessRefreshAuth.actions.provide(demoAuthProvider)

  yield* install(AuthService)
  yield* install(TodoService)
  yield* install(Cors, { origin: '*', credentials: true })

  yield* install(Docs, {
    title: 'Backend API',
    version: '0.0.1',
    auth: { type: 'bearer', bearerFormat: 'JWT' },
  })

  yield* Docs.actions.from(AuthService, TodoService)

  const { host, port } = yield* Server.actions.start({
    port: 3000,
    host: '0.0.0.0',
  })

  console.log(`Server is listening: http://${host}:${port}/`)

  yield* suspend()
})
