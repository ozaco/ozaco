import type { Operation } from 'std:effect'
import { run, useScope } from 'std:effect'
import type { Result } from 'std:result'
import { unwrap } from 'std:result'
import type { TraceDef } from 'std:trace'
import { enableTracing, registerFallback, Suppressed, Tracer } from 'std:trace'

let installs = 0

/**
 * An in-memory `Tracer`: every exported span and emitted log record lands in `spans` / `logs`.
 * Each call builds a distinct impl (its own name), so several can be installed side by side.
 */
export const memoryTracer = () => {
  installs += 1

  const spans: TraceDef.SpanData[] = []
  const logs: TraceDef.LogData[] = []

  const plugin = Tracer.implement({
    name: `test/memory-tracer-${installs}`,
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

  /** The one exported span named `name` (fails the test when there is not exactly one). */
  const span = (name: string): TraceDef.SpanData => {
    const found = spans.filter(data => data.name === name)
    if (found.length !== 1) {
      throw new Error(`expected one span "${name}", got ${found.length}: ${names()}`)
    }
    return found[0]!
  }

  const names = (): string => spans.map(data => data.name).join(', ')

  /** Exception log records (event name set, `exception.type` attribute present). */
  const exceptions = (): TraceDef.LogData[] =>
    logs.filter(log => log.attributes['exception.type'] !== undefined)

  return { plugin, spans, logs, span, names, exceptions }
}

export type MemoryTracer = ReturnType<typeof memoryTracer>

/** Run `body` with a fresh in-memory tracer installed; resolves the body's value. */
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

/** Run `body` with a fresh in-memory tracer installed; resolves the body's Result (never throws). */
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

/** Deterministic ids: `…0001`, `…0002`, … for traces and spans. */
export const sequentialIds = (): TraceDef.Ids => {
  let traces = 0
  let spans = 0

  return {
    trace: () => {
      traces += 1
      return traces.toString(16).padStart(32, '0')
    },
    span: () => {
      spans += 1
      return spans.toString(16).padStart(16, '0')
    },
  }
}

/**
 * An in-memory process FALLBACK sink (`registerFallback`): every record it receives lands in
 * `logs`, with whether telemetry was suppressed while it ran. `register()` queues it and returns
 * the unregister function — a test MUST call it (the queue is process-wide).
 */
export const memoryFallback = (id = 'test/fallback') => {
  const logs: TraceDef.LogData[] = []
  const suppressedWhileEmitting: boolean[] = []

  const sink: TraceDef.FallbackSink = {
    id,
    *emit(log: TraceDef.LogData) {
      suppressedWhileEmitting.push((yield* useScope()).get(Suppressed) === true)
      logs.push(log)
    },
  }

  return { sink, logs, suppressedWhileEmitting, register: () => registerFallback(sink) }
}

export type MemoryFallback = ReturnType<typeof memoryFallback>

/** Run `body` with `fallbacks` registered (in order), unregistering them all afterwards. */
export const withFallbacks = async <T>(
  fallbacks: readonly MemoryFallback[],
  body: () => T | Promise<T>,
): Promise<T> => {
  const releases = fallbacks.map(fallback => fallback.register())

  try {
    return await body()
  } finally {
    for (const release of releases) {
      release()
    }
  }
}
