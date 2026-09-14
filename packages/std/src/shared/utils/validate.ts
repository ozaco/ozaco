import type { Result } from 'std:result'
import { fail, succeed } from 'std:result'

import { SharedErrors } from '../errors'
import type { AnyType } from '../types/common'
import type { StandardSchemaV1 } from '../types/schema'

import { isPromise } from './is'

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
 * `Result`: the parsed output on success, or a `SharedErrors.Validation` failure whose `causes`
 * carry one `path: message` line per issue (the message is the first line). Async schemas cannot
 * run here and fail `SharedErrors.AsyncSchema`.
 */
export const validateSync = <Schema extends StandardSchemaV1>(
  schema: Schema,
  value: unknown,
): Result<StandardSchemaV1.InferOutput<Schema>, string> => {
  const result = schema['~standard'].validate(value)

  if (isPromise(result)) {
    return fail(SharedErrors.AsyncSchema, 'validateSync cannot run an async schema')
  }

  if (result.issues) {
    const lines = result.issues.map(describeIssue)

    return fail(SharedErrors.Validation, lines[0] ?? 'validation failed', ...lines)
  }

  return succeed(result.value) as AnyType
}
