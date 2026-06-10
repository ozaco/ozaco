import type { Result } from 'std:result'
import { asFailure, fail } from 'std:result'

import type { Operation } from '../types/operation'
import type { ConvergeOptions, ConvergeStats } from '../types/utils'

import { sleep } from './sleep'

export const when = <T>(
  assertion: () => Operation<T>,
  options?: ConvergeOptions,
): Operation<ConvergeStats<T>, unknown> => ({
  *[Symbol.iterator]() {
    const timeout = options?.timeout ?? 2000
    const interval = options?.interval ?? 10
    const start = Date.now()
    let runs = 0
    let lastError: Result.Failure<unknown> | null = null

    while (Date.now() - start < timeout) {
      runs++
      try {
        const value = yield* assertion()
        if (value !== false) {
          const end = Date.now()
          return { start, end, elapsed: end - start, runs, timeout, interval, value }
        }
      } catch (error) {
        lastError = asFailure(error)
      }
      yield* sleep(interval)
    }

    return yield* lastError ?? fail('when', `timed out after ${timeout}ms (${runs} runs)`)
  },
})

export const always = <T>(
  assertion: () => Operation<T>,
  options?: ConvergeOptions,
): Operation<ConvergeStats<T>, unknown> => ({
  *[Symbol.iterator]() {
    const timeout = options?.timeout ?? 200
    const interval = options?.interval ?? 10
    const start = Date.now()
    let runs = 0
    let lastValue: T | undefined

    while (Date.now() - start < timeout) {
      runs++
      const value = yield* assertion()
      if (value === false) {
        return yield* fail('always', `assertion returned false on run ${runs}`)
      }
      lastValue = value
      yield* sleep(interval)
    }

    const end = Date.now()
    return {
      start,
      end,
      elapsed: end - start,
      runs,
      timeout,
      interval,
      value: lastValue as T,
    }
  },
})
