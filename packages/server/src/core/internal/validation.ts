import type { Operation } from 'std:effect'
import { operation, until } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import { CoreErrors } from '../const'
import type { Action } from '../types/action'
import { ActionContext } from '../utils/context'

const validate = operation(function* (schema: StandardSchemaV1, value: unknown) {
  const result = schema['~standard'].validate(value)

  if (result instanceof Promise) {
    return yield* until(result)
  }

  return result
})

const formatIssues = (issues: ReadonlyArray<StandardSchemaV1.Issue>): string =>
  issues.map(i => `At ${i.path?.join('.') || 'root'} : ${i.message}`).join(', ')

const evaluateWith = function* <T>(result: unknown, op: Operation<T>) {
  return yield* ActionContext.with(result as Action, function* () {
    return yield* op
  })
}

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
      const validationResult = yield* evaluateWith(result, validate(schemas.input, callArgs[0]))

      if (validationResult.issues) {
        yield* fail(CoreErrors.Validation, formatIssues(validationResult.issues), 'input')
      }

      args = [
        (validationResult as StandardSchemaV1.SuccessResult<unknown>).value,
        ...callArgs.slice(1),
      ]
    }

    const handlerResult = yield* evaluateWith(result, handler(...args))

    if (schemas.output) {
      const validationResult = yield* evaluateWith(result, validate(schemas.output, handlerResult))

      if (validationResult.issues) {
        yield* fail(CoreErrors.Validation, formatIssues(validationResult.issues), 'input')
      }

      return validationResult
    }

    return handlerResult
  }

  return result
}
