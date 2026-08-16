import type { Operation } from 'std:effect'
import { run, scoped } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isFailure, unwrap } from 'std:result'

/** Run an effect body inside a fresh scope and throw its underlying error on failure. */
export const runScoped = async <T>(body: () => Operation<T>): Promise<T> => {
  const outcome = await run(() => scoped(body))
  return unwrap(outcome) as T
}

/**
 * Run an effect body inside a fresh scope and return the raw Result. Use this to assert on
 * failures: a raised (or returned) Failure collapses into the run outcome — `std:result`'s `auto`
 * never nests Results — so `runScoped`'s unwrap would throw it.
 */
export const runResult = async <T>(body: () => Operation<T>): Promise<Result<T>> =>
  await run(() => scoped(body))

/**
 * Invoke a sync builder that is expected to `throw fail(...)` and hand back the thrown Failure so
 * the test can assert its tag (`error`) and `message`. Anything else — no throw, or a non-Failure
 * value — fails the assertion.
 */
export const catchFailure = (invoke: () => unknown): Result.Failure<string> => {
  try {
    invoke()
  } catch (error) {
    if (isFailure(error)) {
      return error as Result.Failure<string>
    }
    throw fail('expected-failure', `builder threw a non-Failure value: ${String(error)}`)
  }
  throw fail('expected-failure', 'builder returned instead of throwing a Failure')
}
