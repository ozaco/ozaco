import type { Operation } from 'std:effect'
import { attempt, scoped } from 'std:effect'
import type { Result } from 'std:result'
import { isFailure, isSuccess } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import type { Helpers } from '../types/helpers'

import { echoedContext } from './trace'

/**
 * The reply body through JsonCodec — the wire's failure path: a nested failure the server
 * exposes (`errors.expose: 'chain'`, a trusted caller) comes back a real Failure (its tag,
 * message and causes; a `raw` never leaves the node). Parsed in a scope of its own, JsonCodec
 * installed there when the caller has none (codegen's `pull`); anything but JSON is `undefined`.
 */
function* parsed(text: string): Operation<unknown> {
  const outcome = yield* attempt(() =>
    scoped(function* () {
      if ((yield* JsonCodec.context.get()) === undefined) {
        yield* JsonCodec.use()
      }

      return yield* JsonCodec.actions.parse(text)
    }),
  )

  return isSuccess(outcome) ? outcome.value : undefined
}

export function* envelopeOf(text: string): Operation<Helpers.Envelope | null> {
  const error = ((yield* parsed(text)) as { error?: unknown } | null | undefined)?.error

  return typeof error === 'object' && error !== null ? (error as Helpers.Envelope) : null
}

export const textOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

/** The envelope's causes that are causes: domain strings and nested failures, in their order. */
export const causesOf = (envelope: Helpers.Envelope | null): Result.Cause[] =>
  Array.isArray(envelope?.causes)
    ? envelope.causes.filter(
        (cause): cause is Result.Cause => typeof cause === 'string' || isFailure(cause),
      )
    : []

/** The server's span that answered (its `traceresponse`), when it is in the trace the envelope
 * names. */
export function* answeredBy(
  response: Response,
  envelope: Helpers.Envelope | null,
): Operation<string | undefined> {
  const echoed = yield* echoedContext(response)
  const traceId = textOf(envelope?.traceId) ?? echoed?.traceId

  return echoed && echoed.traceId === traceId ? echoed.spanId : undefined
}
