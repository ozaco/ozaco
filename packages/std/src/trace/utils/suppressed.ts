import type { Operation } from 'std:effect'

import { quiet } from '../internal/context'

/**
 * Run `body` with telemetry SUPPRESSED: no spans, no span events, no log records — tracing acts as
 * if off (the active span stays for propagation, which then sends it unsampled). Every Tracer call
 * runs this way, so an exporter's own work can neither be traced nor recurse.
 */
export function* suppressed<T>(body: () => Operation<T>): Operation<T> {
  return yield* quiet(body)
}
