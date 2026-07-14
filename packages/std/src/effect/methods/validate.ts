import { fail } from 'std:result'
import type { StandardSchemaV1 } from 'std:shared'
import { isPromise } from 'std:shared'

import { operation } from './operation'
import { until } from './until'

const formatIssues = (issues: readonly StandardSchemaV1.Issue[]): string =>
  issues
    .map(issue => {
      const path = (issue.path ?? [])
        .map(segment =>
          typeof segment === 'object'
            ? String((segment as StandardSchemaV1.PathSegment).key)
            : String(segment),
        )
        .join('.')

      return path === '' ? issue.message : `${path}: ${issue.message}`
    })
    .join('\n')

/**
 * Validate `value` against a Standard Schema (zod, valibot, arktype, …), returning a `Future` that
 * resolves to the parsed output or fails with `std:validation` (the formatted issues as its message).
 * Async schemas are awaited via `until`, so this works with both sync and async validators. For a
 * synchronous `Result` instead, use `validateSync` from `std:shared`.
 */
export const validate = operation(function* <Schema extends StandardSchemaV1>(
  schema: Schema,
  value: unknown,
) {
  const raw = schema['~standard'].validate(value)
  const result = isPromise(raw) ? yield* until(raw) : raw

  if (result.issues) {
    return yield* fail('std:validation', formatIssues(result.issues))
  }

  return result.value as StandardSchemaV1.InferOutput<Schema>
})
