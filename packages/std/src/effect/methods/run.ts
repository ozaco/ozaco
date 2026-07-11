import type { Operation, Task } from '../types/operation'

import { global } from './scope'

export const run = <T>(operation: () => Operation<T>): Task<T> => global.run(operation)
