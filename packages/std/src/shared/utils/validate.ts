import type { Result } from 'std:result'
import { fail, succeed } from 'std:result'

import type { AnyType } from '../types/common'
import type { StandardSchemaV1 } from '../types/schema'

import { isPromise } from './is'

/**
 * Validate `value` against a Standard Schema (zod, valibot, arktype, …) SYNCHRONOUSLY, returning a
 * `Result`: the parsed output on success, or the schema's raw issues on failure (so the caller keeps
 * control of formatting / error tagging). Async schemas cannot run here — for those use `validate`
 * (which returns a `Future`) from `std:effect`.
 */
export const validateSync = <Schema extends StandardSchemaV1>(
  schema: Schema,
  value: unknown,
): Result<StandardSchemaV1.InferOutput<Schema>, readonly StandardSchemaV1.Issue[]> => {
  const result = schema['~standard'].validate(value)

  if (isPromise(result)) {
    return fail([
      { message: 'validateSync cannot run an async schema; use validate (Future) from std:effect' },
    ])
  }

  if (result.issues) {
    return fail(result.issues)
  }

  return succeed(result.value) as AnyType
}
