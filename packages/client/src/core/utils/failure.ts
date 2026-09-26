import type { Operation } from 'std:effect'
import { until } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { HEADERS } from '../const'
import { ClientErrors } from '../errors'
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

/**
 * Decode a failed HTTP reply from an ozaco node into a Result failure — what the client does for an
 * action reply and for the manifest, and what codegen's `pull` does too. The wire failure
 * (`{ error }` body, else the `oz-error` header) is rebuilt; `req:<id>` (when known) and
 * `status:<code>` are appended to the causes. With `refused`, a 401/403 whose reply carries no
 * tag of its own (neither body nor `oz-error`) is tagged `client.refused` instead of `http.<code>`;
 * `prefix` leads the message (`manifest: …`).
 */
export function* failureOf(
  response: Response,
  requestId: string | null,
  options: { readonly refused?: boolean; readonly prefix?: string } = {},
): Operation<never> {
  const text = yield* until(response.text().catch(() => ''))
  let wire: { error?: string; message?: string; causes?: string[] } | null = null

  try {
    wire = (JSON.parse(text) as AnyType)?.error ?? null
  } catch {
    wire = null
  }
  const refused = options.refused && (response.status === 401 || response.status === 403)
  const tag =
    wire?.error ??
    response.headers.get(HEADERS.error) ??
    (refused ? ClientErrors.Refused : `http.${response.status}`)
  const message =
    wire?.message ?? (text.length > 0 ? text : response.statusText || `HTTP ${response.status}`)

  return yield* fail(
    tag,
    `${options.prefix ?? ''}${message}`,
    ...(wire?.causes ?? []),
    ...(requestId === null ? [] : [`req:${requestId}`]),
    `status:${response.status}`,
  )
}
