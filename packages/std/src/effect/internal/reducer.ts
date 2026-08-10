import { asFailure, isFailure, just, succeed } from 'std:result'
import { PriorityQueue } from 'std:shared'

import type { Helpers } from '../types/helpers'

import { PriorityContext, SettleContext } from './contexts'

class InstructionQueue extends PriorityQueue<Helpers.Coroutine> {
  enqueue(routine: Helpers.Coroutine, priority: number): void {
    if (!routine.data.enqueued) {
      routine.data.enqueued = true
      this.push(priority, routine)
    }
  }
  dequeue(): Helpers.Coroutine | undefined {
    const routine = this.pop()
    if (routine) {
      routine.data.enqueued = false
      return routine
    }
  }
}

export class Reducer {
  reducing = false
  readonly queue = new InstructionQueue()

  schedule = (routine: Helpers.Coroutine) => {
    const queue = this.queue

    queue.enqueue(routine, routine.scope.expect(PriorityContext))

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
          } else {
            item.perform(next.value)
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
