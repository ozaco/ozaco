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

export class Reducer {
  reducing = false
  readonly queue = new InstructionQueue()

  schedule = (routine: Helpers.Coroutine) => {
    const { queue } = this

    queue.enqueue(routine)

    if (this.reducing) {
      return
    }

    try {
      this.reducing = true

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
      }
    } finally {
      this.reducing = false
    }
  }
}
