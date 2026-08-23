import type { ServerDef, Sink } from 'server:core'
import { createSink, Server, ServerErrors } from 'server:core'
import { definePlugin } from 'std:plugin'
import { fail } from 'std:result'

import { attributesOf, otlpFailure, otlpLog, otlpSpan, post } from './internal'
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

    const spans: Sink<Record<string, unknown>> = createSink({
      ...options.batch,
      *send(rows) {
        yield* post(
          { url: `${base}/v1/traces`, headers, fetch: doFetch },
          { resourceSpans: [{ resource, scopeSpans: [{ scope, spans: rows }] }] },
        )
      },
    })
    const logs: Sink<Record<string, unknown>> = createSink({
      ...options.batch,
      *send(rows) {
        yield* post(
          { url: `${base}/v1/logs`, headers, fetch: doFetch },
          { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: rows }] }] },
        )
      },
    })
    const withLogs = options.logs ?? true

    const hooks: ServerDef.Hooks = {
      name: 'otlp',
      *observe(event) {
        if (event.t === 'span') {
          spans.push(otlpSpan(event.row))
        } else if (withLogs && event.t === 'log') {
          logs.push(otlpLog(event.row))
        } else if (withLogs && event.t === 'failure') {
          logs.push(otlpFailure(event.row))
        }
      },
      *start() {
        yield* spans.start()
        yield* logs.start()
      },
      *stop() {
        yield* spans.flush()
        yield* logs.flush()
      },
    }
    return {
      url: base,
      stats: () => ({ spans: spans.stats, logs: logs.stats }),
      hooks,
    }
  },
}).build()
