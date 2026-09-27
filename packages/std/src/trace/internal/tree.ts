import type { TraceDef } from '../types/trace'

import { RECORDER_BRAND } from './const'
import type { SpanRecorder } from './recorder'

/** A context as it is referenced from elsewhere (a parent, a link, a log record). */
export const plainContext = (context: TraceDef.SpanContext): TraceDef.SpanContext => ({
  traceId: context.traceId,
  spanId: context.spanId,
  flags: context.flags,
  ...(context.remote ? { remote: true } : {}),
})

/** A context as a log record references it: ids and flags. */
export const logContextOf = (context: TraceDef.SpanContext): TraceDef.SpanContext => ({
  traceId: context.traceId,
  spanId: context.spanId,
  flags: context.flags,
})

/** Whether `value` is a recorder (any std copy's — the brand is a registered symbol). */
export const isRecorder = (value: unknown): value is SpanRecorder =>
  typeof value === 'object' &&
  value !== null &&
  (value as Record<symbol, unknown>)[RECORDER_BRAND] === true

/** `child` runs (transitively) inside `ancestor` in this process. */
export const isBelow = (child: SpanRecorder, ancestor: SpanRecorder): boolean => {
  for (let node = child.local; node !== null; node = node.local) {
    if (node === ancestor) {
      return true
    }
  }

  return false
}
