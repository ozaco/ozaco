import type { Result } from 'std:result'
import { isFailure, succeed, unwrap } from 'std:result'

import type { Operation, Task } from '../types/operation'

import { box } from './box'
import { createContext } from './context'
import { critical } from './coroutine'

export class TaskGroup {
  tasks = new Set<Task<unknown>>();

  *halt(): Operation<void> {
    const set = this.tasks
    let total: Result<void> = succeed()
    while (set.size > 0) {
      const tasks = [...set]
      set.clear()
      for (let i = tasks.length - 1; i >= 0; i--) {
        const task = tasks[i]!
        const result = yield* box(task.halt)
        if (isFailure(result)) {
          total = result
        }
      }
    }

    unwrap(total)
  }
}

export const TaskGroupContext = createContext<TaskGroup>('std:effect:task-group', new TaskGroup())

export const encapsulate = <T>(operation: () => Operation<T>): Operation<T> =>
  TaskGroupContext.with(new TaskGroup(), function* (group) {
    try {
      return yield* operation()
    } finally {
      yield* critical(() => group.halt())
    }
  })
