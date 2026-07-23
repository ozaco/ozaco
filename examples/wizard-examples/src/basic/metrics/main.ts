import { Pool } from 'db:core'
import { RealtimeDb, table } from 'db:realtime'
import { Broker, DefaultBroker } from 'server:core'
import { Metrics, MetricsCollector } from 'server:metrics'
import { resource } from 'server:wizard'
import { main } from 'std:effect'
import { DefaultLogger, Logger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'

import { SqliteDriver } from 'db:impl/sqlite'
import { BunGateway } from 'server:gateway/bun'
import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'
import { z } from 'zod'

/**
 * The metrics/analytics plugin end to end, with CUSTOM FIELDS + MongoDB-style queries + export/import.
 *   - `install(MetricsCollector)` opens an ISOLATED DuckDB store (driver lives inside the module).
 *   - Calls are auto-instrumented into `calls`; a `fields` hook attaches custom fields per call.
 *   - Logs are captured into `logs`; a log's structured data becomes the record's custom fields.
 *   - Custom fields ride in a JsonCodec `meta` column (NOT a native JSON column) and come back merged
 *     into query rows — never stripped.
 *   - Queries use the SAME MongoDB-style filter language as `@ozaco/db` (`Metrics.actions.find`);
 *     `query` stays for raw aggregations; `export`/`import` do Parquet round-trips.
 */
const EXPORT_FILE = '/tmp/ozaco-metrics-calls.parquet'
const notes = table('notes', { title: z.string(), done: z.boolean().default(false) })
const noteResource = resource(notes, { type: 'crud' })

await main(function* () {
  yield* install(BunIO)
  yield* install(DefaultLogger, { level: LogLevel.info })
  yield* install(ConsoleTransport)
  yield* install(DefaultBroker)
  yield* install(BunGateway, {})
  yield* install(SqliteDriver)
  yield* install(Pool, { connectionUri: ':memory:' })
  yield* install(RealtimeDb, { tables: [notes] })
  yield* install(noteResource)
  yield* install(MetricsCollector, {
    path: ':memory:',
    flushIntervalMs: 200,
    // custom fields attached to every call metric
    fields: event => ({ kind: event.action === 'create' ? 'write' : 'read' }),
  })
  yield* Broker.actions.start()

  // --- generate work: CRUD calls + logs carrying custom structured fields ---
  for (let i = 1; i <= 5; i++) {
    yield* Broker.actions.call(noteResource.actions.create, [{ title: `note-${i}` }])
    yield* Logger.actions.info(`created note ${i}`, { userId: i, region: i % 2 ? 'eu' : 'us' })
  }
  yield* Broker.actions.call(noteResource.actions.list, [{}])
  yield* Broker.actions.call(noteResource.actions.list, [{}])

  // --- 1. MongoDB-style find on calls (same filter params as @ozaco/db) + custom field returned ---
  const writes = yield* Metrics.actions.find({
    table: 'calls',
    filter: { action: 'create', status: 'success' },
  })
  console.log(`calls action=create: ${writes.length}  (custom field kind='${writes[0]?.kind}')`)

  // --- 2. find on logs with an operator filter; custom log fields come back merged ---
  const infoLogs = yield* Metrics.actions.find({
    table: 'logs',
    filter: { level: { $gte: LogLevel.info } },
    sort: 'ts',
    order: 'asc',
  })
  console.log(
    `logs level>=info: ${infoLogs.length}  first custom fields → userId=${infoLogs[0]?.userId} region=${infoLogs[0]?.region}`,
  )

  // --- 3. raw aggregation query ---
  const agg = yield* Metrics.actions.query(
    `SELECT service, action, count(*) AS n, round(avg("durationMs"), 3) AS avg_ms
     FROM calls GROUP BY service, action ORDER BY n DESC`,
  )
  console.log('aggregation:', agg.map(r => `${r.service}.${r.action}×${r.n}`).join(', '))

  // --- 3b. custom events — the "normal insert" (not a call or a log): name + value + custom fields ---
  yield* Metrics.actions.record({ name: 'signup', fields: { plan: 'pro', region: 'eu' } })
  yield* Metrics.actions.record({ name: 'signup', fields: { plan: 'free', region: 'us' } })
  yield* Metrics.actions.record({ name: 'latency', value: 42.5, fields: { endpoint: '/a' } })
  yield* Metrics.actions.record({ name: 'latency', value: 91, fields: { endpoint: '/b' } })

  const signups = yield* Metrics.actions.find({ table: 'events', filter: { name: 'signup' } })
  console.log(`events name=signup: ${signups.length}  (custom field plan='${signups[0]?.plan}')`)
  const [lat] = yield* Metrics.actions.query(
    `SELECT round(avg("value"), 2) AS avg, max("value") AS max FROM events WHERE "name" = 'latency'`,
  )
  console.log(`event 'latency' value → avg=${lat?.avg} max=${lat?.max}`)

  // --- 3c. YOUR OWN table with YOUR OWN columns — a plain insert, full control ---
  yield* Metrics.actions.define({
    table: 'deploys',
    columns: { ts: 'int', service: 'text', version: 'text', ok: 'boolean', info: 'json' },
  })
  yield* Metrics.actions.insert({
    table: 'deploys',
    row: { ts: Date.now(), service: 'api', version: 'v1.2.0', ok: true, info: { by: 'ci' } },
  })
  yield* Metrics.actions.insert({
    table: 'deploys',
    row: { ts: Date.now(), service: 'web', version: 'v3.0.1', ok: false, info: { by: 'manual' } },
  })
  const deploys = yield* Metrics.actions.query(
    'SELECT service, version, ok, info FROM deploys ORDER BY ts',
  )
  console.log(
    'deploys:',
    deploys.map(d => `${d.service}@${d.version} ok=${d.ok} ${d.info}`).join(' | '),
  )
  // find/prune/export now work on YOUR table too (same as built-in): MongoDB-style filter + retention
  const okDeploys = yield* Metrics.actions.find({ table: 'deploys', filter: { ok: true } })
  const prunedDeploys = yield* Metrics.actions.prune({ table: 'deploys', before: Date.now() - 1 })
  console.log(
    `deploys find ok=true: ${okDeploys.length}  |  prune(before now): removed ${prunedDeploys}`,
  )

  // --- 4. export to Parquet, then import back (append) ---
  const [before] = yield* Metrics.actions.query('SELECT count(*) AS n FROM calls')
  yield* Metrics.actions.export({ table: 'calls', path: EXPORT_FILE, format: 'parquet' })
  yield* Metrics.actions.import({ table: 'calls', path: EXPORT_FILE, format: 'parquet' })
  const [after] = yield* Metrics.actions.query('SELECT count(*) AS n FROM calls')
  console.log(`export+import round-trip: calls ${before?.n} → ${after?.n} (appended)`)

  // --- 5. retention: prune old rows (here everything older than "now" → all current calls) ---
  const removed = yield* Metrics.actions.prune({ table: 'calls', before: Date.now() + 1000 })
  const [left] = yield* Metrics.actions.query('SELECT count(*) AS n FROM calls')
  console.log(`prune (retention): removed ${removed} calls, ${left?.n} left`)
})
