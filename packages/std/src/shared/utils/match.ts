import { fail, isFailure, isSuccess, succeed, unwrap } from 'std:result'
import type { Result } from 'std:result'

import type { AnyType } from '../types/common'
import type { MatchBuilder, MatchCase } from '../types/match'
import type { StandardSchemaV1 } from '../types/schema'

import { isPromise } from './is'

const validateSchema = (
  schema: StandardSchemaV1,
  value: unknown,
): Result<unknown, readonly StandardSchemaV1.Issue[]> => {
  const result = schema['~standard'].validate(value)
  if (isPromise(result)) {
    unwrap(fail('async schema validation is not supported, use a sync schema'))
  }
  if (result.issues) {
    return fail(result.issues)
  }
  return succeed(result.value)
}

const createBuilder = <Input, Remaining, Output>(
  value: Input,
  cases: MatchCase[],
): MatchBuilder<Input, Remaining, Output> => {
  const execute = (): Result<AnyType, null> => {
    for (const c of cases) {
      if (c.schema) {
        const result = validateSchema(c.schema, value)
        if (isSuccess(result)) {
          return succeed(c.handler(result.value))
        }
        continue
      }

      if (c.predicate!(value)) {
        return succeed(c.handler(value))
      }
    }

    return fail(null)
  }

  return {
    with(schema: AnyType, handler: AnyType) {
      return createBuilder(value, [...cases, { schema, handler }])
    },

    when(predicate: AnyType, handler: AnyType) {
      return createBuilder(value, [...cases, { predicate, handler }])
    },

    otherwise(handler: AnyType) {
      const result = execute()

      if (isFailure(result)) {
        return handler(value)
      }

      return result.value
    },

    exhaustive() {
      const result = execute()

      if (isFailure(result)) {
        unwrap(fail('non-exhaustive matching, no case matched the value'))
      }

      return result.value
    },

    run() {
      const result = execute()
      return isSuccess(result) ? result.value : undefined
    },
  } as AnyType
}

export const match = <const T>(value: T) =>
  createBuilder(value, []) as unknown as MatchBuilder<T, T, never>
