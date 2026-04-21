import { operation, until } from 'std:effect'
import type { StandardSchemaV1 } from 'std:shared'

export const validate = operation(function* (schema: StandardSchemaV1, value: unknown) {
  const result = schema['~standard'].validate(value)

  if (result instanceof Promise) {
    return yield* until(result)
  }

  return result
})
