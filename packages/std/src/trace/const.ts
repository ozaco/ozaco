/** The subtype of the `Tracer` protocol and its impls. */
export const TRACER = Symbol.for('std:trace.tracer')

/** OTel log severity numbers (the lowest of each range). */
export const TraceSeverity = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
} as const
