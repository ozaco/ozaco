import { defineAction, defineService } from 'server:core'

import { z } from 'zod'

import { METRICS_SERVICE_NAME } from './const'
import {
  defineAction as defineTableAction,
  dialectAction,
  exportAction,
  findAction,
  flushAction,
  importAction,
  insertAction,
  pruneAction,
  queryAction,
  requireStore,
} from './internal/metric'
import type { MetricsDef } from './types'

// Rows arrive pre-serialized (`meta` is already JsonCodec text) — the schema mirrors Stored* exactly.
const storedCall = z.object({
  ts: z.number(),
  service: z.string(),
  action: z.string(),
  status: z.string(),
  durationMs: z.number(),
  error: z.string().nullable(),
  meta: z.string().nullable(),
})
const storedLog = z.object({
  ts: z.number(),
  level: z.number(),
  msg: z.string(),
  error: z.string(),
  meta: z.string().nullable(),
})
const storedEvent = z.object({
  ts: z.number(),
  name: z.string(),
  value: z.number().nullable(),
  meta: z.string().nullable(),
})

/**
 * The metrics sink SERVICE — the receiving half of `sink: 'forward'`. Register it (via the broker or
 * a daemon module) in exactly ONE process that runs {@link MetricsCollector} in `'store'` mode (the
 * store is single-writer); every forward-mode process then ships its batches here by address
 * (`metrics-sink`), and their `Metrics.actions.find/query/…` delegate here too, so consumers stay
 * topology-blind. Actions carry no gateway settings on purpose — the sink is broker-only unless an
 * app explicitly mounts it.
 */
export const MetricsSink = defineService({
  name: METRICS_SERVICE_NAME,
  version: '0.0.1',
  actions: {
    ingest: defineAction(
      {
        input: z.object({
          calls: z.array(storedCall),
          logs: z.array(storedLog),
          events: z.array(storedEvent),
        }),
      },
      function* (batch: MetricsDef.IngestBatch) {
        const store = yield* requireStore()
        if (batch.calls.length > 0) {
          yield* store.insertCalls(batch.calls)
        }
        if (batch.logs.length > 0) {
          yield* store.insertLogs(batch.logs)
        }
        if (batch.events.length > 0) {
          yield* store.insertEvents(batch.events)
        }
      },
    ),
    find: defineAction(function* (spec: MetricsDef.FindSpec) {
      return yield* findAction(spec)
    }),
    query: defineAction(
      { input: z.object({ sql: z.string(), params: z.array(z.unknown()).optional() }) },
      function* (spec: MetricsDef.QuerySpec) {
        return yield* queryAction(spec.sql, spec.params)
      },
    ),
    /** What flavour of SQL this sink's store speaks — the answer forward-mode callers cannot derive
     * locally, because the store they will be querying is this one. */
    dialect: defineAction(function* () {
      return yield* dialectAction()
    }),
    define: defineAction(function* (spec: MetricsDef.DefineSpec) {
      yield* defineTableAction(spec)
    }),
    insert: defineAction(function* (spec: MetricsDef.InsertSpec) {
      yield* insertAction(spec)
    }),
    export: defineAction(function* (spec: MetricsDef.TransferSpec) {
      yield* exportAction(spec)
    }),
    import: defineAction(function* (spec: MetricsDef.TransferSpec) {
      yield* importAction(spec)
    }),
    prune: defineAction(function* (spec: MetricsDef.PruneSpec) {
      return yield* pruneAction(spec)
    }),
    flush: defineAction(function* () {
      yield* flushAction()
    }),
  },
  *setup() {},
})
