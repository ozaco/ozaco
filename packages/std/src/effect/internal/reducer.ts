import { asFailure, isFailure, isSuccess } from 'std:result'
import { PriorityQueue } from 'std:shared'

import { getGlobalDebug } from '../methods/debug'
import type { Helpers } from '../types/helpers'

import { DebugContext } from './contexts'

function resolveDebugHandler(
  routine: Helpers.Coroutine<unknown>,
): ((desc: string) => void) | undefined {
  const scoped = routine.scope.get(DebugContext)
  if (scoped === 'force-silence') {
    return undefined
  }
  return getGlobalDebug() ?? scoped
}

class InstructionQueue extends PriorityQueue<Helpers.Instruction> {
  enqueue(instruction: Helpers.Instruction): void {
    const [priority] = instruction
    this.push(priority, instruction)
  }

  dequeue(): Helpers.Instruction | undefined {
    return this.pop()
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

      for (let item = queue.dequeue(); item; item = queue.dequeue()) {
        const [, routine, result, delim, epoch] = item
        const step = delim.nextStep(result, epoch)
        if (step === 'drop') {
          continue
        }
        try {
          const iterator = routine.data.iterator
          let next: IteratorResult<Helpers.Effect<unknown>, unknown>
          if (step === 'next') {
            next = iterator.next(isSuccess(result) ? result.value : undefined) as IteratorResult<
              Helpers.Effect<unknown>,
              unknown
            >
          } else if (step === 'return') {
            next = iterator.return
              ? (iterator.return(isSuccess(result) ? result.value : undefined) as IteratorResult<
                  Helpers.Effect<unknown>,
                  unknown
                >)
              : { done: true, value: undefined }
          } else {
            const value = isSuccess(result) ? result.value : result
            if (iterator.throw) {
              next = iterator.throw(value) as IteratorResult<Helpers.Effect<unknown>, unknown>
            } else {
              throw value
            }
          }
          if (!next.done) {
            if (isFailure(next.value)) {
              routine.next(next.value)
            } else {
              resolveDebugHandler(routine)?.(next.value.cause)
              routine.data.exit = next.value.enter(routine.next, routine)
            }
          }
        } catch (error) {
          routine.next(asFailure(error))
        }
      }
    } finally {
      this.reducing = false
    }
  }
}
