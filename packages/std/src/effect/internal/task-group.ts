import type { Result } from 'std:result'
import { isFailure, succeed, unwrap } from 'std:result'

import { attempt } from '../methods/attempt'
import type { Operation, Task } from '../types/operation'

import { TaskGroupContext } from './contexts'

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
        const result = yield* attempt(task.halt)
        if (isFailure(result)) {
          total = result
        }
      }
    }

    unwrap(total)
  }
}

export const encapsulate = <T>(operation: () => Operation<T>): Operation<T> =>
  TaskGroupContext.with(new TaskGroup(), function* (group) {
    try {
      return yield* operation()
    } finally {
      yield* group.halt()
    }
  })
