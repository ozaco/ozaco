import { isSuccess, succeed, unwrap } from 'std:result'
import type { Result } from 'std:result'

import { createContext } from '../methods/context'
import type { Operation, Task } from '../types/operation'

import { box } from './box'

export class TaskGroup {
  tasks = new Set<Task<unknown>>()

  add(task: Task<unknown>) {
    this.tasks.add(task)
  }

  delete(task: Task<unknown>) {
    this.tasks.delete(task)
  }

  *halt(): Operation<void> {
    let total: Result<void, unknown> = succeed()
    while (this.tasks.size > 0) {
      const tasks = [...this.tasks].toReversed()
      this.tasks.clear()
      for (const task of tasks) {
        const result = yield* box(task.halt)
        if (!isSuccess(result)) {
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
      yield* group.halt()
    }
  })
