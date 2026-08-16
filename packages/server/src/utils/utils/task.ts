import type { Future, Operation, Scope, Task } from 'std:effect'
import { isFailure } from 'std:result'
import type { Result } from 'std:result'

/**
 * Bridges a Task/Future into plain async land as a VALUE promise: the std contract resolves a
 * Result (never rejects), so this unwraps it — resolving the value and throwing the Failure
 * object (halts arrive as `fail('halted')`). Callers try/catch; the caught reason carries
 * `error`/`message`/`causes`.
 */
export const taskValue = async <T>(task: Task<T> | Future<T>): Promise<T> => {
  const outcome = (await task) as Result<T>

  if (isFailure(outcome)) {
    throw outcome
  }

  return outcome.value
}

/**
 * Runs an operation on a scope WITHOUT letting its failure crash the scope, using std's detached
 * task semantics: the failure settles the returned promise's Result and goes no further. This is
 * THE way to bridge callbacks/servers into a long-lived scope.
 */
export const runSafe = <T>(scope: Scope, op: () => Operation<T>): Promise<Result<T>> =>
  Promise.resolve(scope.run(op, { detached: true }))
