import type { Service } from 'server:core'
import { Broker, DefaultBroker, Gateway } from 'server:core'
import { Daemon } from 'server:daemon'
import { ensure, main, suspend, useContext } from 'std:effect'
import { DefaultLogger, Logger } from 'std:logger'
import { install } from 'std:plugin'

import { OpenAI } from 'ai:impl/openai'
import { BunGateway } from 'server:gateway/bun'
import { AccessRefreshAuth } from 'server:plugin/auth'
import { Cors } from 'server:plugin/cors'
import { Docs } from 'server:plugin/docs'
import { NatsTransport } from 'server:transport/nats'
import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'

import { ENV, STATUS_MAP } from './const'
import { AiService } from './services/ai'
import { AuthService } from './services/auth'
import { TodoService } from './services/todo'
import { cleanupErrors } from './utils/cleanup'
import { memoryAuthProvider } from './utils/store'

await main(function* () {
  yield* install(BunIO)
  yield* install(DefaultBroker)

  const rootEnv = yield* ENV
  yield* install(DefaultLogger, {
    level: rootEnv.level,
  })
  yield* install(ConsoleTransport)

  // services mounted on THIS replica — fed to the Docs plugin once everything is up
  const mounted: Service[] = []

  yield* install(Daemon, {
    replicate: {
      strategy: 'cluster',
      mode: 'roles',
      // roles mode: one process per entry (override the strategy/mode with env to engage it)
      roles: { auth: 1, todos: 1, ai: 1 },
    },

    failure: {
      mode: 'all',
      retry: { attempts: 3, delay: 500, backoff: 3 },
    },

    // Common to every replica. Installs (but does NOT start) the broker-adjacent plugins + gateway;
    // the daemon starts broker + gateway after the eligible modules have registered and mounted.
    *base(rt) {
      yield* Logger.actions.child(
        {
          index: rt.index,
        },
        function* () {
          const env = yield* ENV

          // Disable the transport-level request timeout (0) — the action `TimeoutPolicy` is the sole
          // authority, so a slow cross-service call (e.g. todos → ai.chat's buffered LLM completion)
          // is bounded by the policy, not cut off early by NATS's default 5s reply window.
          yield* install(NatsTransport, { requestTimeoutMs: 0 })

          yield* install(AuthService)
          yield* install(TodoService)
          yield* install(AiService)

          yield* Logger.actions.info(`LogLevel: ${env.level}  ·  role: ${rt.role ?? 'all'}`)

          // Token auth lives on EVERY replica so any role can validate Bearer tokens — only the `auth`
          // role serves the /auth login routes (see the auth module below).
          yield* install(AccessRefreshAuth, {
            secret: 'dev-only-secret-change-me',
            issuer: 'ozaco-backend',
            access: { expiresIn: '15m' },
            refresh: { expiresIn: '7d' },
          })
          yield* AccessRefreshAuth.actions.provide(memoryAuthProvider)

          // shared-port replicas share one port (the daemon binds with SO_REUSEPORT); role replicas each
          // take their own port (base + cluster worker id) so their gateways don't collide.
          const port = env.port + (rt.reusePort || rt.index < 1 ? 0 : rt.index)

          yield* install(BunGateway, {
            port,
            host: env.host,
            statusMap: STATUS_MAP,
            simplify: cleanupErrors.bind(null, 'gateway'),
          })
          yield* install(Cors, { origin: '*', credentials: true })
          yield* install(Docs, {
            silent: true,
            title: 'Ozaco Todo API',
            description: 'A tiny todo API with real JWT login, backed by in-memory Maps.',
            version: '0.0.0',
            auth: { type: 'bearer', bearerFormat: 'JWT' },
          })
        },
      )
    },

    modules: [
      {
        name: 'auth',
        roles: ['auth'],
        *setup() {
          yield* Broker.actions.register(AuthService)
          yield* Gateway.actions.mount('/auth', AuthService)
          mounted.push(AuthService)
        },
      },
      {
        name: 'todos',
        roles: ['todos'],
        *setup() {
          yield* Broker.actions.register(TodoService)
          yield* Gateway.actions.mount('/todos', TodoService)
          mounted.push(TodoService)
        },
      },
      {
        // AI is opt-in: only assembled when a provider key is present (and, in roles mode, on the
        // `ai` replica). The rest of the app still boots when it is not configured.
        name: 'ai',
        roles: ['ai'],
        when: rt => Boolean(rt.env.OPENAI_API_KEY || rt.env.AI_API_KEY),
        *setup() {
          const env = yield* ENV
          yield* install(OpenAI, {
            apiKey: env.aiApiKey,
            ...(env.aiBaseURL ? { baseURL: env.aiBaseURL } : {}),
            ...(env.aiModel ? { model: env.aiModel } : {}),
          })
          yield* Broker.actions.register(AiService)
          yield* Gateway.actions.mount('/ai', AiService)
          mounted.push(AiService)
        },
      },
    ],

    // After broker + gateway are listening: register the mounted services with Docs and log readiness.
    *ready() {
      if (mounted.length > 0) {
        yield* Docs.actions.from(...mounted)
      }

      const gw = yield* useContext(Gateway.context)
      const names = mounted.map(service => service.name).join(', ') || '(none)'

      yield* Logger.actions.info(`API ready → http://${gw.host}:${gw.port}  ·  routes: ${names}`)
    },
  })

  yield* Daemon.actions.start()

  yield* ensure(function* () {
    // The supervisor never installed the logger/gateway — guard so its shutdown stays quiet + safe.
    if ((yield* Logger.context.get()) !== undefined) {
      yield* Logger.actions.debug('Shutting down')
    }
    if ((yield* Gateway.context.get()) !== undefined) {
      yield* Gateway.actions.destroy()
    }
    yield* Broker.actions.destroy()
  })

  yield* suspend()
})
