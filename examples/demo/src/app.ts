// oxlint-disable import/exports-last
/**
 * The demo app: ONE codebase, every deployment shape. Environment picks the pieces:
 *
 *   ROLE=monolith|gateway|service   (default: SERVICE set → service, else monolith)
 *   SERVICE=todos,media            services this node hosts (service role)
 *   TRANSPORT=memory|nats|redis    the carrier's transport (NATS_URL / REDIS_URL)
 *   DB=sqlite|pg                   the database (DB_PATH / DATABASE_URL)
 *   KV=memory|redis                the cache store (REDIS_URL)
 *   PORT=3000                      the edge port (edge roles)
 *   INSTANCE=gw-1                  this node's name in presence / traces
 *   OBSERVE=local|forward|collect  where observe rows go (cluster: services forward, gateway collects)
 *   OTLP_URL=http://localhost:4318 export spans/logs to an OTLP collector
 *   STARROCKS_URL=http://fe:8030   stream-load request/span metrics (STARROCKS_DB, STARROCKS_USER/PASSWORD)
 *   AUTH_SECRET=…                  HS256 secret (default: a demo value)
 */
import { DbBus, DbClient } from '@ozaco/db'
import { MemoryKv } from '@ozaco/db/impl/kv/memory'
import { RedisKv } from '@ozaco/db/impl/kv/redis'
import { PgAdapter } from '@ozaco/db/impl/pg'
import { SqliteAdapter } from '@ozaco/db/impl/sqlite'
import type { ServerDef } from '@ozaco/server'
import { Edge } from '@ozaco/server'
import type { AppDef } from '@ozaco/server/app'
import { createApp } from '@ozaco/server/app'
import { NetworkCarrier } from '@ozaco/server/carrier/network'
import { BunEdge } from '@ozaco/server/edge/bun'
import { Auth, Cache, Cors, Docs, ObservePlugin, Resilience, Resource } from '@ozaco/server/plugins'
import { StarRocksMetrics } from '@ozaco/server/plugins/metrics/starrocks'
import { OtlpExporter } from '@ozaco/server/plugins/observe/otlp'
import type { Operation } from '@ozaco/std/effect'
import { BunIO } from '@ozaco/std/io/impl/bun'
import { MemoryTransport } from '@ozaco/transport/impl/memory'
import { NatsTransport } from '@ozaco/transport/impl/nats'
import { RedisTransport } from '@ozaco/transport/impl/redis'

import type { Db } from './auth'
import { authProvider, seedUsers } from './auth'
import {
  account,
  chatSocket,
  cluster,
  feed,
  live,
  media,
  reports,
  todoStats,
  todos,
} from './services'
import { tables } from './tables'

export const services = [
  account,
  todos.service,
  todoStats,
  feed,
  media,
  reports,
  live,
  cluster,
] as const

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
function* infrastructure(env: (name: string) => string | undefined, link?: unknown): Operation<Db> {
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

  const db = yield* DbClient.use({ tables: [...tables] })
  yield* (env('KV') ?? 'memory') === 'redis'
    ? RedisKv.use({ url: env('REDIS_URL') ?? 'redis://localhost:6379' })
    : MemoryKv.use()
  yield* seedUsers(db as unknown as Db)

  return db as unknown as Db
}

/** Build (not start) the demo node. */
export function* createDemo(options: DemoOptions = {}): Operation<AppDef.Handle<typeof services>> {
  const env = envOf(options.env)
  const db = yield* infrastructure(env, options.link)
  const observe = env('OBSERVE') ?? 'local'
  const role = (env('ROLE') as AppDef.Role | undefined) ?? (env('SERVICE') ? 'service' : 'monolith')
  const withEdge = role !== 'service' || env('PORT') !== undefined

  const plugins: ServerDef.PluginLike[] = [
    ObservePlugin.use({
      console: true,
      mirror: env('MIRROR') === '1',
      forward: observe === 'forward' ? true : observe === 'both' ? 'both' : false,
      collect: observe === 'collect',
    }),
    Cors.use({ origins: '*' }),
    Auth.use({
      provider: authProvider(() => db),
      secret: env('AUTH_SECRET') ?? 'demo-secret-change-me',
      mode: 'access-refresh',
      accessTtlMs: 15 * 60 * 1000,
    }),
    Cache,
    Resilience,
    Docs.use({ path: '/docs', title: 'ozaco demo' }),
    Resource.use({ resources: [todos] }),
  ]

  if (env('OTLP_URL')) {
    plugins.push(OtlpExporter.use({ url: env('OTLP_URL')! }))
  }

  if (env('STARROCKS_URL')) {
    plugins.push(
      StarRocksMetrics.use({
        url: env('STARROCKS_URL')!,
        database: env('STARROCKS_DB') ?? 'demo',
        user: env('STARROCKS_USER'),
        password: env('STARROCKS_PASSWORD'),
      }),
    )
  }

  const app = yield* createApp({
    services,
    role,
    hosted: env('SERVICE')
      ?.split(',')
      .map(name => name.trim())
      .filter(Boolean),
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
    // routes outside the action model: a custom socket and a raw route
    yield* Edge.actions.socket(chatSocket())

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
