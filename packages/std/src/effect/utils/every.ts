import { isFailure } from 'std:result'

import { attempt } from '../base/attempt'
import type { Operation } from '../types/operation'
import type { Utils } from '../types/utils'

import { sleep } from './sleep'

/**
 * Run `op` now and again `ms` after each round settles, for as long as the scope lives (a
 * sweeper, a poller). A round that fails ends the loop with that failure — unless `onFailure`
 * handles it (a Logger line), in which case the next round still comes.
 */
export function* every(
  ms: number,
  op: () => Operation<unknown>,
  options?: Utils.EveryOptions,
): Operation<never> {
  for (;;) {
    const outcome = yield* attempt(op)

    if (isFailure(outcome)) {
      if (!options?.onFailure) {
        return yield* outcome
      }

      yield* options.onFailure(outcome)
    }

    yield* sleep(ms)
  }
}
