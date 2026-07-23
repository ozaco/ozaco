// oxlint-disable import/exports-last
import { sql } from 'db:core'
import type { Column } from 'db:realtime'
import { compileFilter } from 'db:realtime'
import { attempt, operation, sleep } from 'std:effect'
import { fail, isSuccess } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import { CALL_FILTER_COLUMNS, EVENT_FILTER_COLUMNS, LOG_FILTER_COLUMNS } from '../const'
import type { MetricsDef } from '../types'

// --- collector -------------------------------------------------------------------------------------
// Module-level so the metrics policy's SYNC hooks and the logger transport can push without crossing an
// effect boundary; a spawned loop (plus flush-on-query and flush-on-close) drains the buffers to the
// store in batches. `meta` (custom fields) is serialized via the JsonCodec at FLUSH time — the codec is
// an effect, so it can't run in the sync push, and buffering the raw object keeps the fields intact.
let store: MetricsDef.Store | null = null
let calls: MetricsDef.CallRecord[] = []
let logs: MetricsDef.LogRecord[] = []
let events: MetricsDef.EventRecord[] = []
// Columns of user-defined tables (from `define`), so a MongoDB-style `find` can compile filters
// against them too — not just the built-in tables.
let definedColumns = new Map<string, readonly Column[]>()

export const setStore = (next: MetricsDef.Store): void => {
  store = next
  calls = []
  logs = []
  events = []
  definedColumns = new Map()
}

export const pushCall = (record: MetricsDef.CallRecord): void => {
  if (store) {
    calls.push(record)
  }
}

export const pushLog = (record: MetricsDef.LogRecord): void => {
  if (store) {
    logs.push(record)
  }
}

const pushEvent = (record: MetricsDef.EventRecord): void => {
  if (store) {
    events.push(record)
  }
}

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
  if (!store) {
    return
  }
  if (calls.length > 0) {
    const batch = calls
    calls = []
    const stored: MetricsDef.StoredCall[] = []
    for (const c of batch) {
      stored.push({
        ts: c.ts,
        service: c.service,
        action: c.action,
        status: c.status,
        durationMs: c.durationMs,
        error: c.error ?? null,
        meta: yield* serializeMeta(c.meta),
      })
    }
    yield* store.insertCalls(stored)
  }
  if (logs.length > 0) {
    const batch = logs
    logs = []
    const stored: MetricsDef.StoredLog[] = []
    for (const l of batch) {
      stored.push({
        ts: l.ts,
        level: l.level,
        msg: l.msg,
        error: l.error,
        meta: yield* serializeMeta(l.meta),
      })
    }
    yield* store.insertLogs(stored)
  }
  if (events.length > 0) {
    const batch = events
    events = []
    const stored: MetricsDef.StoredEvent[] = []
    for (const e of batch) {
      stored.push({
        ts: e.ts,
        name: e.name,
        value: e.value ?? null,
        meta: yield* serializeMeta(e.meta),
      })
    }
    yield* store.insertEvents(stored)
  }
})

export const flushLoop = operation(function* (intervalMs: number) {
  for (;;) {
    yield* sleep(intervalMs)
    yield* flushBuffers()
  }
})

export const closeStore = operation(function* () {
  if (!store) {
    return
  }
  yield* flushBuffers()
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

const requireStore = operation(function* () {
  if (!store) {
    return yield* fail('unexpected', 'metrics store not installed')
  }
  return store
})

// --- actions (wired into the `Metrics` protocol in ./definition) -----------------------------------
export const findAction = operation(function* (spec: MetricsDef.FindSpec) {
  yield* flushBuffers()
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
  const current = yield* requireStore()
  return (yield* current.query(sqlText, params ?? [])) as MetricsDef.Row[]
})

export const recordAction = operation(function* (spec: MetricsDef.RecordSpec) {
  pushEvent({ ts: Date.now(), name: spec.name, value: spec.value, meta: spec.fields })
})

export const defineAction = operation(function* (spec: MetricsDef.DefineSpec) {
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
  yield* (yield* requireStore()).export(spec)
})

export const importAction = operation(function* (spec: MetricsDef.TransferSpec) {
  yield* (yield* requireStore()).import(spec)
})

export const pruneAction = operation(function* (spec: MetricsDef.PruneSpec) {
  yield* flushBuffers()
  return (yield* (yield* requireStore()).prune(spec)) as number
})

export const flushAction = operation(function* () {
  yield* flushBuffers()
})
