import type { Operation } from 'std:effect'
import { withResolvers } from 'std:effect'
import { fail } from 'std:result'

import { CliErrors } from '../errors'
import type { Helpers } from '../types/helpers'

const states = new WeakMap<object, Helpers.LeaseState>()

/** The lease state for an installed terminal, keyed by its context object (lazy, one per install). */
export const leaseStateOf = (info: object): Helpers.LeaseState => {
  const found = states.get(info)
  if (found) {
    return found
  }
  const created: Helpers.LeaseState = { busy: false, waiters: [] }
  states.set(info, created)
  return created
}

/** Release the region and hand it to the next living waiter (FIFO). */
export const releaseLease = (state: Helpers.LeaseState): void => {
  state.busy = false
  while (state.waiters.length > 0) {
    const next = state.waiters.shift()!
    if (next.abandoned) {
      continue
    }
    // reserve BEFORE resuming the waiter, so a racing plain acquire can't steal the region
    next.granted = true
    state.busy = true
    next.grant()
    return
  }
}

/**
 * Take the region, or fail `cli.busy` — with `wait` queue FIFO instead. A waiter halted while
 * queued is skipped at grant time; one halted AFTER being granted passes the region on.
 */
export function* acquireLease(state: Helpers.LeaseState, wait: boolean): Operation<void> {
  if (!state.busy) {
    state.busy = true
    return
  }

  if (!wait) {
    return yield* fail(
      CliErrors.Busy,
      'the live region is already leased — pass { wait: true } to queue for it',
    )
  }

  const gate = withResolvers<void>('cli renderer lease')
  const waiter: Helpers.Waiter = {
    granted: false,
    abandoned: false,
    grant: () => gate.resolve(),
    gate: gate.operation,
  }
  state.waiters.push(waiter)

  let acquired = false
  try {
    yield* waiter.gate
    acquired = true
  } finally {
    if (!acquired) {
      waiter.abandoned = true
      if (waiter.granted) {
        releaseLease(state)
      }
    }
  }
}
