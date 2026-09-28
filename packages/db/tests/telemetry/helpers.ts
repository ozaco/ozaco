// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import { run } from 'std:effect'
import type { LoggerDef } from 'std:logger'
import { DefaultLogger, LoggerTransport, LogLevel } from 'std:logger'
import type { Result } from 'std:result'
import { unwrap } from 'std:result'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

let installs = 0

/**
 * An in-memory `Trace sink`: every exported span and emitted log record lands in `spans` / `logs`.
 * Each call builds a distinct impl, so several can be installed side by side.
 */
export const memoryTracer = () => {
  installs += 1

  const spans: TraceDef.SpanData[] = []
  const logs: TraceDef.LogData[] = []

  const plugin = Trace.implement({
    name: `db-test/memory-tracer-${installs}`,
    version: '1.0.0',
    *setup() {
      yield* Trace.actions.enableTracing()

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

  const names = (): string[] => spans.map(data => data.name)

  /** The one exported span named `name` (throws when there is not exactly one). */
  const span = (name: string): TraceDef.SpanData => {
    const found = spans.filter(data => data.name === name)

    if (found.length !== 1) {
      throw new Error(`expected one span "${name}", got ${found.length}: ${names().join(', ')}`)
    }

    return found[0]!
  }

  /** Every exported span named `name`, in export order. */
  const all = (name: string): TraceDef.SpanData[] => spans.filter(data => data.name === name)

  /** Exception log records (those carrying `exception.type`). */
  const exceptions = (): TraceDef.LogData[] =>
    logs.filter(log => log.attributes['exception.type'] !== undefined)

  return { plugin, spans, logs, span, all, names, exceptions }
}

export type MemoryTracer = ReturnType<typeof memoryTracer>

/** Run `body` with a fresh in-memory tracer installed; resolves its value (throws on failure). */
export const traced = async <T>(
  body: (tracer: MemoryTracer) => Operation<T>,
): Promise<{ tracer: MemoryTracer; value: T }> => {
  const tracer = memoryTracer()

  const value = unwrap(
    await run(function* () {
      yield* tracer.plugin.use()

      return yield* body(tracer)
    }),
  )

  return { tracer, value }
}

/** Run `body` with a fresh in-memory tracer installed; resolves its Result (never throws). */
export const tracedResult = async <T>(
  body: (tracer: MemoryTracer) => Operation<T>,
): Promise<{ tracer: MemoryTracer; result: Result<T, unknown> }> => {
  const tracer = memoryTracer()

  const result = await run(function* () {
    yield* tracer.plugin.use()

    return yield* body(tracer)
  })

  return { tracer, result }
}

/** Install a `DefaultLogger` whose only transport captures every entry into the returned list. */
export function* captureLogs(): Operation<LoggerDef.Entry[]> {
  const entries: LoggerDef.Entry[] = []

  installs += 1

  const transport = LoggerTransport.implement<{ name: string; level: LogLevel }, []>({
    name: `db-test/capture-${installs}`,
    version: '1.0.0',
    *setup() {
      return { name: 'capture', level: LogLevel.trace }
    },
  }).build({
    *write(entry: LoggerDef.Entry) {
      entries.push(entry)
    },
    *flush() {},
    *close() {},
  })

  yield* DefaultLogger.use({ level: LogLevel.trace })
  yield* transport.use()

  return entries
}
