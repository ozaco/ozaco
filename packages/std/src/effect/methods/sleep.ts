import type { Operation } from '../types/operation'

import { action } from './action'

export const sleep = (duration: number): Operation<void> =>
  action(resolve => {
    let timeoutId = setTimeout(resolve, duration)
    return () => clearTimeout(timeoutId)
  }, `sleep(${duration})`)
