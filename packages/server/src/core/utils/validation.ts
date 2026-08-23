import { until } from 'std:effect'
import type { Operation } from 'std:effect'
import { fail } from 'std:result'
import type { StandardSchemaV1 } from 'std:shared'
import { isPromise } from 'std:shared'

import { ServerErrors } from '../errors'

/** Run a Standard Schema validator (sync or async); issues become ONE `server.validation`. */
export function* validate<T>(
  schema: StandardSchemaV1,
  value: unknown,
  where: string,
): Operation<T> {
  const verdict = schema['~standard'].validate(value)
  const result = isPromise(verdict) ? yield* until(verdict) : verdict

  if (result.issues) {
    const issues = result.issues.slice(0, 5).map(issue => {
      const path = (issue.path ?? [])
        .map(segment => (typeof segment === 'object' ? String(segment.key) : String(segment)))
        .join('.')
      return path ? `${path}: ${issue.message}` : issue.message
    })

    return yield* fail(ServerErrors.Validation, `${where} rejected`, ...issues)
  }

  return result.value as T
}
