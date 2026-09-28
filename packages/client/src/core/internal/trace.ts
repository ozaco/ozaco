import type { Flow, Operation, Subscription } from 'std:effect'
import { attempt, ensure, useScope, within } from 'std:effect'
import { redactUrl } from 'std:fetch'
import type { Result } from 'std:result'
import { asFailure, isFailure } from 'std:result'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import { HEADERS } from '../const'
import { ClientErrors } from '../errors'
import type { Helpers } from '../types/helpers'

import {
  DEFAULT_PORTS,
  EXCEPTION_EVENT,
  KNOWN_METHODS,
  REMOTE_SPAN_DIGITS,
  TRACE_SCOPE,
  UNANSWERED_STATUS,
} from './const'

/** The status a decoded failure was answered with (its `status:<code>` cause), else 500 — the
 * span's classifier (the OUTERMOST span's wins: a dispatch around the call maps its own). */
const answeredStatus = (failure: Result.Failure<unknown>): number => {
  const cause = failure.causes.findLast(
    (item): item is string => typeof item === 'string' && item.startsWith('status:'),
  )
  const code = cause === undefined ? Number.NaN : Number(cause.slice(7))

  return Number.isInteger(code) && code > 0 ? code : UNANSWERED_STATUS
}

/** `server.address` / `server.port` (the scheme's port when implicit; IPv6 without brackets). */
const serverOf = (url: URL): TraceDef.AttributesInput => {
  const { hostname } = url
  const address =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname

  return {
    'server.address': address || undefined,
    'server.port': url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol],
  }
}

/** Case-insensitive lookup of a header name in a plain record. */
const nameIn = (headers: Readonly<Record<string, string>>, name: string): string | undefined =>
  Object.keys(headers).find(key => key.toLowerCase() === name)

/**
 * The CLIENT span of one HTTP exchange, or `null` while tracing is off (or suppressed) where the
 * call runs: named `{METHOD} {route}` (the route TEMPLATE — `/demo/:id`, low cardinality; `HTTP`
 * for a method outside the known set, then `_OTHER` + `http.request.method_original`), scope
 * `@ozaco/client`, with `http.request.method`, `url.full` (redacted), `url.template`,
 * `server.address` / `server.port`. A failure escaping it is classified by the status it was
 * answered with and originates as `http.client.request.exception`.
 */
export function* openCall(
  method: string,
  route: string,
  url: URL,
): Operation<Helpers.CallSpan | null> {
  if (!(yield* Trace.actions.isTracing())) {
    return null
  }

  const upper = method.toUpperCase()
  const known = KNOWN_METHODS.has(upper)

  const live = yield* Trace.actions.startSpan(`${known ? upper : 'HTTP'} ${route}`, {
    kind: 'client',
    scope: TRACE_SCOPE,
    failure: { status: answeredStatus, eventName: EXCEPTION_EVENT },

    attributes: {
      'http.request.method': known ? upper : '_OTHER',
      'http.request.method_original': known ? undefined : method,
      'url.full': redactUrl(url.href),
      'url.template': route,
      ...serverOf(url),
    },
  })

  return {
    live,
    context: live.context,
    valid: live.valid,
    recording: live.recording,
    scope: yield* useScope(),
    headersAt: undefined,
    consuming: false,
  }
}

/**
 * The trace-context headers a call carries: its CLIENT span's (`ozaco=1` in `tracestate` while
 * it records — the server continues an exporting ozaco caller's trace), else the caller's
 * ambient context as it is (a pass-through inbound one while tracing is off; unsampled under
 * suppression), else none.
 */
export function* carrierOf(call: Helpers.CallSpan | null): Operation<TraceDef.Carrier> {
  if (call?.live) {
    return yield* call.live.run(() => Trace.actions.inject({ ozaco: true }))
  }

  return yield* Trace.actions.inject()
}

/**
 * `headers` with the carrier set — untouched when there is nothing to inject or the caller set a
 * `traceparent` of their own (theirs wins, with their `tracestate`); a stray caller `tracestate`
 * never pairs with our `traceparent`.
 */
export const withCarrier = (
  headers: Readonly<Record<string, string>>,
  carrier: TraceDef.Carrier,
): Record<string, string> => {
  if (!carrier.traceparent || nameIn(headers, HEADERS.traceparent) !== undefined) {
    return { ...headers }
  }

  const stray = nameIn(headers, HEADERS.tracestate)
  const next = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== stray))

  next[HEADERS.traceparent] = carrier.traceparent

  if (carrier.tracestate) {
    next[HEADERS.tracestate] = carrier.tracestate
  }

  return next
}

/** The server's `traceresponse` (its edge span's context), or `null`. */
export function* echoedContext(response: Response): Operation<TraceDef.SpanContext | null> {
  const traceparent = response.headers.get(HEADERS.traceresponse)

  return traceparent ? yield* Trace.actions.extract({ traceparent }) : null
}

/** The reply's headers arrived: `http.response.status_code`, and the time a body that is never
 * consumed ends the span at. */
export function* markResponse(call: Helpers.CallSpan, response: Response): Operation<void> {
  const live = call.live

  if (!live) {
    return
  }

  call.headersAt = yield* live.run(() => Trace.actions.traceNow())

  if (response.status > 0) {
    live.setAttribute('http.response.status_code', response.status)
  }
}

/**
 * The trace (THIS call's) the server already recorded a failure it answered in, else
 * `undefined`: it continued the recording CLIENT span's trace (the echoed `traceresponse` is in
 * it) with a span of its own (a pass-through node echoes the caller's context unchanged — it
 * recorded nothing).
 */
export const recordedBy = (
  call: Helpers.CallSpan | null,
  echoed: TraceDef.SpanContext | null,
): string | undefined =>
  call !== null &&
  call.recording &&
  echoed !== null &&
  echoed.traceId === call.context.traceId &&
  echoed.spanId !== call.context.spanId
    ? echoed.traceId
    : undefined

/**
 * The cause naming where a failure decoded from another node's reply came from:
 * `remote: <operation> @ <service> span <spanId first 8>` — the parts that are known (none
 * known: no cause, `undefined`, which `fail` drops).
 */
export const remoteCause = (remote: Helpers.Remote, spanId?: string): string | undefined => {
  const parts = [
    remote.operation,
    remote.service ? `@ ${remote.service}` : undefined,
    spanId ? `span ${spanId.slice(0, REMOTE_SPAN_DIGITS)}` : undefined,
  ].filter(part => typeof part === 'string' && part.length > 0)

  return parts.length > 0 ? `remote: ${parts.join(' ')}` : undefined
}

/**
 * A decoded failure the sender recorded in `remote.recordedIn` (the caller's own trace): marked
 * recorded there as a REMOTE one — the caller's spans carry only its status and
 * `ozaco.failure.remote`, the one exception stays the sender's.
 */
export function* markRemote(
  failure: Result.Failure<unknown>,
  remote: Helpers.Remote,
): Operation<void> {
  if (remote.recordedIn) {
    yield* Trace.actions.markRecorded(failure, remote.recordedIn, { remote: true })
  }
}

/** The trace a call belongs to: the server's `traceresponse`, else its own CLIENT span's. */
export const traceIdOf = (
  call: Helpers.CallSpan | null,
  echoed: TraceDef.SpanContext | null,
): string | null => {
  if (echoed) {
    return echoed.traceId
  }

  return call?.valid ? call.context.traceId : null
}

/**
 * End the call's span (idempotent). Where it started, directly; from any other scope (a stream
 * consumed by `for await` in the client's scope), inside the scope it started in — its Trace sinks is
 * visible there. A span whose scope is already gone was ended by that scope's fallback.
 */
export function* endCall(
  call: Helpers.CallSpan,
  options: TraceDef.EndOptions = {},
): Operation<void> {
  const live = call.live

  if (!live) {
    return
  }

  call.live = null

  if ((yield* useScope()) === call.scope) {
    yield* live.end(options)

    return
  }

  yield* attempt(() => within(call.scope, () => live.end(options)))
}

/** {@link endCall} from promise land (a byte stream's callbacks): a detached task of the scope
 * the span started in. */
export const endDetached = (call: Helpers.CallSpan, options: TraceDef.EndOptions = {}): void => {
  const live = call.live

  if (!live) {
    return
  }

  call.live = null

  try {
    void call.scope.run(() => live.end(options), { detached: true })
  } catch {
    // the scope is gone — its fallback ended the span already
  }
}

/**
 * The end a call's span gets when the scope it started in closes first: cancelled mid-request
 * or mid-consumption; a body never consumed ends it when its headers arrived.
 */
export const fallbackOf = (call: Helpers.CallSpan) => (): Operation<void> | undefined => {
  if (!call.live) {
    return undefined
  }

  return endCall(
    call,
    call.headersAt === undefined || call.consuming ? { cancelled: true } : { time: call.headersAt },
  )
}

/**
 * A streamed reply's Flow (ndjson / sse values) ending the call's span with the stream: at its
 * end, with the failure a read fails with, cancelled when the consuming scope leaves early.
 */
export const watchedFlow = <T>(call: Helpers.CallSpan, source: Flow<T, void>): Flow<T, void> => ({
  *[Symbol.iterator]() {
    call.consuming = true

    // an abandoned stream (the consuming scope left before its end); a no-op once it ended
    yield* ensure(() => endCall(call, { cancelled: true }))

    const opened = yield* attempt(() => source)

    if (isFailure(opened)) {
      yield* endCall(call, { failure: opened })

      return yield* opened
    }

    const subscription = opened.value

    return {
      *next() {
        const step = yield* attempt(() => subscription.next())

        if (isFailure(step)) {
          yield* endCall(call, { failure: step })

          return yield* step
        }

        if (step.value.done) {
          yield* endCall(call)
        }

        return step.value
      },
    } satisfies Subscription<T, void>
  },
})

/** How a consumed byte stream settled, as the end of the call's span: a body that broke
 * mid-read with a transport fault fails it `client.network` (`ClientErrors` classifies the
 * platform error, kept as `raw`), anything else as its `std:result.unknown` fold. */
export const endOfStream = (outcome: Helpers.HeldOutcome): TraceDef.EndOptions =>
  outcome.cancelled
    ? { cancelled: true }
    : outcome.error === undefined
      ? {}
      : { failure: asFailure(outcome.error, ClientErrors) }
