import { asFailure, fail, isFailure, just, succeed } from 'std:result'

import { getGlobalDebug } from '../methods/debug'
import type { Helpers } from '../types/helpers'

import { DebugContext, Priority, SettleContext } from './contexts'

function resolveDebugHandler(
  routine: Helpers.Coroutine<unknown>,
): ((desc: string) => void) | undefined {
  const scoped = routine.scope.get(DebugContext)
  if (scoped === 'force-silence') {
    return undefined
  }
  return getGlobalDebug() ?? scoped
}

class Tier {
  items: (Helpers.Coroutine | undefined)[] = []
  head = 0

  constructor(private maxDeadSlots = 1024) {}

  push(item: Helpers.Coroutine): void {
    this.items.push(item)
  }

  shift(): Helpers.Coroutine | undefined {
    if (this.head < this.items.length) {
      const item = this.items[this.head]
      this.items[this.head] = undefined
      this.head++
      if (this.head > this.maxDeadSlots) {
        this.items = this.items.slice(this.head)
        this.head = 0
      }
      return item
    }
    return undefined
  }

  get length(): number {
    return this.items.length - this.head
  }
}

class InstructionQueue {
  tiers: Tier[] = []
  min = 0
  max = 0

  enqueue(routine: Helpers.Coroutine): void {
    // de-dupe: a coroutine already waiting must not be scheduled twice
    if (routine.data.enqueued) {
      return
    }
    routine.data.enqueued = true

    const priority = routine.scope.expect(Priority)
    let tier = this.tiers[priority]
    if (!tier) {
      tier = new Tier()
      this.tiers[priority] = tier
    }
    tier.push(routine)
    if (priority < this.min) {
      this.min = priority
    }
    if (priority > this.max) {
      this.max = priority
    }
  }

  dequeue(): Helpers.Coroutine | undefined {
    for (let current = this.min; current <= this.max; current++) {
      const tier = this.tiers[current]
      if (tier && tier.length > 0) {
        const routine = tier.shift()!
        this.min = tier.length === 0 ? current + 1 : current
        routine.data.enqueued = false
        return routine
      }
    }
    this.min = 0
    this.max = 0
    return undefined
  }
}

// One drain may run at most this many steps before handing the rest of the queue to a macrotask.
// A coroutine whose loop never crosses an async boundary (a retry around a synchronously failing
// compute is the canonical case) re-enqueues itself on every step, so an unbounded drain never
// returns to the event loop: timers, IO, even connection closes starve while one request spins.
// The budget turns that lock into mere slowness — the offender still gets its slice, everything
// else keeps breathing. Sized far above any legitimate synchronous burst (a whole dispatch is
// hundreds of steps) and far below where one slice becomes noticeable stall.
const STEP_BUDGET = 65_536

// setImmediate where it exists (node/bun) — setTimeout(0) is clamped to ~1ms and would tax every
// budget hand-off; the web build falls back to it.
const defer: (fn: () => void) => void =
  typeof setImmediate === 'function' ? setImmediate : fn => setTimeout(fn, 0)

export class Reducer {
  reducing = false
  /** a budget hand-off macrotask is pending; guards against stacking more than one */
  private continuing = false
  readonly queue = new InstructionQueue()

  schedule = (routine: Helpers.Coroutine) => {
    this.queue.enqueue(routine)

    if (!this.reducing) {
      this.drain()
    }
  }

  private continueDrain = () => {
    this.continuing = false
    if (!this.reducing) {
      this.drain()
    }
  }

  private drain = () => {
    const { queue } = this

    try {
      this.reducing = true
      let steps = 0

      for (let item = queue.dequeue(); item; item = queue.dequeue()) {
        try {
          const next = item.step()
          if (next.done) {
            const settle = item.scope.expect(SettleContext)
            settle(just(succeed(next.value)), item.settle)
          } else if (isFailure(next.value)) {
            item.resume(next.value)
          } else if (next.value && typeof next.value.enter === 'function') {
            resolveDebugHandler(item)?.(next.value.cause)
            item.perform(next.value)
          } else {
            item.resume(fail('effect', `yielded a non-effect value: ${String(next.value)}`))
          }
        } catch (error) {
          const settle = item.scope.expect(SettleContext)
          settle(just(asFailure(error)), item.settle)
        }

        if (++steps === STEP_BUDGET) {
          if (!this.continuing) {
            this.continuing = true
            defer(this.continueDrain)
          }
          break
        }
      }
    } finally {
      this.reducing = false
    }
  }
}
