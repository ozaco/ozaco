// oxlint-disable import/exports-last
/**
 * The demo app: ONE codebase, every deployment shape. Environment picks the pieces:
 *
 *   ROLE=monolith|gateway|service   (default: SERVICE set → service, else monolith)
 *   SERVICE=todos,media            services this node hosts (service role)
 *   TRANSPORT=memory|nats|redis    the carrier's transport. `nats` speaks JetStream (run your
 *     own server: `nats-server -js`) and reads NATS_URL (default nats://localhost:4222);
 *     `redis` reads REDIS_URL. Cross-node WebRTC signaling rides this carrier's event plane.
 *   DB=sqlite|pg                   the database (DB_PATH / DATABASE_URL)
 *   KV=memory|redis                the cache store (REDIS_URL)
 *   PORT=3000                      the edge port (edge roles)
 *   INSTANCE=gw-1                  this node's name in presence / traces
 *   OBSERVE=local|forward|collect  where observe rows go (cluster: services forward, gateway collects)
 *   OTLP_URL=http://localhost:4318 export spans/logs/metrics to an OTLP collector
 *     (for OpenObserve use http://localhost:5080/api/default and set OTLP_AUTH)
 *   OTLP_AUTH=user:pass|token      authorization for the OTLP endpoint (basic or bearer)
 *   OPENOBSERVE_URL=http://localhost:5080  ship raw observe rows to per-kind streams
 *     (OPENOBSERVE_ORG, OPENOBSERVE_AUTH=user:pass|token, OPENOBSERVE_BODIES=1)
 *   AUTH_SECRET=…                  HS256 secret (default: a demo value)
 */
import { DbBus, DbClient } from 'db:core'
import type { ServerDef } from 'server:core'
import { createServer, Edge } from 'server:core'
import { Auth, Cache, Cors, Docs, ObservePlugin, Resilience } from 'server:plugins'
import type { Operation } from 'std:effect'
import { attempt, fork } from 'std:effect'
import { isFailure } from 'std:result'

import { MemoryKv } from 'db:impl/memory-kv'
import { PgAdapter } from 'db:impl/pg'
import { RedisKv } from 'db:impl/redis-kv'
import { SqliteAdapter } from 'db:impl/sqlite'
import { NetworkCarrier } from 'server:impl/carrier/network'
import { BunEdge } from 'server:impl/edge/bun'
import { OpenObserveExporter } from 'server:plugins/observe/openobserve'
import { OtlpExporter } from 'server:plugins/observe/otlp'
import { BunIO } from 'std:io/impl/bun'
import { MemoryTransport } from 'transport:impl/memory'
import { NatsTransport } from 'transport:impl/nats'
import { RedisTransport } from 'transport:impl/redis'

import { authProvider, seedUsers } from './auth'
import { account, cluster, feed, live, media, reports, rtc, startRtcRelay, todos } from './services'
import { schema } from './tables'

export const services = [account, todos, feed, media, reports, live, rtc, cluster] as const

export type Api = ServerDef.Handle<typeof services>['api']

export interface DemoOptions {
  /** overrides for what the environment would pick (tests). */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined

  /** a shared memory link for several in-process nodes (tests / `scripts/cluster.ts`). */
  readonly link?: unknown
}

const envOf = (overrides?: Readonly<Record<string, string | undefined>>) => (name: string) =>
  overrides?.[name] ?? process.env[name]

/** Install transport → change bus → storage, as the environment asks; resolves the db handle.
 * The bus rides the same transport the carrier does, so every node sees every change (cache
 * invalidation, realtime watches) when they share a database. */
function* infrastructure(
  env: (name: string) => string | undefined,
  link?: unknown,
): Operation<void> {
  yield* BunIO.use()
  const prefix = env('APP_PREFIX') ?? 'demo'

  switch (env('TRANSPORT') ?? 'memory') {
    case 'nats': {
      yield* NatsTransport.use({
        prefix,
        servers: env('NATS_URL') ?? 'nats://localhost:4222',
      })
      break
    }

    case 'redis': {
      yield* RedisTransport.use({
        prefix,
        url: env('REDIS_URL') ?? 'redis://localhost:6379',
      })
      break
    }

    default: {
      yield* MemoryTransport.use(link ? { prefix, link: link as never } : { prefix })
    }
  }

  yield* DbBus.use()

  switch (env('DB') ?? 'sqlite') {
    case 'pg': {
      yield* PgAdapter.use({ url: env('DATABASE_URL') ?? 'postgres://localhost:5432/demo' })
      break
    }

    default: {
      yield* SqliteAdapter.use({ path: env('DB_PATH') ?? ':memory:' })
    }
  }

  yield* DbClient.use({ schema })
  yield* (env('KV') ?? 'memory') === 'redis'
    ? RedisKv.use({ url: env('REDIS_URL') ?? 'redis://localhost:6379' })
    : MemoryKv.use()
  yield* seedUsers()
}

/** Build (not start) the demo node. */
export function* createDemo(
  options: DemoOptions = {},
): Operation<ServerDef.Handle<typeof services>> {
  const env = envOf(options.env)
  yield* infrastructure(env, options.link)
  const observe = env('OBSERVE') ?? 'local'
  const role =
    (env('ROLE') as ServerDef.Role | undefined) ?? (env('SERVICE') ? 'service' : undefined)
  const withEdge =
    (role ?? (env('SERVICE') ? 'service' : 'monolith')) !== 'service' || env('PORT') !== undefined

  const plugins: ServerDef.PluginLike[] = [
    ObservePlugin.use({
      console: true,
      mirror: env('MIRROR') === '1',
      forward: observe === 'forward' ? true : observe === 'both' ? 'both' : false,
      collect: observe === 'collect',
    }),
    Cors.use({ origins: '*' }),
    Auth.use({
      provider: authProvider(),
      secret: env('AUTH_SECRET') ?? 'demo-secret-change-me',
      mode: 'access-refresh',
      accessTtlMs: 15 * 60 * 1000,
    }),
    Cache,
    Resilience,
    Docs.use({ path: '/docs', title: 'ozaco demo' }),
  ]

  // `user:pass` → basic, anything else → bearer
  const authHeader = (value: string): string =>
    value.includes(':') ? `Basic ${btoa(value)}` : `Bearer ${value}`

  if (env('OTLP_URL')) {
    const auth = env('OTLP_AUTH')

    plugins.push(
      OtlpExporter.use({
        url: env('OTLP_URL')!,
        ...(auth ? { headers: { authorization: authHeader(auth) } } : {}),
      }),
    )
  }

  if (env('OPENOBSERVE_URL')) {
    const auth = env('OPENOBSERVE_AUTH')

    plugins.push(
      OpenObserveExporter.use({
        url: env('OPENOBSERVE_URL')!,
        org: env('OPENOBSERVE_ORG') ?? 'default',
        bodies: env('OPENOBSERVE_BODIES') === '1',
        ...(auth ? { headers: { authorization: authHeader(auth) } } : {}),
      }),
    )
  }

  // `role`/`hosted` default from `process.env.SERVICE` inside createServer; the demo resolves
  // them through its OWN env map (tests boot several nodes in one process), so it passes both
  const hosted = env('SERVICE')
    ?.split(',')
    .map(name => name.trim())
    .filter(Boolean)

  const app = yield* createServer({
    services,
    ...(role ? { role } : {}),
    ...(hosted && hosted.length > 0 ? { hosted } : {}),
    edge: withEdge ? BunEdge : undefined,
    carrier: NetworkCarrier,
    plugins,
    name: 'demo',
    version: '1.0.0',
    instance: env('INSTANCE'),
    listen: { port: Number(env('PORT') ?? 0), hostname: env('HOST') ?? '127.0.0.1' },
    readyTimeoutMs: Number(env('READY_TIMEOUT_MS') ?? 30_000),
  })

  if (withEdge) {
    // The WebRTC signaling rooms live on the node that ACCEPTED each socket, so every edge node
    // folds the others' room events into its own view (see services/rtc.ts). Failing to reach
    // the carrier must not take the node down — a single-edge deployment simply stays local.
    yield* fork(function* () {
      const outcome = yield* attempt(() => startRtcRelay())
      if (isFailure(outcome)) {
        console.warn(`[demo] rtc relay pump stopped: ${String(outcome.error)}`)
      }
    })

    // routes outside the action model: a custom socket and a raw route

    yield* Edge.actions.raw({
      method: 'GET',
      path: '/',
      *handler() {
        return new Response(
          `ozaco demo · ${role} · docs at /docs · observe at /_observe · health at /_health\n`,
          { headers: { 'content-type': 'text/plain; charset=utf-8' } },
        )
      },
    })
  }

  return app
}
