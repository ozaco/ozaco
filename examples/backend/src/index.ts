import { Broker, DefaultBroker, Gateway } from 'server:core'
import { ensure, main, suspend } from 'std:effect'
import { DefaultLogger, Logger } from 'std:logger'
import { install } from 'std:plugin'

import { BunGateway } from 'server:gateway/bun'
import { AccessRefreshAuth } from 'server:plugin/auth'
import { Cors } from 'server:plugin/cors'
import { Docs } from 'server:plugin/docs'
import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'

import { ENV, STATUS_MAP } from './const'
import { AuthService } from './services/auth'
import { TodoService } from './services/todo'
import { cleanupErrors } from './utils/cleanup'
import { memoryAuthProvider } from './utils/store'

await main(function* () {
  yield* install(BunIO)

  const env = yield* ENV

  yield* install(DefaultLogger, { level: env.level })
  yield* install(ConsoleTransport)

  yield* Logger.actions.info(`LogLevel: ${env.level}`)

  // A local, in-process broker. DefaultBroker auto-installs the internal transport, so actions are
  // dispatched in-memory — no NATS or other broker is required to run this example.
  yield* install(DefaultBroker)

  // Real JWT auth: signed HS256 access + refresh tokens, backed by the in-memory provider.
  yield* install(AccessRefreshAuth, {
    secret: 'dev-only-secret-change-me',
    issuer: 'ozaco-backend',
    access: { expiresIn: '15m' },
    refresh: { expiresIn: '7d' },
  })
  yield* AccessRefreshAuth.actions.provide(memoryAuthProvider)

  yield* install(AuthService)
  yield* install(TodoService)

  yield* Broker.actions.register(AuthService)
  yield* Broker.actions.register(TodoService)
  yield* Broker.actions.start()

  // HTTP gateway + CORS + OpenAPI/Swagger docs.
  yield* install(BunGateway, {
    statusMap: STATUS_MAP,
    simplify: cleanupErrors.bind(null, 'gateway'),
  })
  yield* install(Cors, { origin: '*', credentials: true })
  yield* install(Docs, {
    title: 'Ozaco Todo API',
    description: 'A tiny todo API with real JWT login, backed by in-memory Maps.',
    version: '0.0.0',
    auth: { type: 'bearer', bearerFormat: 'JWT' },
  })

  // Mount each service under `/<service.name>` so the routes match the generated client + docs.
  yield* Gateway.actions.mount('/auth', AuthService)
  yield* Gateway.actions.mount('/todos', TodoService)

  yield* Docs.actions.from(AuthService, TodoService)

  const { host, port } = yield* Gateway.actions.start({ port: env.port, host: env.host })

  // the Docs plugin logs the swagger/openapi URLs itself once the gateway is listening
  yield* Logger.actions.info(`Todo api ready  → http://${host}:${port}`)
  yield* Logger.actions.info(
    'Seed users      → admin@example.com / admin  ·  user@example.com / user',
  )

  yield* ensure(function* () {
    yield* Logger.actions.debug('Shutting down')

    yield* Gateway.actions.destroy()
    yield* Broker.actions.destroy()

    yield* Logger.actions.info('Bye')
  })

  yield* suspend()
})
