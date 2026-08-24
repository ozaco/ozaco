import type { ServerDef, Sink } from 'server:core'
import { createSink, Server, ServerErrors } from 'server:core'
import { attempt, fork, sleep } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import {
  attributesOf,
  createOtlpMetrics,
  DEFAULT_BUCKETS,
  nanos,
  otlpFailure,
  otlpLog,
  otlpSpan,
  post,
} from './internal'
import type { OtlpDef } from './types'

/**
 * OTLP/HTTP (JSON) exporter of what the kernel observes: every span becomes an OTLP span under
 * the request's trace (`v1/traces`), logs and failures become log records (`v1/logs`) — so any
 * collector (Jaeger, Tempo, Grafana, Datadog, …) sees the same spine the `_ob_*` tables hold.
 * Batched in memory; delivery failures are counted (`stats()`), never raised into requests.
 */
export const OtlpExporter = definePlugin<OtlpDef.Context, [options: OtlpDef.Options]>({
  name: 'server-observe-otlp',
  version: '0.5.0',
  description: 'OTLP/HTTP exporter of spans, logs and failures',

  *setup(options) {
    const kernel = yield* Server.context.get()
    if (!kernel) {
      return yield* fail(
        ServerErrors.Configuration,
        'OtlpExporter must be installed by createServer',
      )
    }
    if (!options?.url) {
      return yield* fail(ServerErrors.Configuration, 'OtlpExporter needs a collector url')
    }
    const base = options.url.replace(/\/$/u, '')
    const doFetch = options.fetch ?? fetch
    const headers = { ...options.headers }
    const resource = {
      attributes: attributesOf({
        'service.name': options.serviceName ?? kernel.name,
        'service.version': kernel.version,
        'service.instance.id': kernel.instance,
        ...options.resource,
      }),
    }
    const scope = { name: '@ozaco/server', version: '0.5.0' }

    const complain = (target: string) => (failure: unknown) =>
      console.warn(
        `[otlp] ${target} delivery failing: ${String((failure as AnyType)?.message ?? failure)}`,
      )

    const spans: Sink<Record<string, unknown>> = createSink({
      ...options.batch,
      onError: complain('trace'),
      *send(rows) {
        yield* post(
          { url: `${base}/v1/traces`, headers, fetch: doFetch },
          { resourceSpans: [{ resource, scopeSpans: [{ scope, spans: rows }] }] },
        )
      },
    })
    const logs: Sink<Record<string, unknown>> = createSink({
      ...options.batch,
      onError: complain('log'),
      *send(rows) {
        yield* post(
          { url: `${base}/v1/logs`, headers, fetch: doFetch },
          { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: rows }] }] },
        )
      },
    })
    const withLogs = options.logs ?? true

    // CUMULATIVE metrics, exported on a fixed beat (counters survive between exports)
    const withMetrics = options.metrics !== false
    const metricsConfig = options.metrics === false ? undefined : options.metrics
    const meter = createOtlpMetrics(metricsConfig?.buckets ?? DEFAULT_BUCKETS)
    const metricsStats = { sent: 0, dropped: 0, failed: 0 }
    const startNano = nanos(Date.now())

    const exportMetrics = function* () {
      const nowNano = nanos(Date.now())
      const metrics = meter.snapshot(startNano, nowNano)

      // the HEALTH beat: one `up` point per hosted service (absence = the node is gone) and
      // the live in-flight request count — exported every interval even when nothing ran
      const upPoints = [...kernel.hosted].map(service => ({
        attributes: attributesOf({ 'ozaco.service': service }),
        timeUnixNano: nowNano,
        asInt: '1',
      }))

      metrics.push(
        {
          name: 'ozaco.up',
          unit: '1',
          gauge: {
            dataPoints:
              upPoints.length > 0
                ? upPoints
                : [{ attributes: [], timeUnixNano: nowNano, asInt: '1' }],
          },
        },
        {
          name: 'ozaco.inflight',
          unit: '1',
          gauge: {
            dataPoints: [{ attributes: [], timeUnixNano: nowNano, asInt: String(kernel.inflight) }],
          },
        },
      )

      const outcome = yield* attempt(() =>
        post(
          { url: `${base}/v1/metrics`, headers, fetch: doFetch },
          { resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics }] }] },
        ),
      )

      if (isFailure(outcome)) {
        metricsStats.failed += 1

        if (metricsStats.failed === 1 || metricsStats.sent > 0) {
          complain('metric')(outcome)
        }

        metricsStats.sent = 0
      } else {
        metricsStats.sent += 1
      }
    }

    const hooks: ServerDef.Hooks = {
      name: 'otlp',
      *observe(event) {
        if (event.t === 'span') {
          spans.push(otlpSpan(event.row))

          if (withMetrics) {
            meter.record(event.row)
          }
        } else if (event.t === 'log') {
          if (withLogs) {
            logs.push(otlpLog(event.row))
          }
        } else if (event.t === 'failure') {
          if (withLogs) {
            logs.push(otlpFailure(event.row))
          }

          if (withMetrics) {
            meter.failure(event.row)
          }
        }
      },
      *start() {
        yield* spans.start()
        yield* logs.start()

        if (withMetrics) {
          const intervalMs = metricsConfig?.intervalMs ?? 10_000

          yield* fork(function* () {
            for (;;) {
              yield* sleep(intervalMs)
              yield* exportMetrics()
            }
          })
        }
      },
      *stop() {
        yield* spans.flush()
        yield* logs.flush()

        if (withMetrics) {
          yield* exportMetrics()
        }
      },
    }
    return {
      url: base,
      stats: () => ({ spans: spans.stats, logs: logs.stats, metrics: metricsStats }),
      hooks,
    }
  },
}).build()
