import { withResolvers } from '../base/with-resolvers'
import type { Utils } from '../types/utils'

/**
 * A re-armed wait point. `wait()` parks the caller until the next `notify()`; every `notify()`
 * wakes everyone parked and arms a fresh gate, so a waiter that checks its condition, finds it
 * unmet and parks again never misses a wake that landed in between (read the gate, check, wait).
 */
export const createGate = (cause?: string): Utils.Gate => {
  let current = withResolvers<void>(cause)

  return {
    wait: () => current.operation,

    notify() {
      const gate = current
      current = withResolvers<void>(cause)
      gate.resolve()
    },
  }
}
