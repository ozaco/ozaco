import { action } from '../base/action'
import type { Operation } from '../types/operation'

/** Sleep for the given amount of milliseconds. */
export const sleep = (duration: number): Operation<void> =>
  action(resolve => {
    const timeoutId = setTimeout(resolve, duration)
    return () => clearTimeout(timeoutId)
  }, `sleep(${duration})`)
