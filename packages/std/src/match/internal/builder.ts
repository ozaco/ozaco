import type { AnyType, StandardSchemaV1 } from 'std:shared'
import { isPromise } from 'std:shared'
import { fail, isFailure, isSuccess, succeed, unwrap, type Result } from 'std:result'

import type { MatchBuilder } from '../types/builder'
import type { MatchCase } from './case'

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

export const createBuilder = <Input, Remaining, Output>(
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
      return isSuccess(result) ? result.value : null
    },
  } as AnyType
}
