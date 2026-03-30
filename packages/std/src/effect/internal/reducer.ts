import { fail, isSuccess } from 'std:result'
import { PriorityQueue } from 'std:shared'

import type { Helpers } from '../types/helpers'

class InstructionQueue extends PriorityQueue<Helpers.Instruction> {
  enqueue(instruction: Helpers.Instruction): void {
    const [priority] = instruction
    this.push(priority, instruction)
  }

  dequeue(): Helpers.Instruction | undefined {
    while (true) {
      const top = this.pop()
      if (!top) {
        return undefined
      }
      const validate = top[3]
      if (!validate()) {
        continue
      }
      return top
    }
  }
}

export class Reducer {
  reducing = false
  readonly queue = new InstructionQueue()

  reduce = (instruction: Helpers.Instruction) => {
    const { queue } = this

    queue.enqueue(instruction)

    if (this.reducing) {
      return
    }

    try {
      this.reducing = true

      let item = queue.dequeue()
      while (item) {
        const [, routine, result, _, method = 'next' as const] = item
        try {
          const iterator = routine.data.iterator
          if (isSuccess(result)) {
            if (method === 'next') {
              const next = iterator.next(result.value)
              if (!next.done) {
                routine.data.exit = next.value[0](routine.next, routine)
              }
            } else if (iterator.return) {
              const next = iterator.return(result.value)
              if (!next.done) {
                routine.data.exit = next.value[0](routine.next, routine)
              }
            }
          } else if (iterator.throw) {
            const next = iterator.throw(result.error)
            if (!next.done) {
              routine.data.exit = next.value[0](routine.next, routine)
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
