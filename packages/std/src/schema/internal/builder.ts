import type { Result } from 'std:result'
import { fail, isFailure, isSuccess, succeed, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import { isFunction } from 'std:shared'

import { SchemaErrors } from '../errors'
import type { Helpers } from '../types/helpers'
import type { MatchBuilder } from '../types/match'
import { validateSync } from '../utils/validate'

/** A `match` builder over `value` with the cases collected so far (each call adds one). */
export const createBuilder = <Input, Remaining, Output>(
  value: Input,
  cases: Helpers.MatchCase[],
): MatchBuilder<Input, Remaining, Output> => {
  const execute = (): Result<AnyType, string> => {
    for (const c of cases) {
      if (c.schema) {
        const result = validateSync(c.schema, value)

        if (isSuccess(result)) {
          return succeed(c.handler(result.value))
        }

        continue
      }

      if (c.predicate!(value)) {
        return succeed(isFunction(c.handler) ? c.handler(value) : c.handler)
      }
    }

    return fail(SchemaErrors.NoMatch)
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
        unwrap(fail(SchemaErrors.NonExhaustive, 'no case matched the value'))
      }

      return result.value
    },

    run() {
      const result = execute()

      return isSuccess(result) ? result.value : undefined
    },
  } as AnyType
}
