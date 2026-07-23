import { CoreErrors } from 'server:core'
import { isOperation, operation } from 'std:effect'
import { fail } from 'std:result'

import type { AccessContext, AccessGuard } from '../types'

/** Compose two access guards, evaluating the second only when the first allows the action. */
export const composeAccess =
  (outer: AccessGuard, inner: AccessGuard | undefined): AccessGuard =>
  context =>
    operation(function* () {
      const outerResult = outer(context)
      if (!(isOperation(outerResult) ? yield* outerResult : outerResult)) {
        return false
      }
      if (!inner) {
        return true
      }
      const innerResult = inner(context)
      return isOperation(innerResult) ? yield* innerResult : innerResult
    })()

/** Evaluate a guard and fail with the server's canonical forbidden error when access is denied. */
export const assertAccess = (guard: AccessGuard | undefined, context: AccessContext) =>
  operation(function* () {
    if (!guard) {
      return
    }
    const result = guard(context)
    const allowed = isOperation(result) ? yield* result : result
    if (!allowed) {
      return yield* fail(
        CoreErrors.Forbidden,
        `access denied: ${context.op} on "${context.namespace}"`,
      )
    }
  })()
