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
import { mountChat } from './services/chat'
import { TodoService } from './services/todo'
import { UploadService } from './services/upload'
import { cleanupErrors } from './utils/cleanup'
import { memoryAuthProvider } from './utils/store'

// One entry, one image — the environment decides what this process becomes:
//
//   (SERVICE unset)   monolith: owns and serves everything, like `./index.ts`
//   SERVICE=gateway   gateway:  mounts + documents every route, owns NOTHING
//   SERVICE=auth      service:  owns ONLY AuthService, headless (no port)
//   SERVICE=todos     service:  owns ONLY TodoService
//   SERVICE=ai        service:  owns ONLY AiService
//
// Set CLUSTER=1 to get the same split as forked processes on one machine. In Kubernetes leave it
// off: one Deployment per module plus a gateway Deployment, each with its own SERVICE.
//
// A gateway route holds no code — it dispatches through the broker, misses the empty local registry,
// and falls through to NATS, where the owning process answers.

await main(function* () {
  yield* install(BunIO)
  yield* install(DefaultBroker)

  const rootEnv = yield* ENV
  yield* install(DefaultLogger, {
    level: rootEnv.level,
  })
  yield* install(ConsoleTransport)

  yield* install(Daemon, {
    cluster: rootEnv.cluster,

    failure: {
      mode: 'all',
      retry: { attempts: 3, delay: 500, backoff: 3 },
    },

    // Infrastructure only — NO services. Whatever this process owns is installed by the daemon from
    // `modules`, so an auth process never boots todos or ai.
    *base(rt) {
      yield* Logger.actions.child(
        {
          kind: rt.kind,
        },
        function* () {
          const env = yield* ENV

          // A generous ceiling, not a disabled one. `requestTimeoutMs: 0` reads as "let the action's
          // TimeoutPolicy decide" — but that authority only exists where such a policy is actually
          // applied, and none of these actions apply one. With no timer at all, an owner KILLED
          // mid-request leaves the caller waiting ~24.8 days: NATS's no-responders fast path only
          // covers the moment of sending, so a pod that dies after accepting the request is silent
          // forever. This window is wide enough for a buffered LLM completion and still finite.
          //
          // The queue group is the module name: every replica of one module shares it, so NATS
          // load-balances calls across them.
          yield* install(NatsTransport, {
            servers: env.natsServers,
            requestTimeoutMs: env.requestTimeoutMs,
            ...(rt.service ? { queueGroup: rt.service } : {}),
          })

          // Actions execute where they are owned, so token validation belongs with the owners. The
          // gateway never runs an action body and needs no auth strategy.
          if (rt.kind !== 'gateway') {
            yield* install(AccessRefreshAuth, {
              secret: 'dev-only-secret-change-me',
              issuer: 'ozaco-backend',
              access: { expiresIn: '15m' },
              refresh: { expiresIn: '7d' },
            })
            yield* AccessRefreshAuth.actions.provide(memoryAuthProvider)
          }

          yield* Logger.actions.info(
            `LogLevel: ${env.level}  ·  ${rt.kind}${rt.service ? ` (${rt.service})` : ''}`,
          )

          if (rt.kind === 'service') {
            // headless: no port, no HTTP surface — it answers over NATS only
            return
          }

          yield* install(BunGateway, {
            port: env.port,
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

    // Declarative: the daemon installs + registers a service ONLY where it is owned, and mounts its
    // routes wherever they are served. The module name is its role — `SERVICE=todos` owns `todos`.
    modules: [
      { name: 'auth', service: AuthService, route: '/auth' },
      { name: 'todos', service: TodoService, route: '/todos' },
      { name: 'upload', service: UploadService, route: '/upload' },
      {
        // AI is opt-in: owned only where a provider key is present. The gateway still mounts and
        // documents /ai — the key belongs to the owner, not the edge.
        name: 'ai',
        when: rt => Boolean(rt.env.OPENAI_API_KEY || rt.env.AI_API_KEY),
        service: AiService,
        route: '/ai',
        *setup() {
          const env = yield* ENV
          yield* install(OpenAI, {
            apiKey: env.aiApiKey,
            ...(env.aiBaseURL ? { baseURL: env.aiBaseURL } : {}),
            ...(env.aiModel ? { model: env.aiModel } : {}),
          })
        },
      },
    ],

    // After broker + gateway start. `mounted` is what THIS process exposed — on the gateway that is
    // the whole API, which is exactly what the unified OpenAPI spec should describe.
    *ready(rt, mounted) {
      if (rt.kind === 'service') {
        yield* Logger.actions.info(`Service ready  ·  owns: ${rt.service}  ·  transport: NATS`)
        return
      }

      if (mounted.length > 0) {
        yield* Docs.actions.from(...(mounted as Service[]))
      }

      // Chat is a raw `listen()` endpoint rather than a service, so the daemon has nothing to mount
      // for it — whoever serves HTTP registers it here. Its rooms live at the edge, which is why it
      // is the one thing that does NOT split across pods.
      yield* mountChat()

      const gw = yield* useContext(Gateway.context)
      const names = mounted.map(service => service.name).join(', ') || '(none)'

      yield* Logger.actions.info(`API ready → http://${gw.host}:${gw.port}  ·  routes: ${names}`)
    },
  })

  yield* Daemon.actions.start()

  yield* ensure(function* () {
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
