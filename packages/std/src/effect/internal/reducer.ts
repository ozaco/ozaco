import { fail, isSuccess } from 'std:result'
import { PriorityQueue } from 'std:shared'

import type { Helpers } from '../types/helpers'
import { createContext } from '../methods/context'

export class Reducer {
  reducing = false
  readonly queue = new InstructionQueue()

  reduce = (instruction: Helpers.Instruction) => {
    let { queue } = this

    queue.enqueue(instruction)

    if (this.reducing) return

    try {
      this.reducing = true

      let item = queue.dequeue()
      while (item) {
        let [, routine, result, _, method = 'next' as const] = item
        try {
          let iterator = routine.data.iterator
          if (isSuccess(result)) {
            if (method === 'next') {
              let next = iterator.next(result.value)
              if (!next.done) {
                routine.data.exit = next.value.enter(routine.next, routine)
              }
            } else if (iterator.return) {
              let next = iterator.return(result.value)
              if (!next.done) {
                routine.data.exit = next.value.enter(routine.next, routine)
              }
            }
          } else if (iterator.throw) {
            let next = iterator.throw(result.error)
            if (!next.done) {
              routine.data.exit = next.value.enter(routine.next, routine)
            }
          } else {
            throw result.error
          }
        } catch (error) {
          routine.next(fail(error))
        }
        item = queue.dequeue()
      }
    } finally {
      this.reducing = false
    }
  }
}

class InstructionQueue extends PriorityQueue<Helpers.Instruction> {
  enqueue(instruction: Helpers.Instruction): void {
    let [priority] = instruction
    this.push(priority, instruction)
  }

  dequeue(): Helpers.Instruction | undefined {
    while (true) {
      let top = this.pop()
      if (!top) {
        return undefined
      }
      let validate = top[3]
      if (!validate()) {
        continue
      }
      return top
    }
  }
}

export const ReducerContext = createContext<Reducer>('std:effect:reducer', new Reducer())
