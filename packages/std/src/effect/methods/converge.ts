import type { ConvergeOptions, ConvergeStats } from '../types/converge'
import type { Operation } from '../types/operation'

import { sleep } from './sleep'

export const when = <T>(
  assertion: () => Operation<T>,
  options?: ConvergeOptions,
): Operation<ConvergeStats<T>> => ({
  *[Symbol.iterator]() {
    const timeout = options?.timeout ?? 2000
    const interval = options?.interval ?? 10
    const start = Date.now()
    let runs = 0
    let lastError: unknown

    while (Date.now() - start < timeout) {
      runs++
      try {
        const value = yield* assertion()
        if (value !== false) {
          const end = Date.now()
          return { start, end, elapsed: end - start, runs, timeout, interval, value }
        }
      } catch (error) {
        lastError = error
      }
      yield* sleep(interval)
    }

    throw lastError ?? new Error(`when: timed out after ${timeout}ms (${runs} runs)`)
  },
})

export const always = <T>(
  assertion: () => Operation<T>,
  options?: ConvergeOptions,
): Operation<ConvergeStats<T>> => ({
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
        throw new Error(`always: assertion returned false on run ${runs}`)
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
