import type { Result } from 'std:result'

import { ServerErrors, STATUS_OF } from '../errors'
import type { ServiceDef } from '../types/service'

/** The tag of a failure: a string tag as-is; a thrown non-Result error is `server.internal`. */
export const tagOf = (failure: Result.Failure<unknown>): string =>
  typeof failure.error === 'string' ? failure.error : ServerErrors.Internal

/** The HTTP status of a failure: the action's override, then the core table, then 500. */
export const statusOf = (
  failure: Result.Failure<unknown>,
  meta?: Pick<ServiceDef.Meta, 'errors'>,
): number => {
  const tag = tagOf(failure)
  return meta?.errors[tag] ?? STATUS_OF[tag] ?? 500
}

/** The breadcrumb every boundary appends: where the failure passed and under which ids. */
export const breadcrumb = (where: string, ids: { requestId?: string; spanId?: string }): string =>
  `${where}${ids.spanId ? ` span:${ids.spanId}` : ''}${ids.requestId ? ` req:${ids.requestId}` : ''}`
