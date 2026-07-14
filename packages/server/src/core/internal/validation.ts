import type { Operation } from 'std:effect'
import { mapError, validate } from 'std:effect'
import type { Result } from 'std:result'
import { fail } from 'std:result'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import { CoreErrors } from '../const'
import type { Action } from '../types/action'
import { ActionContext } from '../utils/context'

const evaluateWith = function* <T>(result: unknown, op: Operation<T>) {
  return yield* ActionContext.with(result as Action, function* () {
    return yield* op
  })
}

const asValidation =
  (scope: 'input' | 'output') =>
  (failure: Result.Failure<unknown>): Result.Failure<unknown> =>
    fail(CoreErrors.Validation, failure.message, scope) as Result.Failure<unknown>

export const withValidation = (
  handler: AnyType,
  schemas: {
    input?: StandardSchemaV1 | undefined
    output?: StandardSchemaV1 | undefined
  },
) => {
  const result = function* (...callArgs: AnyType[]) {
    let args = callArgs

    if (schemas.input) {
      const parsed = yield* evaluateWith(
        result,
        mapError(validate(schemas.input, callArgs[0]), asValidation('input')),
      )

      args = [parsed, ...callArgs.slice(1)]
    }

    const handlerResult = yield* evaluateWith(result, handler(...args))

    if (schemas.output) {
      return yield* evaluateWith(
        result,
        mapError(validate(schemas.output, handlerResult), asValidation('output')),
      )
    }

    return handlerResult
  }

  return result
}
