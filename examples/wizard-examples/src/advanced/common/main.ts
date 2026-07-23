import { Pool } from 'db:core'
import { DB, table, RealtimeDb } from 'db:realtime'
import { Broker, DefaultBroker, Gateway } from 'server:core'
import { action, resource, useResponse } from 'server:wizard'
import { main } from 'std:effect'
import { fetch } from 'std:fetch'
import { DefaultLogger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'
import type { AnyType } from 'std:shared'

import { SqliteDriver } from 'db:impl/sqlite'
import { BunGateway } from 'server:gateway/bun'
import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'
import { z } from 'zod'

/**
 * The raw HTTP surface (spec §0.1 + §E), driven over `std:fetch` (never global fetch):
 *
 * - Manual migration (A): the DB installs with `migrations: 'manual'`, so we preview the plan and
 *   apply it ourselves via `DB.actions`.
 * - Composite keys (E): a Service is `{namespace}/{name}`, so `idParams` makes the routes
 *   `GET/PATCH/DELETE /services/:namespace/:name`.
 * - Facets + envelope (B/D): `GET /services?type=…` returns the cursor envelope.
 * - Optimistic concurrency (B): a stale `If-Match` is rejected with 412.
 * - Bulk edit (B): `PATCH /services/batch`.
 * - Non-JSON (E): `/cluster/kubeconfig` returns `text/yaml`.
 */
const services = table('services', {
  namespace: z.string(),
  name: z.string(),
  type: z.enum(['ClusterIP', 'NodePort', 'LoadBalancer']),
}).unique('services_ns_name', ['namespace', 'name'])

const serviceResource = resource(services, {
  type: 'crud',
  idParams: ['namespace', 'name'],
  filters: ['type'],
})

const kubeconfig = action({
  rest: { method: 'GET', path: '/kubeconfig' },
  *handler() {
    const response = yield* useResponse()
    response.meta['content-type'] = 'text/yaml'
    return 'apiVersion: v1\nkind: Config\nclusters: []\n'
  },
})

const cluster = resource('cluster', { kubeconfig })

const BASE = 'http://localhost:4577'
const json = { 'content-type': 'application/json' }

await main(function* () {
  yield* install(BunIO)
  yield* install(DefaultLogger, { level: LogLevel.warn })
  yield* install(ConsoleTransport)
  yield* install(DefaultBroker)
  yield* install(BunGateway, {})
  yield* install(SqliteDriver)
  yield* install(Pool, { connectionUri: ':memory:' })
  yield* install(RealtimeDb, {
    tables: [services],
    migrations: 'manual',
    safe: true,
  })
  yield* install(serviceResource)
  yield* install(cluster)
  yield* Broker.actions.start()
  yield* Gateway.actions.start({ port: 4577, host: '127.0.0.1' })

  // manual migration: preview, then apply
  const plan = yield* DB.actions.planMigration()
  console.log('plan:', plan.statements.map(statement => statement.kind).join(', '))
  yield* DB.actions.migrate()

  // composite-key create + get
  yield* fetch(`${BASE}/services`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ namespace: 'default', name: 'web', type: 'ClusterIP' }),
  })
  yield* fetch(`${BASE}/services`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ namespace: 'default', name: 'api', type: 'LoadBalancer' }),
  })

  const got = yield* fetch(`${BASE}/services/default/web`)
  const web = (yield* got.json()) as AnyType
  console.log('GET /services/default/web ->', got.status, web.type)

  const filtered = yield* fetch(`${BASE}/services?type=LoadBalancer`)
  const envelope = (yield* filtered.json()) as AnyType
  console.log(
    'GET /services?type=LoadBalancer -> data:',
    envelope.data.length,
    'rv:',
    envelope.resourceVersion,
  )

  const cfg = yield* fetch(`${BASE}/cluster/kubeconfig`)
  console.log('kubeconfig content-type:', cfg.headers.get('content-type'))
  console.log((yield* cfg.text()).split('\n')[0])

  // optimistic concurrency: a stale If-Match is rejected with 412
  const stale = yield* fetch(`${BASE}/services/default/web`, {
    method: 'PATCH',
    headers: { ...json, 'if-match': '999' },
    body: JSON.stringify({ type: 'NodePort' }),
  })
  console.log('PATCH stale If-Match ->', stale.status)

  // bulk edit: independent ops with per-item optimistic concurrency — the stale-`ifMatch` item is
  // reported as a per-item error while the other still applies (partial success, not all-or-nothing)
  const batch = yield* fetch(`${BASE}/services/batch`, {
    method: 'PATCH',
    headers: json,
    body: JSON.stringify({
      operations: [
        { op: 'update', id: web._id, patch: { type: 'NodePort' } },
        { op: 'update', id: web._id, patch: { type: 'ClusterIP' }, ifMatch: '999' },
      ],
    }),
  })
  const batchBody = (yield* batch.json()) as AnyType
  const ok = batchBody.results.filter((entry: AnyType) => entry.status === 'ok').length
  const failed = batchBody.results.filter((entry: AnyType) => entry.status === 'error').length
  console.log('PATCH /services/batch ->', batch.status, 'ok:', ok, 'failed:', failed)

  yield* Gateway.actions.destroy()
})
