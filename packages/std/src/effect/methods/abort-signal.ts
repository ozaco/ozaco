import { isJust, isSuccess } from 'std:result'

import { useCoroutine } from '../internal/coroutine'
import type { Operation } from '../types/operation'

/**
 * An `AbortSignal` tied to the current task's CANCELLATION. The controller aborts only when the
 * enclosing task is interrupted/halted (or fails) — NOT on normal completion. This lets a value
 * carried out on the success path (e.g. the `Response` from `await fetch(url)`) stay usable, while an
 * in-flight request is still aborted when the task is halted (e.g. a `race` loser or a `timeout`).
 * Aborting on the success path would kill the body before it could be read.
 *
 * NOTE: std deliberately diverges from Effection here — Effection's `useAbortSignal` aborts on ALL
 * teardown (completion included). We key off the coroutine's settled outcome (Just(Success) → leave
 * intact; Nothing/Failure → abort) so success values survive.
 */
export const useAbortSignal = (): Operation<AbortSignal> => ({
  *[Symbol.iterator]() {
    const routine = yield* useCoroutine()
    const controller = new AbortController()

    // oxlint-disable-next-line promise/always-return
    void routine.future.then(outcome => {
      // success → leave the signal intact; halt (Nothing) or failure → abort the in-flight work
      if (!(isJust(outcome) && isSuccess(outcome.value))) {
        controller.abort()
      }
    })

    return controller.signal
  },
})
