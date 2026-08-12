import { useContext } from 'std:effect'
import type { LoggerDef } from 'std:logger'
import { LoggerTransport, LogLevel } from 'std:logger'

interface CaptureContext {
  name: string
  level: LogLevel
  sink: CaptureSink
}

export interface CaptureSink {
  entries: LoggerDef.Entry[]
  flushes: number
  closes: number
}

export const createSink = (): CaptureSink => ({ entries: [], flushes: 0, closes: 0 })

/**
 * A minimal in-memory transport built on the LoggerTransport base — captures entries instead of
 * printing them, so tests can assert on exactly what the logger dispatched.
 */
export const captureTransport = (name: string, sink: CaptureSink, level?: LogLevel) => {
  const impl = LoggerTransport.implement<CaptureContext, []>({
    name,
    version: '1.0.0',
    *setup() {
      return { name, level: level ?? LogLevel.trace, sink }
    },
  })

  return impl.build({
    *write(entry) {
      const ctx = yield* useContext(impl.context)
      if (entry.level < ctx.level) {
        return
      }
      ctx.sink.entries.push(entry)
    },
    *flush() {
      const ctx = yield* useContext(impl.context)
      ctx.sink.flushes += 1
    },
    *close() {
      const ctx = yield* useContext(impl.context)
      ctx.sink.closes += 1
    },
  })
}
