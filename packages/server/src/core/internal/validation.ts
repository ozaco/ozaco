import { operation, until } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import { ServerErrorCode } from '../error-codes'

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
        yield* fail(ServerErrorCode.Validation, formatIssues(result.issues), 'input')
      }

      args = [(result as StandardSchemaV1.SuccessResult<unknown>).value, ...callArgs.slice(1)]
    }

    // Output schema is intentionally NOT validated at runtime.
    // It exists for documentation (OpenAPI generation via getMeta(key).output)
    // and for the user to validate explicitly inside the handler if desired.
    // Runtime validation post-handler creates a side-effect rollback time-window
    // that conflicts with `ensure(...)` cleanup semantics — handler can't know
    // if validation will fail before deciding commit vs rollback.

    return yield* handler(...args)
  }
