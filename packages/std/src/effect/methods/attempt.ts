import type { Result } from 'std:result'
import { isJust, isSuccess, succeed } from 'std:result'

import { DelimiterContext, ErrorContext } from '../internal/contexts'
import { Delimiter } from '../internal/delimiter'
import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

import { useScope } from './scope'

/**
 * Run `op` inside a fresh error-boundary (delimiter) and reify its OUTCOME as a `Result` instead of
 * letting a failure propagate. A failure — including a nested action/operation failure that would
 * otherwise unwind past an inline `try/catch` — comes back as a `Result.Failure` value; a HALT still
 * propagates (it interrupts the surrounding scope rather than being captured). The inline,
 * effect-native counterpart of `safeRun` (mirrors `trap`, but reifies rather than re-raising).
 */
export function* attempt<T, E = unknown>(op: Operation<T, E>): Operation<Result<T, E>> {
  const scope = yield* useScope()
  const original = {
    error: scope.expect(ErrorContext),
    delimiter: scope.expect(DelimiterContext),
  }

  const delimiter = new Delimiter(() => op as Operation<T>, original.delimiter)
  scope.set(ErrorContext, delimiter)
  scope.set(DelimiterContext, delimiter as Delimiter<unknown>)

  try {
    yield* delimiter
  } finally {
    scope.set(ErrorContext, original.error)
    scope.set(DelimiterContext, original.delimiter)

    const outcome = delimiter.outcome!
    // oxlint-disable-next-line no-unsafe-finally
    return (yield {
      enter: resolve => {
        if (isJust(outcome)) {
          // reify the outcome (Success OR Failure) as the returned value — do NOT re-raise
          resolve(succeed(outcome.value as Result<T, E>))
        } else {
          // a halt/interrupt is not a failure to capture — propagate it
          original.delimiter.interrupt()
        }
        return didExit => didExit(succeed())
      },
      cause: 'attempt return',
    } as Helpers.Effect<Result<T, E>>) as Result<T, E>
  }
}

/**
 * Run `op`; on failure, hand the `Result.Failure` to `handler` and continue with its result — the
 * effect-native `try/catch`. The `handler` runs OUTSIDE `op`'s error boundary (after `attempt` has
 * reified the failure), so a failure raised by the handler itself propagates to the caller and is
 * NOT recaptured by `recover`. Returns `op`'s value on success; halts still propagate.
 */
export function* recover<T, R, E = unknown>(
  op: Operation<T, E>,
  handler: (failure: Result.Failure<E>) => Operation<R>,
): Operation<T | R> {
  const result = yield* attempt(op)
  return isSuccess(result) ? result.value : yield* handler(result)
}
