import type { ObserveDef } from 'server:core'
import { ObserveExporter, Server, ServerErrors } from 'server:core'
import { fail } from 'std:result'
import { toBase64 } from 'std:shared'

import pkg from '../../../../../package.json'
import { createOtlpPipeline } from '../otlp'
import type { OtlpDef } from '../otlp'

import type { OpenObserveDef } from './types'

/** `{ token }` → Bearer, `{ user, pass }` → Basic over the UTF-8 bytes (RFC 7617): `btoa`
 * alone throws on anything past Latin-1 — a `ş` in a password would fail the install. */
const authorization = (auth: OpenObserveDef.Options['auth']): Record<string, string> => {
  if (!auth) {
    return {}
  }

  return {
    authorization:
      'token' in auth
        ? `Bearer ${auth.token}`
        : `Basic ${toBase64(new TextEncoder().encode(`${auth.user}:${auth.pass}`))}`,
  }
}

const streamHeaders = (
  stream: OpenObserveDef.Options['stream'],
): Partial<Record<OtlpDef.Signal, Record<string, string>>> => {
  const traces = typeof stream === 'string' ? stream : stream?.traces
  const logs = typeof stream === 'string' ? stream : stream?.logs

  return {
    ...(traces ? { traces: { 'stream-name': traces } } : {}),
    ...(logs ? { logs: { 'stream-name': logs } } : {}),
  }
}

/**
 * OpenObserve exporter: the OTLP pipeline of `OtlpExporter` (the same encoder, content and
 * transport — protobuf by default) against OpenObserve's OTLP/HTTP endpoints
 * `/api/<org>/v1/{traces,logs,metrics}`, with Basic (`{ user, pass }`) or Bearer (`{ token }`)
 * auth and the `stream-name` header. What lands is exactly what every other sink holds — the
 * Traces, Logs and Metrics panels light up from it; there are no `_json` side streams. It runs
 * side by side with an `OtlpExporter` of its own (a collector next to OpenObserve).
 */
const OpenObserveExporterImpl = ObserveExporter.implement<
  OpenObserveDef.Context,
  [options: OpenObserveDef.Options]
>({
  name: 'server-observe-openobserve',
  version: pkg.version,
  description: 'OpenObserve exporter (its OTLP endpoints) of spans, log records and metrics',

  *setup(options) {
    const kernel = yield* Server.context.get()

    if (!kernel) {
      return yield* fail(
        ServerErrors.Configuration,
        'OpenObserveExporter must be installed by createServer',
      )
    }

    if (!options?.url) {
      return yield* fail(ServerErrors.Configuration, 'OpenObserveExporter needs a base url')
    }

    const base = options.url.replace(/\/+$/u, '')
    const org = options.org ?? 'default'

    const pipeline = yield* createOtlpPipeline(kernel, {
      url: `${base}/api/${encodeURIComponent(org)}`,
      headers: { ...options.headers, ...authorization(options.auth) },
      signalHeaders: streamHeaders(options.stream),
      encoding: options.encoding ?? 'protobuf',
      gzip: options.gzip,
      timeoutMs: options.timeoutMs,
      retry: options.retry,
      batch: options.batch,
      metrics: options.metrics,
      fetch: options.fetch,
    })

    return { exporter: 'openobserve', ...pipeline, url: base, org }
  },
})

export const OpenObserveExporter = OpenObserveExporterImpl.build({
  *export(event: ObserveDef.Event) {
    yield* (yield* OpenObserveExporterImpl.context.expect()).handle.export(event)
  },
  *start() {
    yield* (yield* OpenObserveExporterImpl.context.expect()).handle.start()
  },
  *flush() {
    yield* (yield* OpenObserveExporterImpl.context.expect()).handle.flush()
  },
})
