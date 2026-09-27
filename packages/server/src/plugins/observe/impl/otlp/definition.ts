import type { ObserveDef } from 'server:core'
import { ObserveExporter, Server, ServerErrors } from 'server:core'
import { fail } from 'std:result'

import pkg from '../../../../../package.json'

import type { OtlpDef } from './types/otlp'
import { createOtlpPipeline } from './utils/pipeline'

/**
 * OTLP/HTTP exporter of what the kernel observes — protobuf by default (`encoding: 'json'` for
 * OTLP/JSON): every finished span to `{url}/v1/traces`, every log record (logger lines,
 * exceptions, events, domain records) to `{url}/v1/logs`, and the metrics derived from them
 * (`http.server.request.duration`, `rpc.{server,client}.call.duration`, `ozaco.action.duration`,
 * `messaging.process.duration`, `ozaco.ws.*`, `ozaco.service.up`, plus the kernel's live
 * `http.server.active_requests`) to `{url}/v1/metrics` every
 * `metrics.intervalMs` and at stop. One resource block per (service.name, instance) of the
 * records (the kernel's resource — the process's `OTEL_RESOURCE_ATTRIBUTES` included, as in every
 * other sink), one scope block per instrumentation scope.
 *
 * Options are TRANSPORT ONLY — the content is the kernel's, identical in every sink. Batched per
 * signal (a full batch leaves at once), retried on 429/502/503/504 and network errors, timed out,
 * `partialSuccess` counted; delivery problems land in `stats()` and one WARN per failure streak
 * (the std Logger, suppressed; else `console.warn`) — never in a request. An `ObserveExporter`
 * impl: it runs next to any other exporter, with or without `ObservePlugin`.
 */
const OtlpExporterImpl = ObserveExporter.implement<OtlpDef.Context, [options: OtlpDef.Options]>({
  name: 'server-observe-otlp',
  version: pkg.version,
  description: 'OTLP/HTTP exporter (protobuf or JSON) of spans, log records and their metrics',

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

    return { exporter: 'otlp', ...(yield* createOtlpPipeline(kernel, options)) }
  },
})

export const OtlpExporter = OtlpExporterImpl.build({
  *export(event: ObserveDef.Event) {
    yield* (yield* OtlpExporterImpl.context.expect()).handle.export(event)
  },
  *start() {
    yield* (yield* OtlpExporterImpl.context.expect()).handle.start()
  },
  *flush() {
    yield* (yield* OtlpExporterImpl.context.expect()).handle.flush()
  },
})
