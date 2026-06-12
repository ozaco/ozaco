import type { Operation } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure } from 'std:result'

import { OtelSpanStatusCode } from '../const'
import type { TracerDef } from '../types/tracer'

/**
 * Run `body` under `span`: on failure record the exception + set ERROR status, then re-raise; always
 * `end()` the span. Success-side attributes/status stay at the call site. `onFailure` is an optional
 * extra step (e.g. a debug log) run after the error is recorded and before it re-raises. Shared by
 * the call span and the per-policy span so the catch/record/end bookkeeping lives in one place.
 */
export const withSpan = function* <T>(
  span: TracerDef.Span,
  body: () => Operation<T, unknown>,
  onFailure?: (failure: Result.Failure<unknown>) => Operation<void, unknown>,
): Operation<T, unknown> {
  try {
    return yield* body()
  } catch (error) {
    const failure = asFailure(error)

    yield* span.recordException(failure)
    yield* span.setStatus({
      code: OtelSpanStatusCode.ERROR,
      message: failure.message,
      cause: failure.causes,
    })

    if (onFailure) {
      yield* onFailure(failure)
    }

    yield* failure
    return undefined as never
  } finally {
    yield* span.end()
  }
}
