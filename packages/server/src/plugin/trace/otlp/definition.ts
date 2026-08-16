// oxlint-disable import/exports-last
import { TraceExporter } from 'server:core'
import type { TracerDef } from 'server:core'
import { moduleLogger } from 'server:utils'
import { hasCodec } from 'std:codec'
import { attempt, operation } from 'std:effect'
import { Fetch } from 'std:fetch'
import { install } from 'std:plugin'
import { fail, isFailure } from 'std:result'
import { createTags } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'

import { encodeSpans } from './internal'
import type { OtlpExporterContext, OtlpExporterOptions } from './types'

/** Failure tags raised by the OTLP exporter (`OtlpErrors.Export` = `server:trace/otlp.export`). */
export const OtlpErrors = createTags('server:trace/otlp', 'export')

const DEFAULT_PATH = '/v1/traces'
const DEFAULT_SERVICE_NAME = 'ozaco-server'
const DEFAULT_TIMEOUT_MS = 10_000

const OtlpExporterImpl = TraceExporter.implement<
  OtlpExporterContext,
  [options: OtlpExporterOptions]
>({
  name: 'otlp-exporter',
  version: '0.1.0',
  description: 'OTLP/HTTP JSON span exporter (otel-collector, Datadog Agent, Tempo)',

  *setup(options) {
    if (!(yield* hasCodec())) {
      yield* install(JsonCodec)
    }

    const path = options.path ?? DEFAULT_PATH

    return {
      url: `${options.endpoint.replace(/\/+$/u, '')}${path.startsWith('/') ? path : `/${path}`}`,
      headers: options.headers ?? {},
      serviceName: options.serviceName ?? DEFAULT_SERVICE_NAME,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      log: yield* moduleLogger('server:trace/otlp'),
    }
  },
})

const post = operation(function* (ctx: OtlpExporterContext, body: string) {
  const response = yield* Fetch.actions.request(ctx.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ctx.headers },
    body,
    timeoutMs: ctx.timeoutMs,
  })

  yield* response.expect()
})

/**
 * A `TraceExporter` POSTing OTLP/HTTP **JSON** (the protobuf-JSON mapping) through the `Fetch`
 * plugin — install `FetchClient` alongside. A non-2xx response or network failure is logged and
 * fails with `OtlpErrors.Export`; the `DefaultTracer` pump attempts every export, so a dead
 * collector never breaks the app. `flush` is a no-op — batching lives in the tracer.
 */
export const OtlpExporter = OtlpExporterImpl.build({
  export: operation(function* (spans: readonly TracerDef.SpanSnapshot[]) {
    if (spans.length === 0) {
      return
    }

    const ctx = yield* OtlpExporterImpl.context.expect()
    const body = yield* JsonCodec.actions.stringify(encodeSpans(spans, ctx.serviceName))
    const outcome = yield* attempt(() => post(ctx, body))

    if (isFailure(outcome)) {
      yield* ctx.log.warn('otlp export failed', {
        url: ctx.url,
        spans: spans.length,
        error: String(outcome.error),
      })

      return yield* fail(
        OtlpErrors.Export,
        `OTLP export of ${spans.length} span(s) to "${ctx.url}" failed`,
        ...outcome.causes,
      )
    }
  }),

  flush: operation(function* () {
    // batching (and the final drain) lives in DefaultTracer — nothing buffered here
  }),
})
