import { action } from '../base/action'
import { EffectCauses } from '../errors'
import type { Operation } from '../types/operation'
import type { Utils } from '../types/utils'

interface Ticket {
  granted: boolean
  wake?: (() => void) | undefined
}

/**
 * A counting semaphore with `permits` slots (floored, at least 1). `run(op)` takes a permit —
 * parking FIFO when none is free, no polling — runs `op` inline in the caller's task and hands the
 * permit back when `op` returns, fails or is halted. A release hands the permit STRAIGHT to the
 * oldest waiter (no barging), and a waiter halted while parked leaves the queue without ever
 * holding a permit.
 */
export const createSemaphore = (permits: number): Utils.Semaphore => {
  let free = Math.max(1, Math.floor(permits))
  const queue: Ticket[] = []

  const release = () => {
    const next = queue.shift()

    if (!next) {
      free += 1
      return
    }

    // the permit moves to the waiter now — its own `finally` releases it, even if it is halted
    // before it gets to resume
    next.granted = true
    next.wake?.()
  }

  const park = (ticket: Ticket): Operation<void> =>
    action<void>(resolve => {
      if (ticket.granted) {
        resolve()
        return () => {}
      }

      ticket.wake = resolve
      return () => {
        ticket.wake = undefined
      }
    }, EffectCauses.SemaphoreAcquire)

  function* run<T>(op: () => Operation<T>): Operation<T> {
    const ticket: Ticket = { granted: false }

    if (free > 0 && queue.length === 0) {
      free -= 1
      ticket.granted = true
    } else {
      queue.push(ticket)
    }

    try {
      if (!ticket.granted) {
        yield* park(ticket)
      }

      return yield* op()
    } finally {
      if (ticket.granted) {
        release()
      } else {
        const index = queue.indexOf(ticket)
        if (index !== -1) {
          queue.splice(index, 1)
        }
      }
    }
  }

  return {
    run,
    available: () => free,
    waiting: () => queue.length,
  }
}

/** A {@link createSemaphore} with a single permit: `run(op)` bodies never overlap, FIFO order. */
export const createMutex = (): Utils.Mutex => {
  const semaphore = createSemaphore(1)

  return {
    run: semaphore.run,
    locked: () => semaphore.available() === 0,
    waiting: semaphore.waiting,
  }
}
