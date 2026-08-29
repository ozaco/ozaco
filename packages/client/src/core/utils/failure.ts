import type { AnyType } from 'std:shared'

import type { Helpers } from '../types/helpers'

/**
 * Normalize anything a client call rejected (or a Result failure) into a {@link WireFailure} —
 * apps render this instead of re-parsing causes themselves.
 */
export const wireFailureOf = (error: unknown): Helpers.WireFailure => {
  const failure = error as { error?: unknown; message?: unknown; causes?: unknown } | null
  const causes = [...((failure?.causes as string[] | undefined) ?? [])]
  const status = causes.find(cause => cause.startsWith('status:'))?.slice(7)

  return {
    tag: String((failure?.error as AnyType) ?? 'client.error'),
    message: String(failure?.message ?? error ?? ''),
    causes,
    status: status === undefined ? null : Number(status),
    requestId: causes.find(cause => cause.startsWith('req:'))?.slice(4) ?? null,
  }
}
