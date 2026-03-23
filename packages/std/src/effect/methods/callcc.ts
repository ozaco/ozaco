import { fail, succeed, unwrap } from 'std:result'
import type { Result } from 'std:result'
import type { AnyType } from 'std:shared'

import { encapsulate } from '../internal/task-group'
import type { Operation } from '../types/operation'

import { lift } from './lift'
import { spawn } from './spawn'
import { withResolvers } from './with-resolvers'

export function* callcc<T, E = unknown>(
  op: (
    resolve: (value: T) => Operation<void>,
    reject: (error: E) => Operation<void>,
  ) => Operation<void>,
): Operation<T> {
  const result = withResolvers<Result<T, E>>()

  const resolve = lift((value: T) => result.resolve(succeed(value) as Result<T, never>))

  const reject = lift((error: unknown) => result.resolve(fail(error) as AnyType))

  return yield* encapsulate(function* () {
    yield* spawn(() => op(resolve, reject))

    return unwrap(yield* result.operation) as T
  })
}
