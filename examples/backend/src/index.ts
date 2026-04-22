import { main, suspend } from 'std:effect'
import { install } from 'std:plugin'

import { AccessRefreshAuth } from 'server:auth'
import { BunServer } from 'server:bun'
import { DefaultRouter, Server } from 'server:core'
import { Cors } from 'server:cors'
import { Docs } from 'server:docs'
import { BunIO } from 'std:io/bun'

import { AuthService } from './auth.service'
import { demoAuthProvider } from './auth.store'
import { TodoService } from './todo.service'

await main(function* () {
  yield* install(BunIO)
  yield* install(BunServer)
  yield* install(DefaultRouter)

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

  try {
    yield* TodoService.actions.create({
      // @ts-expect-error test validation
      body: 'test',
    })
  } catch {
    console.log('validations working')
  }

  const { host, port } = yield* Server.actions.start({
    port: 3000,
    host: '0.0.0.0',
  })

  console.log(`Server is listening: http://${host}:${port}/`)

  yield* suspend()
})
