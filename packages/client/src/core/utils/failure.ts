import type { Operation } from 'std:effect'
import { until } from 'std:effect'
import { fail, formatFailure, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { HEADERS } from '../const'
import { ClientErrors } from '../errors'
import { answeredBy, causesOf, envelopeOf, textOf } from '../internal/failure'
import { markRemote, remoteCause } from '../internal/trace'
import type { Helpers } from '../types/helpers'

/**
 * Normalize anything a client call rejected (or a Result failure) into a {@link WireFailure} —
 * apps render this instead of re-parsing causes themselves. A nested failure cause renders as its
 * one-line `formatFailure`.
 */
export const wireFailureOf = (error: unknown): Helpers.WireFailure => {
  const failure = error as { error?: unknown; message?: unknown; causes?: unknown } | null
  const causes = (Array.isArray(failure?.causes) ? (failure.causes as unknown[]) : []).flatMap(
    cause => (typeof cause === 'string' ? [cause] : isFailure(cause) ? [formatFailure(cause)] : []),
  )
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
 * action reply and for the manifest, and what codegen's `pull` does too. The `{ error }` body is
 * read through JsonCodec (else the `oz-error` header tags it): its tag, message and causes — the
 * nested failures a server exposes (`errors.expose: 'chain'`, or a trusted ozaco caller) come
 * back as real Failures. An ozaco reply (a body or `oz-error`) is a REMOTE failure: a
 * `remote: <operation> @ <service> span <id8>` cause names where it came from (`options.remote`,
 * the answering span from `traceresponse`), and one the server recorded in the caller's own trace
 * (`options.remote.recordedIn`) is marked recorded there. `req:<id>` (when known) and
 * `status:<code>` come LAST. With `refused`, a 401/403 whose reply carries no tag of its own
 * (neither body nor `oz-error`) is tagged `client.refused` instead of `http.<code>`; `prefix`
 * leads the message (`manifest: …`).
 */
export function* failureOf(
  response: Response,
  requestId: string | null,
  options: {
    readonly refused?: boolean
    readonly prefix?: string
    readonly remote?: Helpers.Remote | undefined
  } = {},
): Operation<never> {
  const text = yield* until(response.text().catch(() => ''))
  const envelope = yield* envelopeOf(text)
  const header = response.headers.get(HEADERS.error)
  const refused = options.refused && (response.status === 401 || response.status === 403)
  const tag =
    textOf(envelope?.error) ??
    header ??
    (refused ? ClientErrors.Refused : `http.${response.status}`)
  const message =
    textOf(envelope?.message) ??
    (envelope === null && text.length > 0 ? text : response.statusText || `HTTP ${response.status}`)
  // only an ozaco reply is a remote failure — a bare proxy 502 is the client's own verdict
  const remote = envelope !== null || header !== null ? (options.remote ?? {}) : null

  const failure = fail(
    tag,
    `${options.prefix ?? ''}${message}`,
    ...causesOf(envelope),
    remote && remoteCause(remote, answeredBy(response, envelope)),
    requestId === null ? undefined : `req:${requestId}`,
    `status:${response.status}`,
  )

  if (remote) {
    markRemote(failure, remote)
  }

  return yield* failure
}
