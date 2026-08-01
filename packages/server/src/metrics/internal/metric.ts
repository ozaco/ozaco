// oxlint-disable import/exports-last
import { sql } from 'db:core'
import type { Column } from 'db:realtime'
import { compileFilter } from 'db:realtime'
import { Broker, DataType } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt, operation, sleep } from 'std:effect'
import { Logger } from 'std:logger'
import { fail, isSuccess } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import {
  CALL_FILTER_COLUMNS,
  EVENT_FILTER_COLUMNS,
  FORWARD_PENDING_CAP,
  LOG_FILTER_COLUMNS,
  METRICS_SERVICE_NAME,
} from '../const'
import type { MetricsDef } from '../types'

// --- collector -------------------------------------------------------------------------------------
// Module-level so the metrics policy's SYNC hooks and the logger transport can push without crossing an
// effect boundary; a spawned loop (plus flush-on-query and flush-on-close) drains the buffers to the
// store in batches. `meta` (custom fields) is serialized via the JsonCodec at FLUSH time — the codec is
// an effect, so it can't run in the sync push, and buffering the raw object keeps the fields intact.
let store: MetricsDef.Store | null = null
// `sink: 'forward'` — no local store; flushes ship to the sink service over the broker instead.
let forward = false
// A forward batch that failed to reach the sink (typically the boot window before the broker/
// transport is up) — merged into the next flush, capped so an unreachable sink can't grow memory.
let pending: MetricsDef.IngestBatch | null = null
let calls: MetricsDef.CallRecord[] = []
let logs: MetricsDef.LogRecord[] = []
let events: MetricsDef.EventRecord[] = []
// Columns of user-defined tables (from `define`), so a MongoDB-style `find` can compile filters
// against them too — not just the built-in tables.
let definedColumns = new Map<string, readonly Column[]>()
// Whether the last flush failed — state-change flag so a broken store logs once, not per interval.
let flushBroken = false

export const setStore = (next: MetricsDef.Store): void => {
  store = next
  forward = false
  pending = null
  calls = []
  logs = []
  events = []
  definedColumns = new Map()
  flushBroken = false
}

export const setForward = (): void => {
  store = null
  forward = true
  pending = null
  calls = []
  logs = []
  events = []
  definedColumns = new Map()
  flushBroken = false
}

export const pushCall = (record: MetricsDef.CallRecord): void => {
  if (store || forward) {
    calls.push(record)
  }
}

export const pushLog = (record: MetricsDef.LogRecord): void => {
  if (store || forward) {
    logs.push(record)
  }
}

const pushEvent = (record: MetricsDef.EventRecord): void => {
  if (store || forward) {
    events.push(record)
  }
}

// Call the sink service by ADDRESS — resolved locally when the sink is registered in-process,
// otherwise routed by whatever transport is installed (NATS in a split deployment).
const callSink = <T>(path: string, ...args: unknown[]): Operation<T> =>
  Broker.actions.call(
    METRICS_SERVICE_NAME,
    path,
    args.map(value => ({ type: DataType.normal, value })),
  ) as Operation<T>

// Serialize custom fields with the JsonCodec (never a bare JSON.stringify / native JSON column). A
// non-serializable payload degrades to null rather than dropping the whole record.
const serializeMeta = operation(function* (meta: Record<string, unknown> | undefined) {
  if (!meta || Object.keys(meta).length === 0) {
    return null
  }
  const out = yield* attempt(JsonCodec.actions.stringify(meta))
  return isSuccess(out) ? (out.value as string) : null
})

const flushBuffers = operation(function* () {
  if (!store && !forward) {
    return
  }
  const storedCalls: MetricsDef.StoredCall[] = []
  const storedLogs: MetricsDef.StoredLog[] = []
  const storedEvents: MetricsDef.StoredEvent[] = []
  if (calls.length > 0) {
    const batch = calls
    calls = []
    for (const c of batch) {
      storedCalls.push({
        ts: c.ts,
        service: c.service,
        action: c.action,
        status: c.status,
        durationMs: c.durationMs,
        requestId: c.requestId ?? null,
        error: c.error ?? null,
        meta: yield* serializeMeta(c.meta),
      })
    }
  }
  if (logs.length > 0) {
    const batch = logs
    logs = []
    for (const l of batch) {
      storedLogs.push({
        ts: l.ts,
        level: l.level,
        msg: l.msg,
        error: l.error,
        meta: yield* serializeMeta(l.meta),
      })
    }
  }
  if (events.length > 0) {
    const batch = events
    events = []
    for (const e of batch) {
      storedEvents.push({
        ts: e.ts,
        name: e.name,
        value: e.value ?? null,
        meta: yield* serializeMeta(e.meta),
      })
    }
  }
  if (store) {
    if (storedCalls.length > 0) {
      yield* store.insertCalls(storedCalls)
    }
    if (storedLogs.length > 0) {
      yield* store.insertLogs(storedLogs)
    }
    if (storedEvents.length > 0) {
      yield* store.insertEvents(storedEvents)
    }
    return
  }
  // Forward: ONE batched `ingest` per flush, at-most-once by design — a failed ship is kept for the
  // next flush (capped) because the common failure is the boot window, not a dead sink.
  const batch: MetricsDef.IngestBatch = {
    calls: [...(pending?.calls ?? []), ...storedCalls].slice(-FORWARD_PENDING_CAP),
    logs: [...(pending?.logs ?? []), ...storedLogs].slice(-FORWARD_PENDING_CAP),
    events: [...(pending?.events ?? []), ...storedEvents].slice(-FORWARD_PENDING_CAP),
  }
  if (batch.calls.length === 0 && batch.logs.length === 0 && batch.events.length === 0) {
    pending = null
    return
  }
  const shipped = yield* attempt(callSink<void>('ingest', batch))
  pending = isSuccess(shipped) ? null : batch
})

// Telemetry must never take the process down: a failed flush is logged and its batch dropped (the
// records already left the buffers, so a dead store cannot grow memory either). Logged on state
// CHANGE only — a permanently broken store warns once, not once per interval — and through the
// Logger when one is installed; the metrics log transport buffers that line like any other, so a
// broken store drops it with the next batch instead of amplifying itself.
const flushSafely = operation(function* () {
  const flushed = yield* attempt(flushBuffers())
  if (isSuccess(flushed)) {
    if (flushBroken) {
      flushBroken = false
      if ((yield* Logger.context.get()) !== undefined) {
        yield* Logger.actions.info('metrics: flush recovered')
      }
    }
    return
  }
  if (!flushBroken) {
    flushBroken = true
    if ((yield* Logger.context.get()) !== undefined) {
      yield* Logger.actions.warn(
        'metrics: flush failed — dropping batches until the store recovers',
        flushed.message || String(flushed.error),
      )
    }
  }
})

export const flushLoop = operation(function* (intervalMs: number) {
  for (;;) {
    yield* sleep(intervalMs)
    yield* flushSafely()
  }
})

export const closeStore = operation(function* () {
  if (forward) {
    yield* flushSafely()
    forward = false
    pending = null
    return
  }
  if (!store) {
    return
  }
  // teardown must reach `close()` even when the final flush fails
  yield* flushSafely()
  const current = store
  store = null
  yield* current.close()
})

// --- query helpers ---------------------------------------------------------------------------------
// The filterable columns a MongoDB-style `find` compiles against: the built-in sets for calls/logs/
// events, or the columns registered via `define` for a user table (empty → filters ignored).
const filterColumnsFor = (table: string): readonly Column[] =>
  table === 'calls'
    ? CALL_FILTER_COLUMNS
    : table === 'logs'
      ? LOG_FILTER_COLUMNS
      : table === 'events'
        ? EVENT_FILTER_COLUMNS
        : (definedColumns.get(table) ?? [])

// Decode each row's `meta` (JsonCodec text) back into its custom fields and merge them AMONG the row's
// own fields — so custom fields come back exactly as inserted, never stripped.
const decodeRows = operation(function* (rows: readonly MetricsDef.Row[]) {
  const out: MetricsDef.Row[] = []
  for (const row of rows) {
    const rawMeta = row.meta
    const { meta: _meta, ...rest } = row
    if (typeof rawMeta === 'string' && rawMeta.length > 0) {
      const parsed = yield* attempt(JsonCodec.actions.parse(rawMeta))
      out.push(isSuccess(parsed) ? { ...rest, ...(parsed.value as MetricsDef.Row) } : rest)
    } else {
      out.push(rest)
    }
  }
  return out
})

export const requireStore = operation(function* () {
  if (!store) {
    return yield* fail('unexpected', 'metrics store not installed')
  }
  return store
})

// --- actions (wired into the `Metrics` protocol in ./definition) -----------------------------------
export const findAction = operation(function* (spec: MetricsDef.FindSpec) {
  yield* flushBuffers()
  if (forward) {
    return yield* callSink<MetricsDef.Row[]>('find', spec)
  }
  const current = yield* requireStore()
  const compiled = spec.filter ? compileFilter(spec.filter, filterColumnsFor(spec.table)) : null
  const where = compiled ? sql.fragment`WHERE ${compiled}` : sql.fragment``
  const direction = spec.order === 'desc' ? sql.fragment`DESC` : sql.fragment`ASC`
  const orderBy = sql.fragment`ORDER BY ${sql.identifier([spec.sort ?? 'ts'])} ${direction}`
  const limit = spec.limit ? sql.fragment`LIMIT ${Math.trunc(spec.limit)}` : sql.fragment``
  const token = sql`SELECT * FROM ${sql.identifier([spec.table])} ${where} ${orderBy} ${limit}`
  return yield* decodeRows(yield* current.query(token.sql, token.values))
})

export const queryAction = operation(function* (sqlText: string, params?: readonly unknown[]) {
  yield* flushBuffers()
  if (forward) {
    return yield* callSink<MetricsDef.Row[]>('query', { sql: sqlText, params: params ?? [] })
  }
  const current = yield* requireStore()
  return (yield* current.query(sqlText, params ?? [])) as MetricsDef.Row[]
})

/** Which dialect a `query` must be written in — asked of the store that will actually run it. In
 * forward mode that store is the sink's, one broker hop away, so the answer comes from there. */
export const dialectAction = operation(function* () {
  if (forward) {
    return yield* callSink<MetricsDef.Dialect>('dialect')
  }
  return (yield* requireStore()).dialect
})

export const recordAction = operation(function* (spec: MetricsDef.RecordSpec) {
  pushEvent({ ts: Date.now(), name: spec.name, value: spec.value, meta: spec.fields })
})

export const defineAction = operation(function* (spec: MetricsDef.DefineSpec) {
  if (forward) {
    // the sink keeps the `definedColumns` bookkeeping too, so a later delegated `find` compiles there
    return yield* callSink<void>('define', spec)
  }
  const current = yield* requireStore()
  yield* current.define(spec)
  // Remember the columns so `find` can compile MongoDB-style filters against this table too.
  definedColumns.set(
    spec.table,
    Object.entries(spec.columns).map(([name, kind]) => ({
      name,
      kind,
      optional: true,
      hasDefault: false,
      enumValues: null,
      reference: null,
    })),
  )
})

export const insertAction = operation(function* (spec: MetricsDef.InsertSpec) {
  if (forward) {
    return yield* callSink<void>('insert', spec)
  }
  const current = yield* requireStore()
  const columns = Object.keys(spec.row)
  if (columns.length === 0) {
    return
  }
  // Bind values as-is; an object/array is stored as JsonCodec text (never a native JSON column).
  const values: unknown[] = []
  for (const column of columns) {
    const value = spec.row[column]
    values.push(
      value !== null && typeof value === 'object'
        ? yield* JsonCodec.actions.stringify(value)
        : value,
    )
  }
  yield* current.insertRow({ table: spec.table, columns, values })
})

export const exportAction = operation(function* (spec: MetricsDef.TransferSpec) {
  yield* flushBuffers()
  if (forward) {
    // the file lands on the SINK's filesystem — that is where the table lives
    return yield* callSink<void>('export', spec)
  }
  const current = yield* requireStore()
  if (!current.export) {
    return yield* fail('unsupported', 'this metrics store does not support file export')
  }
  yield* current.export(spec)
})

export const importAction = operation(function* (spec: MetricsDef.TransferSpec) {
  if (forward) {
    return yield* callSink<void>('import', spec)
  }
  const current = yield* requireStore()
  if (!current.import) {
    return yield* fail('unsupported', 'this metrics store does not support file import')
  }
  yield* current.import(spec)
})

export const pruneAction = operation(function* (spec: MetricsDef.PruneSpec) {
  yield* flushBuffers()
  if (forward) {
    return yield* callSink<number>('prune', spec)
  }
  return (yield* (yield* requireStore()).prune(spec)) as number
})

export const flushAction = operation(function* () {
  yield* flushBuffers()
})
