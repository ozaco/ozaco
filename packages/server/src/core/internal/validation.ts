import { operation, until } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

const validate = operation(function* (schema: StandardSchemaV1, value: unknown) {
  const result = schema['~standard'].validate(value)

  if (result instanceof Promise) {
    return yield* until(result)
  }

  return result
})

const formatIssues = (issues: ReadonlyArray<StandardSchemaV1.Issue>): string =>
  issues.map(i => `At ${i.path?.join('.') || 'root'} : ${i.message}`).join(', ')

export const withValidation = (
  handler: AnyType,
  schemas: {
    input?: StandardSchemaV1 | undefined
    output?: StandardSchemaV1 | undefined
  },
) =>
  function* (...callArgs: AnyType[]) {
    let args = callArgs
    if (schemas.input) {
      const result = yield* validate(schemas.input, callArgs[0])

      if (result.issues) {
        yield* fail('validation' as const, formatIssues(result.issues), 'input')
      }

      args = [(result as StandardSchemaV1.SuccessResult<unknown>).value, ...callArgs.slice(1)]
    }

    const output: AnyType = yield* handler(...args)

    if (schemas.output) {
      const result = yield* validate(schemas.output, output)
      if (result.issues) {
        yield* fail('validation' as const, formatIssues(result.issues), 'output')
      }
      return (result as StandardSchemaV1.SuccessResult<unknown>).value
    }

    return output
  }
