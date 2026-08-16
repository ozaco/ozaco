import { CoreErrors, MetricsStore } from 'server:core'
import type { MetricsStoreDef } from 'server:core'
import { moduleLogger } from 'server:utils'
import { attempt, ensure, fork, operation, sleep, useContext } from 'std:effect'
import type { Operation } from 'std:effect'
import { LoggerTransport } from 'std:logger'
import type { LoggerDef } from 'std:logger'
import { definePlugin, install } from 'std:plugin'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { MetricsPolicy, MetricsSinkContext } from 'server:policy/metrics'

import { DEFAULT_FLUSH_INTERVAL_MS, DEFAULT_LOG_LEVEL } from './const'
import { flushAll, MetricsCollectorContext, pushCapped, tryStringify } from './internal'
import type { MetricsDef, MetricsOptions, ObserveTarget } from './types'

const MetricsLogTransportImpl = LoggerTransport.implement<
  MetricsDef.LogTransportContext,
  [options?: MetricsDef.LogTransportOptions]
>({
  name: 'metrics-log-transport',
  version: '0.1.0',
  *setup(options = {}) {
    return { name: 'metrics', level: options.level ?? DEFAULT_LOG_LEVEL }
  },
})

const bindingString = (
  bindings: Record<string, unknown>,
  key: 'requestId' | 'serviceId' | 'actionId',
): string | undefined => {
  const value = bindings[key]

  return typeof value === 'string' ? value : undefined
}

const MetricsImpl = definePlugin<MetricsDef.State, [options?: MetricsOptions]>({
  name: 'server/metrics',
  version: '0.1.0',
  description: 'scope-bound metrics collector: calls (observer policy), logs, custom events',

  *setup(options = {}) {
    const log = yield* moduleLogger('server:metrics')

    // a store must be installed FIRST — the protocol's failing default surfaces here
    const init = yield* attempt(() => MetricsStore.actions.init())

    if (isFailure(init)) {
      if (String(init.error) === CoreErrors.Unsupported) {
        return yield* fail(
          CoreErrors.Configuration,
          'install a metrics store first (server:plugin/metrics/memory or server:plugin/metrics/starrocks)',
          ...init.causes,
        )
      }

      return yield* init
    }

    const state: MetricsDef.State = {
      options: {
        flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
        captureLogs: options.captureLogs ?? true,
        logLevel: options.logLevel ?? DEFAULT_LOG_LEVEL,
        fields: options.fields,
      },
      buffers: { calls: [], logs: [], events: [] },
      log,
      insertFailures: { calls: 0, logs: 0, events: 0 },
    }

    yield* MetricsCollectorContext.set(state)

    // the sink the observer policy calls is sync and isolated — it only ever pushes into the
    // scope-bound buffer (capped, oldest dropped), serialization is deferred to flush time
    yield* MetricsSinkContext.set({
      call: event => pushCapped(state.buffers.calls, event),
    })

    yield* install(MetricsPolicy)

    if (state.options.captureLogs) {
      yield* install(MetricsLogTransport, { level: state.options.logLevel })
    }

    // teardown (registered before the pump so it runs AFTER the pump is halted): one final
    // drain, then the store is released
    yield* ensure(function* () {
      yield* flushAll(state)
      yield* attempt(() => MetricsStore.actions.close())
    })

    yield* fork(function* () {
      while (true) {
        yield* sleep(state.options.flushIntervalMs)
        yield* flushAll(state)
      }
    })

    yield* log.debug('metrics collector ready', {
      flushIntervalMs: state.options.flushIntervalMs,
      captureLogs: state.options.captureLogs,
    })

    return state
  },
})

const timing = (state: MetricsDef.State, name: string) =>
  function* (args: AnyType[], next: (...forward: AnyType[]) => Operation<AnyType>) {
    const started = Date.now()

    try {
      return yield* next(...args)
    } finally {
      pushCapped(state.buffers.events, {
        ts: started,
        name,
        value: Date.now() - started,
      })
    }
  }

/**
 * A `LoggerTransport` impl feeding the metrics collector: entries at (or above) the level floor
 * become `MetricsStoreDef.LogRecord` rows in the collector's `logs` buffer, with the correlation ids lifted from
 * the per-call bindings the invoker plants. Installed by `Metrics` when `captureLogs` is on; a
 * write outside a collector scope is a no-op.
 */
export const MetricsLogTransport = MetricsLogTransportImpl.build({
  write: operation(function* (entry: LoggerDef.Entry) {
    const ctx = yield* useContext(MetricsLogTransportImpl.context)

    if (entry.level < ctx.level) {
      return
    }

    const state = yield* MetricsCollectorContext.get()

    if (!state) {
      return
    }

    const record: MetricsStoreDef.LogRecord = {
      ts: entry.time,
      level: entry.level,
      msg: entry.msg,
      requestId: bindingString(entry.bindings, 'requestId'),
      serviceId: bindingString(entry.bindings, 'serviceId'),
      actionId: bindingString(entry.bindings, 'actionId'),
      error: entry.error || undefined,
      meta: entry.data === undefined ? undefined : yield* tryStringify(entry.data),
    }

    pushCapped(state.buffers.logs, record)
  }),

  flush: operation(function* () {}),

  close: operation(function* () {}),
})

/**
 * The metrics collector plugin. Requires an installed `MetricsStore` impl
 * (`server:plugin/metrics/memory`, `server:plugin/metrics/starrocks`). Installing it plants the
 * observer-policy sink (every dispatch → `calls`), captures warn+ log entries (→ `logs`), and
 * flushes buffered rows into the store on an interval plus once on scope teardown.
 */
export const Metrics = MetricsImpl.build({
  /** Land a custom row in the `events` table at the next flush. */
  record: operation(function* (name: string, value?: number, meta?: Record<string, unknown>) {
    const state = yield* MetricsCollectorContext.expect()
    const metaText = meta === undefined ? undefined : yield* tryStringify(meta)

    pushCapped(state.buffers.events, { ts: Date.now(), name, value, meta: metaText })
  }),

  /** Drain every buffer into the store right now (the interval pump keeps running). */
  flush: operation(function* () {
    const state = yield* MetricsCollectorContext.expect()

    yield* flushAll(state)
  }),

  query: operation(function* (spec: MetricsStoreDef.QuerySpec) {
    return yield* MetricsStore.actions.query(spec)
  }),

  /** Raw SQL escape hatch — SQL-backed stores only (the memory store fails `unsupported`). */
  sql: operation(function* (statement: string, params?: readonly unknown[]) {
    return yield* MetricsStore.actions.sql(statement, params)
  }),

  define: operation(function* (spec: MetricsStoreDef.DefineSpec) {
    yield* MetricsStore.actions.define(spec)
  }),

  prune: operation(function* (spec: MetricsStoreDef.PruneSpec) {
    return yield* MetricsStore.actions.prune(spec)
  }),

  /**
   * Attach timing observers to ANY protocol handle (Broker, Transport, a DbAdapter, ...): each
   * listed action is wrapped with an `around` hook that lands a `${name}.${action}` duration row
   * in the `events` table. Hooks are scope-scoped — they detach when the calling scope closes.
   */
  observe: operation(function* (targets: readonly ObserveTarget[]) {
    const state = yield* MetricsCollectorContext.expect()

    for (const target of targets) {
      const handlers = Object.fromEntries(
        target.actions.map(key => [key, timing(state, `${target.name}.${key}`)]),
      )

      yield* target.api.around(handlers as AnyType)
    }
  }),
})
