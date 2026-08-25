import type { AnyType } from 'std:shared'

/** A failure as an app renders it — the wire fields plus what the causes carry. */
export interface WireFailure {
  readonly tag: string
  readonly message: string
  readonly causes: readonly string[]

  /** parsed from the `status:<code>` cause the client appends to HTTP failures. */
  readonly status: number | null

  /** parsed from the `req:<id>` cause. */
  readonly requestId: string | null
}

/**
 * Normalize anything a client call rejected (or a Result failure) into a {@link WireFailure} —
 * apps render this instead of re-parsing causes themselves.
 */
export const wireFailureOf = (error: unknown): WireFailure => {
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
