// oxlint-disable import/exports-last
import { ensure, operation, spawn } from 'std:effect'
import { LoggerTransport, LogLevel } from 'std:logger'
import { defineProtocol, install } from 'std:plugin'
import type { AnyType } from 'std:shared'

import { MetricsPolicy } from 'server:policy/metrics'

import {
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_STORE_PATH,
  METRICS_SERVICE_NAME,
  METRICS_SUBTYPE,
} from './const'
import { createDuckdbStore } from './drivers/duckdb'
import {
  closeStore,
  defineAction,
  dialectAction,
  exportAction,
  findAction,
  flushAction,
  flushLoop,
  importAction,
  insertAction,
  pruneAction,
  pushCall,
  queryAction,
  recordAction,
  setForward,
  setStore,
} from './internal/metric'
import { writeAction } from './internal/transport'
import type { MetricsDef } from './types'

/** The metrics/analytics protocol — resolve it for `Metrics.actions.find/query/export/import/prune/…`. */
export const Metrics = defineProtocol<
  MetricsDef.Context,
  [options?: MetricsDef.Options],
  MetricsDef.Actions
>({
  name: 'server-metrics',
  version: '0.0.1',
  subtype: METRICS_SUBTYPE,
})

const MetricsLogTransportImpl = LoggerTransport.implement<
  { name: string; level: LogLevel },
  [options?: { level?: LogLevel }]
>({
  name: 'metrics-log-transport',
  version: '0.0.1',
  *setup(options = {}) {
    return { name: 'metrics', level: options.level ?? LogLevel.trace }
  },
})

/** A {@link LoggerTransport} that captures every log line into the metrics `logs` store — installed
 * automatically by {@link MetricsCollector} when `logs !== false`. */
export const MetricsLogTransport = MetricsLogTransportImpl.build({
  write: writeAction,
  flush: flushAction,
  close: operation(function* () {}),
})

/**
 * The metrics collector plugin — `install(MetricsCollector, { path })`. Self-contained: opens its OWN
 * DuckDB store (isolated from the app database) and — unless disabled — auto-instruments every action
 * call into `calls` (installing the {@link MetricsPolicy}, applied to every dispatch) and captures every
 * log line into `logs` (installing {@link MetricsLogTransport}). Custom fields are preserved through a
 * JsonCodec `meta` column; query with the MongoDB-style `find`, raw `query` for aggregations,
 * `export`/`import` for Parquet/CSV/JSON, `prune` for retention. Requires a Broker and, for logs, a
 * Logger.
 *
 * In a split deployment, `sink: 'forward'` turns the collector into a shipper: no local store —
 * flushes batch to the `MetricsSink` service over the broker and every read delegates there too, so
 * `Metrics.actions.*` works identically from any process. See {@link MetricsSink}.
 */
export const MetricsCollector = Metrics.implement({
  name: 'metrics-collector',
  version: '0.0.1',
  *setup(options: MetricsDef.Options = {}) {
    let store: MetricsDef.Store | null = null
    if (options.sink === 'forward') {
      // forward mode: no local store — buffers ship to the `metrics-sink` service at flush
      setForward()
    } else {
      store = options.store ?? createDuckdbStore(options.path ?? DEFAULT_STORE_PATH)
      yield* store.init()
      setStore(store)
    }

    if (options.calls !== false) {
      // The sink's own traffic is excluded in BOTH modes — otherwise every forward flush records
      // its own `ingest` call and echoes one row per interval forever.
      yield* install(MetricsPolicy, {
        onSuccess: event => {
          if (event.serviceName === METRICS_SERVICE_NAME) {
            return
          }
          pushCall({
            ts: event.startedAt,
            service: event.serviceName,
            action: event.actionKey,
            status: 'success',
            durationMs: event.durationMs,
            meta: options.fields?.({
              service: event.serviceName,
              action: event.actionKey,
              status: 'success',
              value: event.value,
            }),
          })
        },
        onFailure: event => {
          if (event.serviceName === METRICS_SERVICE_NAME) {
            return
          }
          pushCall({
            ts: event.startedAt,
            service: event.serviceName,
            action: event.actionKey,
            status: 'failure',
            durationMs: event.durationMs,
            error: String((event.failure as AnyType)?.message ?? 'failure'),
            meta: options.fields?.({
              service: event.serviceName,
              action: event.actionKey,
              status: 'failure',
            }),
          })
        },
      })
    }

    if (options.logs !== false) {
      yield* install(MetricsLogTransport)
    }

    yield* spawn(() => flushLoop(options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS))
    yield* ensure(function* () {
      yield* closeStore()
    })

    return { store }
  },
}).build({
  define: defineAction,
  insert: insertAction,
  record: recordAction,
  find: findAction,
  query: queryAction,
  dialect: dialectAction,
  export: exportAction,
  import: importAction,
  prune: pruneAction,
  flush: flushAction,
})
