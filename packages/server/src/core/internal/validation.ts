import { operation, until } from 'std:effect'
import { fail } from 'std:result'
import { isPromise } from 'std:shared'
import type { StandardSchemaV1 } from 'std:shared'

import { CoreErrors } from '../errors'
import type { Schema } from '../types/channel'

const MAX_ISSUES = 5

const pathOf = (issue: StandardSchemaV1.Issue): string => {
  if (!issue.path || issue.path.length === 0) {
    return '$'
  }

  return issue.path
    .map(segment =>
      typeof segment === 'object' && segment !== null && 'key' in segment
        ? String(segment.key)
        : String(segment),
    )
    .join('.')
}

/** Runs any Standard Schema validator (zod first-class) — fails `Validation` with issue details. */
export const runSchema = operation(function* (schema: Schema, value: unknown, label: string) {
  const raw = schema['~standard'].validate(value)
  const result = isPromise(raw) ? yield* until(raw) : raw

  if (result.issues) {
    const detail = result.issues
      .slice(0, MAX_ISSUES)
      .map(issue => `${pathOf(issue)}: ${issue.message}`)
      .join('; ')

    return yield* fail(CoreErrors.Validation, `${label} validation failed — ${detail}`)
  }

  return result.value
})
