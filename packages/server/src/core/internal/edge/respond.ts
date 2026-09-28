// oxlint-disable import/exports-last
import type { Operation, Scope } from 'std:effect'
import { attempt, spawn, suspend, useScope, withResolvers, within } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isFailure, ResultErrors } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import { HEADERS } from '../../const'
import type { Helpers } from '../../types/helpers'
import type { StreamDef } from '../../types/stream'
import type { WireDef } from '../../types/wire'
import { statusOf, tagOf } from '../../utils/failure'
import { brandOf, brandSpecOf, isBranded } from '../../utils/stream'

const encoder = new TextEncoder()

/** SSE comment-frame interval: keeps quiet streams alive through connection idle timeouts
 * (Bun closes idle connections after ~10s by default). Env-tunable for tests. */
const keepaliveMs = (): number => {
  const given = Number(process.env['OZACO_SSE_KEEPALIVE_MS'])

  return Number.isFinite(given) && given > 0 ? given : 15_000
}

/** Encode a flow-brand chunk (one codec value) for the wire: ndjson lines or SSE frames. */
const frameOf = (brand: string, value: unknown): Uint8Array => {
  const json = JSON.stringify(value)

  return encoder.encode(brand === 'sse' ? `data: ${json}\n\n` : `${json}\n`)
}

/** A branded stream as an HTTP body: raw bytes pass through; value streams render per brand.
 * `broke` hears an SSE source that FAILED (the body still ends cleanly — see below). */
const bodyOf = (
  stream: StreamDef.Branded,
  broke?: (reason: unknown) => void,
): { body: ReadableStream<Uint8Array>; type: string } => {
  const brand = brandOf(stream)
  const spec = brandSpecOf(brand)
  const type = spec?.contentType ?? 'application/octet-stream'

  if (!spec || spec.plane === 'stream') {
    return { body: stream as ReadableStream<Uint8Array>, type }
  }

  const reader = (stream as ReadableStream<unknown>).getReader()
  let pending: Promise<IteratorResult<unknown, undefined>> | null = null

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (brand === 'sse') {
        // an opening comment flushes the headers at once: a runtime that waits for the first
        // chunk would otherwise hold the whole response until the first event
        controller.enqueue(encoder.encode(': ok\n\n'))
      }
    },
    async pull(controller) {
      // sse: a quiet stream still writes `: keepalive` comments, so idle timeouts never cut a
      // live feed that simply has nothing to say (the console's live SSE, an event relay)
      if (brand === 'sse') {
        pending ??= reader.read() as Promise<IteratorResult<unknown, undefined>>

        const step = await new Promise<IteratorResult<unknown, undefined> | null>(resolve => {
          const timer = setTimeout(() => {
            resolve(null)
          }, keepaliveMs())

          pending!.then(
            result => {
              clearTimeout(timer)
              resolve(result)

              return null
            },
            (error: unknown) => {
              clearTimeout(timer)
              // a failed feed ends the SSE body CLEANLY (an EventSource simply reconnects) — but
              // never silently: the failure is handed to `broke` (the edge span ends with it)
              broke?.(error)
              resolve({ done: true, value: undefined })

              return null
            },
          )
        })

        if (step === null) {
          controller.enqueue(encoder.encode(': keepalive\n\n'))

          return
        }

        pending = null

        if (step.done) {
          controller.close()

          return
        }

        controller.enqueue(frameOf(brand, step.value))

        return
      }

      const step = await reader.read()

      if (step.done) {
        controller.close()

        return
      }

      controller.enqueue(
        brand === 'text' ? encoder.encode(String(step.value)) : frameOf(brand, step.value),
      )
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })

  return { body, type }
}

/** The response of a successful dispatch. The status defaults to 200 (204 for no value) unless
 * the action or the handler said otherwise; a 204/304 never carries a body, so a value replied
 * under such a status is dropped rather than producing an invalid response. The request id /
 * `traceresponse` headers are stamped by the edge once the decorators ran. */
export const responseOf = (value: unknown, shape?: Helpers.ReplyShape): Response => {
  const headers = new Headers()

  for (const [name, header] of Object.entries(shape?.headers ?? {})) {
    headers.set(name, header)
  }

  if (isBranded(value)) {
    const { body, type } = bodyOf(value, shape?.broke)

    headers.set('content-type', type)
    headers.set(HEADERS.brand, brandOf(value))

    if (brandOf(value) === 'sse') {
      headers.set('cache-control', 'no-cache')
    }

    return new Response(body, { status: shape?.status ?? 200, headers })
  }

  const status = shape?.status ?? (value === undefined ? 204 : 200)

  if (value === undefined || status === 204 || status === 304) {
    return new Response(null, { status, headers })
  }

  return Response.json(value, { status, headers })
}

/** How deep an exposed chain is copied onto the wire (a deeper failure, or one closing a cycle,
 * is left out). */
const CHAIN_DEPTH = 8

/**
 * A scope of the edge's own where `JsonCodec` is installed — the failure envelope's writer. Its
 * install never touches the scope the edge runs in, so an app's own codec stays the ACTIVE one
 * of its carriers (an install in a child scope is local to it). Lives as long as the calling
 * scope.
 */
export function* jsonScope(): Operation<Scope | null> {
  const ready = withResolvers<Scope | null>('edge json codec')

  yield* spawn(function* () {
    // a JSON codec of ANOTHER std release under the same name refuses the install: the envelope
    // is then plain JSON (`textOf`), never an edge that cannot start
    const installed = yield* attempt(() => JsonCodec.use())

    ready.resolve(isFailure(installed) ? null : yield* useScope())
    yield* suspend()
  })

  return yield* ready.operation
}

/** A copy of `failure` for the wire: its tag, message and string causes, its nested failures
 * copied the same way (at most {@link CHAIN_DEPTH} deep, cycle-safe) — never its `raw` (the
 * foreign value a fold came from stays home). A level whose `error` slot holds no tag (a
 * hand-built `fail(value)`) is written as the fold it stands for, `std:result.unknown`. */
const bareFailure = (
  failure: Result.Failure<unknown>,
  path: ReadonlySet<Result.Failure<unknown>> = new Set(),
): Result.Failure<unknown> => {
  const seen = new Set(path).add(failure)
  const causes = failure.causes.flatMap<Result.Cause>(cause =>
    typeof cause === 'string'
      ? [cause]
      : isFailure(cause) && !seen.has(cause) && seen.size < CHAIN_DEPTH
        ? [bareFailure(cause, seen)]
        : [],
  )
  const error = typeof failure.error === 'string' ? failure.error : ResultErrors.Unknown

  return fail(error, failure.message, ...causes)
}

/** The cause a transport adds to a failure it decoded from another node — `remote: <operation> @
 * <service> span <id8>`: the cluster's own topology (node ids, span ids). */
const REMOTE_CAUSE = 'remote: '

/**
 * The envelope's `causes`: the failure's string causes, as plain strings — and with the chain
 * exposed, the failures it wraps among them (stored order; bare copies — `bareFailure`). Without
 * the chain the `remote: …` causes a carrier hop added stay home (telemetry keeps them): an
 * untrusted caller never learns the cluster's node names and span ids.
 */
const causesOf = (failure: Result.Failure<unknown>, chain: boolean): Result.Cause[] =>
  chain
    ? bareFailure(failure).causes
    : failure.causes.filter(cause => typeof cause === 'string' && !cause.startsWith(REMOTE_CAUSE))

/**
 * The envelope as text, the JsonCodec's: its nested failures tagged (a JsonCodec decode rebuilds
 * them into real Failures). An envelope of string causes alone is plain JSON — exactly what the
 * JsonCodec writes for it — without the trip to the codec scope; so is one whose codec scope is
 * gone (the edge stopping), its string causes kept.
 */
function* textOf(wire: WireDef.HttpFailure, json: Scope | null): Operation<string> {
  if (json && wire.causes.some(cause => typeof cause !== 'string')) {
    const text = yield* attempt(() =>
      within(json, () => JsonCodec.actions.stringify({ error: wire })),
    )

    if (!isFailure(text)) {
      return text.value
    }
  }

  const causes = wire.causes.filter(cause => typeof cause === 'string')

  return JSON.stringify({ error: { ...wire, causes } })
}

/**
 * The response of a failed reply: `{ error: WireDef.HttpFailure }` under the failure's status
 * (`statusOf(f, meta)`), flagged by the `oz-error` header, written with the JsonCodec. The body is
 * built field by field — no `_d`, no internals; `causes` holds the string causes (but the
 * `remote: …` ones), and the nested failures and `remote: …` causes only when `shape.chain` says
 * so.
 */
export function* failureResponse(
  failure: Result.Failure<unknown>,
  shape: Helpers.FailureShape,
): Operation<Response> {
  const status = statusOf(failure, shape.meta)

  const wire: WireDef.HttpFailure = {
    error: tagOf(failure),
    message: failure.message,
    causes: causesOf(failure, shape.chain),
    status,
    requestId: shape.requestId,
    traceId: shape.traceId,
  }

  return new Response(yield* textOf(wire, shape.json), {
    status,
    headers: { 'content-type': 'application/json;charset=utf-8', [HEADERS.error]: wire.error },
  })
}
