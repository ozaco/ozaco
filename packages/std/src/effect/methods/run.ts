import type { Operation, Task } from '../types/operation'

import { global } from './scope'

export const run = <T, E = never>(operation: () => Operation<T, E>): Task<T, E> =>
  global.run(operation)
