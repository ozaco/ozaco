// oxlint-disable import/exports-last
import type { Operation, Scope } from 'std:effect'
import { attempt, createQueue, race, scoped, sleep, useScope } from 'std:effect'
import type { Result } from 'std:result'
import { appendCauses, isFailure } from 'std:result'
import { utf8Length } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import { AuthCauses } from '../../../plugins/auth/errors'
import { EXCEPTION_EVENT_NAME, SOCKET_AUTH_GRACE_MS } from '../../const'
import { CtxRef } from '../../context'
import type { EdgeDef } from '../../types/edge'
import type { Helpers } from '../../types/helpers'
import type { ServerDef } from '../../types/server'
import { tagOf } from '../../utils/failure'
import { scopeOf, traceOf } from '../../utils/trace'
import { validate } from '../../utils/validation'
import { frameText } from '../capture'
import { contextFor } from '../dispatch'
import { classify } from '../spans'

import { frameInboundOf } from './inbound'
import { edgeLog } from './log'

const decoder = new TextDecoder()

/** Frame types that never open a span: the transport's own (`auth`) and keepalives. */
const QUIET = new Set(['auth', 'ping', 'pong'])

/** The close code of a failed first-frame authorization. */
const AUTH_CLOSE_CODE = 4401

/** WARN — a refused / malformed frame is the client's doing, not a server error. */
const CLIENT_SEVERITY = 13

/** The trace-clock time `frame` arrived at: now on the trace clock, less the monotonic time
 * elapsed since its receipt (never a `Date.now()` stamp — whole milliseconds, and a clock the
 * frame's children do not read). */
function* startOf(frame: Helpers.InboundFrame): Operation<number> {
  return (yield* Trace.actions.traceNow()) - Math.max(0, performance.now() - frame.at)
}

/**
 * The socket's {@link Helpers.ReleasedFrames}: released frame spans end a scheduler tick after their release, in
 * release order, from ONE task of the socket's scope; `flush` ends what still waits when the
 * socket is done.
 */
const laterIn = (scope: Scope): Helpers.ReleasedFrames => {
  const waiting: [TraceDef.LiveSpan, TraceDef.EndOptions][] = []
  let armed = false

  function* flush(): Operation<void> {
    armed = false

    for (const [span, options] of waiting.splice(0)) {
      yield* span.end(options)
    }
  }

  return {
    defer(live, end) {
      waiting.push([live, end])

      if (armed) {
        return true
      }

      try {
        scope.run(
          function* () {
            yield* sleep(0)
            yield* flush()
          },
          { detached: true },
        )
      } catch {
        // the socket's scope is gone: nothing left to wait for
        waiting.pop()

        return false
      }

      armed = true

      return true
    },
    flush,
  }
}

/** The auth-frame shape a deferred socket waits for (validated structurally — it arrives
 * before the route's `receives` schema applies). */
const authFrameOf = (value: unknown): string | null =>
  typeof value === 'object' &&
  value !== null &&
  (value as { t?: unknown }).t === 'auth' &&
  typeof (value as { token?: unknown }).token === 'string'
    ? ((value as { token: string }).token as string)
    : null

/** A frame's type: its `t` (the ozaco protocols), else its `type`. */
const typeOf = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const { t, type } = value as { t?: unknown; type?: unknown }

  return typeof t === 'string' ? t : typeof type === 'string' ? type : undefined
}

/** The trace context a frame carries in its `traceparent` / `tracestate` fields. */
function* contextOf(value: unknown): Operation<TraceDef.SpanContext | null> {
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const { traceparent, tracestate } = value as { traceparent?: unknown; tracestate?: unknown }

  if (typeof traceparent !== 'string') {
    return null
  }

  return yield* Trace.actions.extract({
    traceparent,
    ...(typeof tracestate === 'string' ? { tracestate } : {}),
  })
}

/** The previous socket generation a RE-sent frame names: its `reconnect` field, the
 * `traceparent` that generation opened with (what `@ozaco/client` sends after a reconnect). */
function* reconnectOf(value: unknown): Operation<TraceDef.SpanContext | null> {
  const reconnect =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as { reconnect?: unknown }).reconnect
      : undefined

  return typeof reconnect === 'string'
    ? yield* Trace.actions.extract({ traceparent: reconnect })
    : null
}

/** A frame's value without the transport's trace fields (`traceparent`, `tracestate`, and a
 * `reconnect` that IS a traceparent) — they are never the handler's. */
function* payloadOf(value: unknown): Operation<unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value
  }

  const reconnecting = (yield* reconnectOf(value)) !== null

  if (!('traceparent' in value) && !('tracestate' in value) && !reconnecting) {
    return value
  }

  const { traceparent: _parent, tracestate: _state, ...rest } = value as Record<string, unknown>

  if (!reconnecting) {
    return rest
  }

  const { reconnect: _previous, ...payload } = rest

  return payload
}

/**
 * Open the ROOT server span `WS {route}` of one inbound frame (design §6.2): it LINKS the
 * upgrade span (`ws.session`) and, for a frame re-sent after a reconnect, the previous socket
 * generation it names (`ws.reconnect`); the frame's own `traceparent` is its parent when the node
 * trusts the upgrade (`trace.trust`: its sampled flag honoured) or the caller marked itself
 * (`ozaco=1` on the upgrade or the frame: continued, always recorded here), else it is linked /
 * ignored by the `trace.inbound` policy (`inboundOf`). `http.route`, `ozaco.ws.message.type` /
 * `.size`, `ozaco.ws.session.id` (the upgrade span's too), and the body with capture `frames` (its
 * secret keys `REDACTED`, `frameText`). `frame` is `null` for a session
 * event that is no frame (the auth grace expired, the handler failed between frames). A failure
 * ending it is classified like every kernel span (`statusOf` / `tagOf`: a thrown error is
 * `server.internal`, a client-caused one leaves the status unset). `record: 'errors'` for a span
 * that only matters when it fails (the first-frame authorization).
 */
function* openFrame(
  input: Helpers.SocketInput,
  session: Helpers.SocketSession,
  opening: Helpers.FrameOpening,
): Operation<TraceDef.LiveSpan> {
  const { kernel, route } = input
  const { frame, record = 'always' } = opening
  const inbound = frame ? yield* contextOf(frame.value) : null
  // the inbound policy only for a frame that carries a context, under the upgrade's verdict
  const policy = inbound ? frameInboundOf(kernel, inbound, input) : null

  const previous = frame ? yield* reconnectOf(frame.value) : null
  const links: TraceDef.LinkInput[] = [
    ...(input.upgrade
      ? [{ context: input.upgrade, attributes: { 'ozaco.link.reason': 'ws.session' } }]
      : []),
    ...(previous
      ? [{ context: previous, attributes: { 'ozaco.link.reason': 'ws.reconnect' } }]
      : []),
  ]

  return yield* Trace.actions.startSpan(`WS ${route.path}`, {
    kind: 'server',
    scope: scopeOf(),
    parent: policy?.parent ?? null,
    links: policy ? [...links, ...policy.links] : links,
    startTime: frame ? yield* startOf(frame) : undefined,
    record,
    failure: classify(EXCEPTION_EVENT_NAME.edge),

    attributes: {
      'http.route': route.path,
      'ozaco.ws.message.type': frame ? typeOf(frame.value) : undefined,
      'ozaco.ws.message.size': frame?.size,
      'ozaco.ws.session.id': session.id,
      // never an auth frame's body: its token stays out of telemetry
      'ozaco.ws.message.body':
        frame && kernel.telemetry.observe.capture.frames && authFrameOf(frame.value) === null
          ? frameText(frame.text, frame.value, kernel.telemetry.observe.capture.sensitiveKeys)
          : undefined,
    },
  })
}

/**
 * Make `live` the ACTIVE span of the scope that pulled its frame — the handler's work on the
 * frame (sends, `ctx.call`, `ctx.log`, db) nests under it until the handler pulls again. With
 * tracing off a frame's context rides on as a pass-through (propagation survives) only when this
 * node would CONTINUE it — a trusted or self-marked caller (`trace.trust`, `ozaco=1`) or
 * `trace.inbound: 'continue'` — and as it would be continued (a self-marked caller's `-00` is not
 * honoured): the rule `edgeSpan` follows. One it would only link (a stranger's) never does, or its
 * sampled flag (a `-00`) and its span would reach every node behind this one through the
 * carriers, which always continue what they receive.
 */
function* hold(
  input: Helpers.SocketInput,
  {
    live,
    frame,
    later,
  }: { live: TraceDef.LiveSpan; frame: Helpers.InboundFrame; later: Helpers.ReleasedFrames },
): Operation<Helpers.HeldFrame> {
  if (yield* Trace.actions.isTracing()) {
    return { live, restore: yield* Trace.actions.activate(live), later }
  }

  const inbound = yield* contextOf(frame.value)
  const policy = inbound ? frameInboundOf(input.kernel, inbound, input) : null
  // forwarded as it would be continued: a self-marked caller's with the sampled bit set
  const parent = policy?.mode === 'continue' ? policy.parent : undefined

  return { live, restore: yield* Trace.actions.activate(parent ?? undefined), later }
}

/**
 * Give the handler's scope back what was active before the held frame span, and end that span
 * (the handler pulled again, or ended). Work the handler STARTED on the frame and left running —
 * a forked task (the realtime `watch`) whose first steps are still queued when the handler pulls
 * again — opens its spans under the frame span a moment later: a released frame span therefore
 * ends once that work had its turn (a scheduler tick, `laterIn`), never before the spans it
 * caused start. A failure / cancel ends it at once, and so does `now` (the handler is done).
 */
function* release(
  held: Helpers.HeldFrame,
  { now = false, ...end }: TraceDef.EndOptions & { readonly now?: boolean } = {},
): Operation<void> {
  held.restore()

  // a span that records nothing has no end time worth waiting for
  if (
    !now &&
    held.live.recording &&
    end.failure === undefined &&
    end.cancelled !== true &&
    held.later.defer(held.live, end)
  ) {
    return
  }

  yield* held.live.end(end)
}

/** A handler that failed BETWEEN frames: its failure ends a root `WS {route}` span of its own. */
function* sessionFailure(
  input: Helpers.SocketInput,
  session: Helpers.SocketSession,
  failure: Result.Failure<unknown>,
): Operation<void> {
  const live = yield* openFrame(input, session, { frame: null })

  yield* live.end({ failure })
}

/**
 * The first-frame authorization refused the session (4401): the auth frame's span (`live`, the
 * one the authorizer ran in) ENDS with the verdict — it settles like any failed span, classified
 * by `statusOf`: ONE exception at its origin (a span the authorizer opened, else this one), WARN
 * with the span unset for a refusal (4xx), ERROR for an authorizer that crashed (5xx).
 */
function* refuse(
  live: TraceDef.LiveSpan,
  session: Helpers.SocketSession,
  failure: Result.Failure<unknown>,
): Operation<void> {
  live.setAttribute('ozaco.ws.close.code', session.code)

  yield* live.end({ failure })
}

/** The session ended: one INFO line (Logger) with its totals, correlated to the upgrade span. */
function* closed(input: Helpers.SocketInput, session: Helpers.SocketSession): Operation<void> {
  const data: Record<string, unknown> = {
    'http.route': input.route.path,
    'ozaco.ws.session.id': session.id,
    'ozaco.ws.messages.received': session.received,
    'ozaco.ws.messages.sent': session.sent,
    'ozaco.ws.session.duration': (Date.now() - session.openedAt) / 1000,
  }

  if (session.code !== null) {
    data['ozaco.ws.close.code'] = session.code
  }

  if (session.reason) {
    data['ozaco.ws.close.reason'] = session.reason
  }

  const log = () => edgeLog('info', 'socket closed', data)

  yield* input.upgrade ? Trace.actions.passThrough(input.upgrade, log) : log()
}

/**
 * Drive one accepted socket: inbound frames (JSON text) feed a queue the handler consumes as a
 * Flow; `send` encodes values as JSON text; the handler runs in its own scope that ends with the
 * socket (a close from either side halts it).
 *
 * Telemetry (design §6.2): no session span — every inbound frame the handler pulls (except
 * `auth` / `ping` / `pong`) is a ROOT span `WS {route}` from its receipt to the handler's next
 * pull (and the tick the work it started gets, `release`), linking the upgrade span — whose
 * `ozaco.ws.session.id` (`sessionId`, decided at the upgrade) every frame span carries too; an
 * outbound frame is an `ws.send` event on the ACTIVE
 * span (only counted without one); a malformed frame (`receives`) is dropped with an
 * `ws.reject` event + its failure (WARN) on its span; the close is one Logger INFO line.
 *
 * A DEFERRED handshake (an `authorize` route reached without an authorization header) settles
 * here: the first frame within a short grace either carries `{ t: 'auth', token }` or the
 * route authorizes token-less (open resources); a failing verdict (its causes kept, the
 * first-frame cause appended) is recorded (WARN) and closes the socket with 4401 before the
 * handler ever runs.
 */
export function* driveSocket(input: Helpers.SocketInput, sessionId: string): Operation<void> {
  const session: Helpers.SocketSession = {
    id: sessionId,
    openedAt: Date.now(),
    received: 0,
    sent: 0,
    code: null,
    reason: '',
  }

  try {
    yield* serve(input, session)
  } finally {
    yield* closed(input, session)
  }
}

function* serve(input: Helpers.SocketInput, session: Helpers.SocketSession): Operation<void> {
  const { kernel, route, raw } = input
  const inbound = createQueue<Helpers.InboundFrame, void>()
  // released frame spans end a tick after the handler moved on (`release`)
  const later = laterIn(yield* useScope())

  raw.onMessage(data => {
    const text = typeof data === 'string' ? data : decoder.decode(data)
    let value: unknown

    try {
      value = JSON.parse(text)
    } catch {
      value = text
    }

    session.received += 1
    inbound.add({
      value,
      text,
      size: typeof data === 'string' ? utf8Length(data) : data.byteLength,
      at: performance.now(),
    })
  })

  raw.onClose((code, reason) => {
    session.code ??= code
    session.reason ||= reason
    inbound.close(undefined)
  })

  // --- deferred first-frame auth ------------------------------------------------------------

  let principal: unknown = input.auth.kind === 'settled' ? input.auth.principal : undefined
  // a non-auth first frame consumed while waiting is handed to the handler afterwards
  let pending: Helpers.InboundFrame | null = null

  if (input.auth.kind === 'deferred' && route.authorize) {
    const first = yield* race([
      (function* (): Operation<IteratorResult<Helpers.InboundFrame, void> | 'grace'> {
        yield* sleep(SOCKET_AUTH_GRACE_MS)

        return 'grace'
      })(),
      (function* (): Operation<IteratorResult<Helpers.InboundFrame, void> | 'grace'> {
        return yield* inbound.next()
      })(),
    ])

    const frame = first === 'grace' || first.done ? null : first.value
    const token = frame ? (authFrameOf(frame.value) ?? undefined) : undefined
    // the verdict runs INSIDE the auth frame's span — what the authorizer does (its spans, its
    // failure) nests there — kept only when it refuses (an auth frame is no trace of its own)
    const live = yield* openFrame(input, session, { frame, record: 'errors' })
    const verdict = yield* live.run(() => attempt(() => route.authorize!(input.request, token)))

    if (isFailure(verdict)) {
      // the verdict's own causes stay — the first-frame cause is appended, never replaces them
      if (!verdict.causes.includes(AuthCauses.FirstFrame)) {
        appendCauses(verdict, AuthCauses.FirstFrame)
      }

      session.code = AUTH_CLOSE_CODE
      yield* refuse(live, session, verdict)
      raw.close(AUTH_CLOSE_CODE, 'authorization required')

      return
    }

    yield* live.end()
    principal = verdict.value ?? undefined

    // the frame that opened the session but was NOT an auth frame still belongs to the handler
    if (frame && authFrameOf(frame.value) === null) {
      pending = frame
    }

    if (first !== 'grace' && first.done) {
      return
    }
  }

  const base = yield* contextFor(
    kernel,
    {
      name: route.path,
      service: route.service,
      requestId: input.requestId,
      origin: 'external',
      headers: input.headers,
      signal: input.signal,
      auth: principal,
    },
    input.actions,
  )

  // the frame span the handler works under right now (ended at its next pull)
  let active: Helpers.HeldFrame | null = null

  // one ctx for the session, its ids those of the FRAME being handled (`''` between frames)
  const frameTrace = (): ServerDef.Trace =>
    active
      ? traceOf(active.live, input.requestId)
      : { traceId: '', spanId: '', requestId: input.requestId }

  const ctx: ServerDef.Ctx = Object.defineProperties(
    { ...base },
    {
      spanId: { enumerable: true, get: () => frameTrace().spanId },
      trace: { enumerable: true, get: frameTrace },
    },
  )

  /** A malformed frame (`receives`): dropped, but never silently — an `ws.reject` event
   * and its failure (WARN) on the frame's span. */
  function* reject(live: TraceDef.LiveSpan, failure: Result.Failure<unknown>): Operation<void> {
    yield* live.run(function* (handle) {
      handle.setAttribute('error.type', tagOf(failure))
      handle.addEvent('ws.reject', { 'error.type': tagOf(failure) })
      yield* handle.recordFailure(failure, { severity: CLIENT_SEVERITY, handled: true })
    })
    yield* live.end()
  }

  /** The next frame the handler gets — its span opened (and held) unless the frame is quiet. */
  function* next(): Operation<IteratorResult<unknown, void>> {
    if (active) {
      const held = active

      active = null
      yield* release(held)
    }

    for (;;) {
      const step: IteratorResult<Helpers.InboundFrame, void> = pending
        ? { done: false, value: pending }
        : yield* inbound.next()

      pending = null

      if (step.done) {
        return { done: true, value: undefined }
      }

      const frame = step.value

      // an in-band auth frame is the transport's, never the handler's
      if (authFrameOf(frame.value) !== null) {
        continue
      }

      const value = yield* payloadOf(frame.value)
      const type = typeOf(frame.value)
      const quiet = type !== undefined && QUIET.has(type)
      const live = quiet ? null : yield* openFrame(input, session, { frame })

      if (route.receives) {
        const schema = route.receives
        const check = () => attempt(() => validate(schema, value, `frame of ${route.path}`))
        const checked = live ? yield* live.run(check) : yield* check()

        // a malformed frame from ONE client must not kill the session: drop it, keep reading
        if (isFailure(checked)) {
          if (live) {
            yield* reject(live, checked)
          }

          continue
        }

        if (live) {
          active = yield* hold(input, { live, frame, later })
        }

        return { done: false, value: checked.value }
      }

      if (live) {
        active = yield* hold(input, { live, frame, later })
      }

      return { done: false, value }
    }
  }

  const socket: EdgeDef.Socket = {
    id: session.id,
    params: input.params,
    headers: input.headers,
    url: input.url,
    ctx,

    messages: {
      *[Symbol.iterator]() {
        return { next }
      },
    },
    *send(value) {
      const text = JSON.stringify(value)

      raw.send(text)
      session.sent += 1

      // an event on the ACTIVE span (the frame being answered, a span the handler opened); a
      // push outside any span is only counted
      const handle = yield* Trace.actions.current()

      if (handle.recording) {
        handle.addEvent('ws.send', {
          'ozaco.ws.message.type': typeOf(value),
          'ozaco.ws.message.size': utf8Length(text),
        })
      }
    },
    *close(code, reason) {
      session.code ??= code ?? null
      raw.close(code, reason)
    },
  }

  // the socket ctx is ambient for the handler too — runnable ops (`crud.list`) work here
  // exactly as they do inside a dispatch
  let finished = false

  try {
    const outcome = yield* attempt(() =>
      scoped(() => CtxRef.with(ctx, () => route.handler(socket))),
    )

    finished = true

    const held = active as Helpers.HeldFrame | null

    active = null

    if (!isFailure(outcome)) {
      // the handler is done — so is every task it started: nothing left to wait for
      if (held) {
        yield* release(held, { now: true })
      }
    } else if (held) {
      // the handler failed: on the frame it was working on, else on a session span of its own
      yield* release(held, { failure: outcome })
    } else {
      yield* sessionFailure(input, session, outcome)
    }
  } finally {
    if (!finished && active) {
      yield* release(active, { cancelled: true })
    }

    // the frames released last still wait for their tick: they end with the socket
    yield* later.flush()
  }
}
