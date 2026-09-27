import type { TraceDef } from 'std:trace'
import { enableTracing, Tracer } from 'std:trace'

let installs = 0

/**
 * An in-memory `Tracer` (tests): every exported span and emitted log record lands in `spans` /
 * `logs`. Installed in a scope it enables tracing there — a server booted in that scope observes
 * (its spans land here too), a client created there traces its calls.
 */
export const memoryTracer = () => {
  installs += 1

  const spans: TraceDef.SpanData[] = []
  const logs: TraceDef.LogData[] = []

  const plugin = Tracer.implement({
    name: `test/client-tracer-${installs}`,
    version: '1.0.0',
    *setup() {
      yield* enableTracing()
      return { spans, logs }
    },
  }).build({
    *export(span: TraceDef.SpanData) {
      spans.push(span)
    },
    *emit(log: TraceDef.LogData) {
      logs.push(log)
    },
  })

  /** The client's own CLIENT spans (scope `@ozaco/client`) named `name`. */
  const client = (name: string): TraceDef.SpanData[] =>
    spans.filter(data => data.scope.name === '@ozaco/client' && data.name === name)

  /** The server's spans of `kind` named `name`. */
  const server = (name: string, kind: TraceDef.SpanKind = 'server'): TraceDef.SpanData[] =>
    spans.filter(
      data => data.scope.name !== '@ozaco/client' && data.kind === kind && data.name === name,
    )

  /** Exception log records (an `exception.type` attribute). */
  const exceptions = (): TraceDef.LogData[] =>
    logs.filter(log => log.attributes['exception.type'] !== undefined)

  return { plugin, spans, logs, client, server, exceptions }
}

export type MemoryTracer = ReturnType<typeof memoryTracer>
