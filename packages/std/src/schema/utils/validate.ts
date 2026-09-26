import type { Result } from 'std:result'
import { fail, succeed } from 'std:result'
import type { AnyType, StandardSchemaV1 } from 'std:shared'
import { isPromise } from 'std:shared'

import { SchemaErrors } from '../errors'

/** `a.b.0: message` — one issue as a cause line (path-less issues are the bare message). */
const describeIssue = (issue: StandardSchemaV1.Issue): string => {
  const path = (issue.path ?? [])
    .map(segment =>
      typeof segment === 'object' ? String((segment as { key: PropertyKey }).key) : String(segment),
    )
    .join('.')

  return path === '' ? issue.message : `${path}: ${issue.message}`
}

/**
 * Validate `value` against a Standard Schema (zod, valibot, arktype, …) SYNCHRONOUSLY, returning a
 * `Result`: the parsed output on success, or a `SchemaErrors.Validation` failure whose `causes`
 * carry one `path: message` line per issue (the message is the first line). Async schemas cannot
 * run here and fail `SchemaErrors.AsyncSchema`.
 */
export const validateSync = <Schema extends StandardSchemaV1>(
  schema: Schema,
  value: unknown,
): Result<StandardSchemaV1.InferOutput<Schema>, string> => {
  const result = schema['~standard'].validate(value)

  if (isPromise(result)) {
    return fail(SchemaErrors.AsyncSchema, 'validateSync cannot run an async schema')
  }

  if (result.issues) {
    const lines = result.issues.map(describeIssue)

    return fail(SchemaErrors.Validation, lines[0] ?? 'validation failed', ...lines)
  }

  return succeed(result.value) as AnyType
}
