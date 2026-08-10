import { global } from '../base/scope'
import type { Operation, Task } from '../types/operation'

/**
 * Execute an operation in a fresh top-level scope. The entry point for embedding the effect system
 * into existing code; whole programs should prefer `main`.
 */
export const run = <T>(operation: () => Operation<T>): Task<T> => global.run(operation)
