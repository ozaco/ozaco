import { isJust, isSuccess } from 'std:result'

import { DelimiterContext } from '../internal/contexts'
import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

import { useScope } from './scope'

/**
 * An `AbortSignal` tied to the current scope's CANCELLATION. The controller aborts only when the
 * enclosing operation is interrupted/halted (or fails) — NOT on normal completion. This lets a value
 * carried out of the scope on the success path (e.g. the `Response` from `await fetch(url)`) stay
 * usable, while an in-flight request is still aborted when the scope is halted (e.g. a `race` loser
 * or a `timeout`). Aborting on the success path would kill the body before it could be read.
 */
export const useAbortSignal = (): Operation<AbortSignal> => ({
  *[Symbol.iterator]() {
    const scope = (yield* useScope()) as Helpers.ScopeInternal
    const delimiter = scope.expect(DelimiterContext)
    const controller = new AbortController()

    scope.ensure(function* abortOnHalt() {
      const { outcome } = delimiter
      // success → leave the signal intact; halt (nothing) or failure → abort the in-flight work
      if (!(outcome && isJust(outcome) && isSuccess(outcome.value))) {
        controller.abort()
      }
    })

    return controller.signal
  },
})
