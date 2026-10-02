// oxlint-disable import/exports-last
import { withBusMeta } from 'db:core'
import type { Flow, Operation } from 'std:effect'
import { attempt, ensure, flowOf, fork, race, sleep, until, withResolvers } from 'std:effect'
import type { Result } from 'std:result'
import { appendCauses, fail, isFailure, isResult } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import { ActiveRequest, CtxRef, RequestRef } from '../context'
import { ServerErrors } from '../errors'
import type { Helpers } from '../types/helpers'
import type { ServerDef } from '../types/server'
import type { ServiceDef } from '../types/service'
import { breadcrumb, statusOf, tagOf } from '../utils/failure'
import { isSchema } from '../utils/service'
import { brandStream, isBranded, isStreamDecl, stream } from '../utils/stream'
import { traceOf, withDispatchSpan } from '../utils/trace'
import { validate } from '../utils/validation'

import { parseCall } from './call'
import { handlerLog } from './handler'
import { actionKey } from './registry'
import { noteAnswered, userSpanOf, withInbound } from './spans'
import { isDeferred } from './stream'

/** Everything a stream handler may answer with, as ONE Flow: a Flow passes through, an array
 * and an async iterable are pulled into one. Anything else is not a stream. */
const flowFrom = (value: unknown): Flow<unknown, unknown> | null => {
  if (Array.isArray(value)) {
    return flowOf(function* (emit) {
      for (const item of value) {
        yield* emit(item)
      }
    })
  }

  if (!value || typeof value !== 'object') {
    return null
  }

  if (Symbol.asyncIterator in value) {
    return flowOf(function* (emit) {
      const iterator = (value as AsyncIterable<unknown>)[Symbol.asyncIterator]()

      for (;;) {
        const step = yield* until(iterator.next())

        if (step.done) {
          return
        }

        yield* emit(step.value)
      }
    })
  }

  return Symbol.iterator in value ? (value as Flow<unknown, unknown>) : null
}

/**
 * The handler context of one dispatch — built INSIDE the dispatch span: `ctx.spanId` /
 * `ctx.trace` are that span's ids (`''` when nothing is traced and no inbound context arrived),
 * while `ctx.log` / `ctx.span` / `ctx.event` follow the span active at EACH call (a `ctx.log`
 * inside a `ctx.span` lands on that span).
 */
function* contextOf({
  kernel,
  call,
  meta,
  actions,
  auth,
}: Helpers.ContextInput): Operation<ServerDef.Ctx> {
  const trace = traceOf(yield* Trace.actions.current(), call.requestId)

  const log = (level: keyof ServerDef.Log) => (msg: string, data?: Record<string, unknown>) =>
    handlerLog(level, msg, data)

  return {
    requestId: call.requestId,
    spanId: trace.spanId,
    trace,
    service: call.service,
    action: call.action,
    meta,
    auth: auth as ServerDef.Ctx['auth'],
    log: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    signal: call.signal,
    headers: call.headers,

    // `inherit: true` carries THIS dispatch's authorization into the nested call — the intent
    // stays visible at the call site; an explicit `meta.authorization` still wins. Both call
    // spellings go through the ONE parser (`parseCall`) and forward ref-style.
    call: ((target: AnyType, ...rest: AnyType[]) => {
      const parsed = parseCall(target, rest)

      if (!parsed) {
        return (actions.call as AnyType)(target, ...rest)
      }

      const authorization = call.headers['authorization']
      const options =
        parsed.options?.inherit === true && authorization
          ? { ...parsed.options, meta: { authorization, ...parsed.options.meta } }
          : parsed.options

      return (actions.call as AnyType)(
        { service: parsed.service, action: parsed.action },
        parsed.input,
        options,
      )
    }) as ServerDef.Ctx['call'],
    emit: actions.emit,
    reply: reply => {
      call.reply?.(reply)
    },
    span: userSpanOf(kernel),
    event: (name, attributes, options) =>
      Trace.actions.event(name, attributes, { time: options?.time }),
  }
}

export { isDeferred } from './stream'

/** Turn a deferred stream into a branded platform stream in the CALLING scope. */
export function* materialize(value: unknown): Operation<unknown> {
  return isDeferred(value) ? yield* stream.of(value.flow, value.brand) : value
}

/** A handler context outside a dispatch (socket routes): the same log / call / span / event
 * surface; `ctx.spanId` / `ctx.trace` are the span ACTIVE when it is built (the per-frame span),
 * `ctx.service` the service that declared the socket (`$edge` for a route of the edge's own),
 * `ctx.action` the route. */
export function* contextFor(
  kernel: ServerDef.Context,
  input: Helpers.ContextForInput,
  actions: Pick<ServerDef.Actions, 'call' | 'emit'>,
): Operation<ServerDef.Ctx> {
  const meta: ServiceDef.Meta = {
    kind: 'action',
    title: undefined,
    description: undefined,
    input: null,
    output: null,
    inputPlane: 'none',
    outputPlane: 'none',
    route: { method: 'GET', path: input.name },
    onDisconnect: 'cancel',
    outcome: false,
    errors: {},
    tags: [],
    docs: null,
    status: null,
    headers: {},
    options: {},
  }

  return yield* contextOf({
    kernel,
    call: {
      cid: yield* Trace.actions.newSpanId(),
      service: input.service ?? '$edge',
      action: input.name,
      input: undefined,
      requestId: input.requestId,
      origin: input.origin,
      headers: input.headers,
      deadline: Number.POSITIVE_INFINITY,
      idempotencyKey: undefined,
      transport: 'edge',
      signal: input.signal,
    },
    meta,
    actions,
    auth: input.auth,
  })
}

/** The innermost step: validate the input, run the handler, validate/brand the output. */
const invoke = (kernel: ServerDef.Context, def: ServiceDef.Action) =>
  function* (call: ServerDef.Call, ctx: ServerDef.Ctx): Operation<unknown> {
    const { meta } = def
    let input = call.input

    if (meta.input && isSchema(meta.input)) {
      input = yield* validate(meta.input, input, `input of ${call.service}.${call.action}`)
    }

    // the handler runs as a task forked BEFORE the abort hook is registered: on a halt the hook
    // runs first (LIFO) and the handler's own `ensure`s then observe `ctx.signal.aborted`
    // (a raising child task would crash this scope: fold its outcome into a Result first)
    const task = yield* fork(() =>
      attempt(() => CtxRef.with(ctx, () => def.handler({ input: input as AnyType, ctx }))),
    )
    let settled = false

    yield* ensure(() => {
      if (!settled) {
        call.abort?.(ServerErrors.Cancelled)
      }
    })

    // an aborted signal (the caller left, a deadline fired) interrupts the handler too: halt it
    // in `cancel` mode so its ensures run with `ctx.signal.aborted`, let it finish in `detach`
    const aborted = withResolvers<void>('dispatch aborted')

    if (call.signal.aborted) {
      aborted.resolve(undefined)
    } else {
      call.signal.addEventListener('abort', () => aborted.resolve(undefined), { once: true })
    }

    const winner = yield* race([
      (function* () {
        return { outcome: yield* task }
      })(),
      (function* () {
        yield* aborted.operation

        return { gone: true as const }
      })(),
    ])

    if ('gone' in winner && meta.onDisconnect === 'cancel') {
      yield* task.halt()
      settled = true

      return yield* fail(ServerErrors.Cancelled, `${call.service}.${call.action} was cancelled`)
    }

    const outcome = 'outcome' in winner ? winner.outcome : yield* task

    settled = true

    if (isFailure(outcome)) {
      return yield* outcome
    }

    const result = outcome.value

    if (meta.output && isSchema(meta.output)) {
      const schema = meta.output
      const checked = yield* attempt(() =>
        validate(schema, result, `output of ${call.service}.${call.action}`),
      )

      // a handler answering outside its declared output is the SERVER's bug (500), never the
      // caller's (`server.validation` is a 400)
      if (isFailure(checked)) {
        return yield* fail(ServerErrors.Output, checked.message, checked)
      }

      return checked.value
    }

    if (meta.output && isStreamDecl(meta.output)) {
      // a handler may answer a stream output four ways — an already-branded stream, a platform
      // ReadableStream, a Flow (`flowOf(emit => …)`), or the plain shapes people reach for
      // first: an array and an async iterable. The edge and the carriers need the brand, so
      // everything is normalized here.
      if (isBranded(result)) {
        return result
      }

      if (result instanceof ReadableStream) {
        return brandStream(result, meta.output.brand)
      }

      const flow = flowFrom(result)

      if (flow) {
        // materialized by whoever consumes it (see `materialize`): the dispatch task ends here
        const deferred: Helpers.DeferredStream = {
          _t: 'deferred-stream',
          flow,
          brand: meta.output.brand,
        }

        return deferred
      }

      return yield* fail(
        ServerErrors.Internal,
        `${call.service}.${call.action} declared a stream output but returned a plain value — ` +
          `answer with an array, an async iterable, a Flow (flowOf), or a branded stream`,
      )
    }

    void kernel

    return result
  }

/** Wrap the handler with every plugin's `dispatch` hook, outermost = first installed. Every
 * hook's return is NORMALIZED: a plugin observing the chain with `attempt(() => next(...))`
 * returns a Result — the failure re-raises, the success unwraps — so the envelope behaves the
 * same on every carrier and never serializes into a reply as `{ value: ... }`. */
const chainOf = (kernel: ServerDef.Context, def: ServiceDef.Action): ServerDef.Dispatch => {
  let next: ServerDef.Dispatch = invoke(kernel, def)

  for (const hooks of kernel.hooks.toReversed()) {
    const around = hooks.dispatch

    if (around) {
      const inner = next

      next = function* (call, ctx) {
        const outcome = yield* around(call, ctx, inner)

        if (isFailure(outcome as AnyType)) {
          return yield* outcome as Result.Failure<unknown>
        }

        if (isResult(outcome as AnyType)) {
          return (outcome as Result.Success<unknown>).value
        }

        return outcome
      }
    }
  }

  return next
}

/** Run the chain with the dispatch span's context as the db bus meta while it records: every
 * write the handler makes ships its writer's `traceparent` / `tracestate` (`Change.Event.meta`),
 * so a change-feed consumer (cache invalidation, crud realtime) can link the write. */
function* writing<T>(handle: TraceDef.SpanHandle, body: () => Operation<T>): Operation<T> {
  if (!handle.recording) {
    return yield* body()
  }

  const carrier = yield* Trace.actions.inject()

  return yield* carrier.traceparent ? withBusMeta({ ...carrier }, body) : body()
}

/** The dispatch span's kind: received over a network carrier ⇒ SERVER; in-process (the edge, a
 * local call, the same-process `LocalCarrier`) ⇒ INTERNAL. */
const kindOf = (call: ServerDef.Call): 'internal' | 'server' =>
  call.transport === 'edge' || call.transport === 'local' ? 'internal' : 'server'

/**
 * Run one dispatch on this node end to end: resolve the action, open its span (INTERNAL
 * in-process, SERVER when received over a carrier — `call.parent` / the active span as parent),
 * build the context INSIDE it, run the plugin chain around the handler, and fold the outcome into
 * a Result (carriers and the edge encode failures, they never catch). `RequestRef` carries the
 * request for everything the handler does. The deadline and the caller's signal abort the
 * handler's `ctx.signal`. A failure gains the breadcrumb `action:<service>.<action>` with the
 * span it ran in and the request id (`span:<id> req:<id>`, a missing one left out) — the span id
 * is also written to `seen` once known, for a caller that times out first.
 */
export function* runDispatch(
  kernel: ServerDef.Context,
  call: ServerDef.Call,
  { actions, seen }: Helpers.DispatchWith,
): Operation<Result<unknown>> {
  const def = kernel.registry.actions.get(actionKey(call.service, call.action))

  if (!def) {
    return fail(ServerErrors.NotFound, `no action "${call.service}.${call.action}" here`) as AnyType
  }

  const chain = chainOf(kernel, def)
  const kind = kindOf(call)

  // the status the handler answered with (`ctx.reply`) — a carrier carries it back to the edge
  let replied: number | undefined
  const served: ServerDef.Call = call.reply
    ? {
        ...call,
        reply: reply => {
          replied = reply.status ?? replied
          call.reply?.(reply)
        },
      }
    : call

  kernel.inflight += 1

  // the id of the span the dispatch runs in (its own, else a passed-through context's) for the
  // breadcrumb — `''`, left out, when there is none
  let spanId = ''
  let result: Result<unknown>

  try {
    result = yield* attempt(() =>
      RequestRef.with(new ActiveRequest(call.requestId, call.origin), () =>
        withInbound(call.parent, () =>
          withDispatchSpan({ kernel, call, meta: def.meta, kind }, function* (handle) {
            spanId = traceOf(handle, call.requestId).spanId

            if (seen) {
              seen.spanId = spanId
            }

            // the span answering the call, for the edge that forwarded it (its `traceresponse`) —
            // this node's OWN span (tracing on here), never a caller's context passed through
            if (handle.valid && (yield* Trace.actions.isTracing())) {
              call.trace?.(handle.context)
            }

            const ctx = yield* contextOf({ kernel, call: served, meta: def.meta, actions })
            const outcome = yield* attempt(() => writing(handle, () => chain(served, ctx)))

            if (kind === 'server') {
              // the status the reply stands for: the failure's, else the handler's `ctx.reply`,
              // else the action's declared one (`jobs.submit` answers 202)
              handle.setAttribute(
                'rpc.response.status_code',
                String(
                  isFailure(outcome)
                    ? statusOf(outcome, def.meta)
                    : (replied ?? def.meta.status ?? 200),
                ),
              )

              // the carrier names this span in the failure's wire origin (the caller's
              // `remote: … span <id8>` cause, a forwarding edge's `traceresponse`) — recording
              // or not, like the success path's `call.trace`
              if (isFailure(outcome) && handle.valid) {
                noteAnswered(outcome, handle.context)
              }
            }

            if (isFailure(outcome)) {
              return yield* outcome
            }

            return outcome.value
          }),
        ),
      ),
    )
  } finally {
    kernel.inflight -= 1
  }

  if (isFailure(result)) {
    return appendCauses(
      result,
      breadcrumb(`action:${call.service}.${call.action}`, { requestId: call.requestId, spanId }),
    ) as AnyType
  }

  return result
}

/**
 * Dispatch locally with a deadline: the caller's abort is forwarded to the handler's signal;
 * a handler still running at the deadline is cancelled (`onDisconnect: 'cancel'`) or left to
 * finish on its own (`'detach'`) — either way the caller gets `timeout-pending`.
 */
export function* callLocal(local: Helpers.LocalCall): Operation<unknown> {
  const { kernel } = local
  const def = kernel.registry.actions.get(actionKey(local.service, local.action))

  if (!def) {
    return yield* fail(ServerErrors.NotFound, `no action "${local.service}.${local.action}"`)
  }

  const controller = new AbortController()
  const { cid } = local

  // parent omitted: the dispatch span nests under the caller's active span
  const call: ServerDef.Call = {
    cid,
    service: local.service,
    action: local.action,
    input: local.input,
    requestId: local.requestId,
    origin: local.origin,
    headers: local.headers,
    deadline: Date.now() + local.timeoutMs,
    idempotencyKey: local.idempotencyKey,
    transport: local.transport,
    signal: controller.signal,
    abort: reason => controller.abort(reason),
  }

  // the caller going away (its scope halts) aborts the handler too
  yield* ensure(() => {
    if (!controller.signal.aborted) {
      controller.abort(ServerErrors.Cancelled)
    }
  })

  const state = { timedOut: false }
  // the span the dispatch runs in, known once it opened — the `local` breadcrumb's
  const seen = { spanId: '' }

  // the dispatch is a task of the caller's scope: racing its RESULT (not the task) lets a
  // detached handler outlive the caller's patience and record its outcome
  const task = yield* fork(function* () {
    const outcome = yield* runDispatch(kernel, call, { actions: local.actions, seen })

    if (state.timedOut) {
      yield* local.actions.outcome({
        cid,
        state: isFailure(outcome) ? 'failed' : 'fulfilled',
        service_id: kernel.serviceId,
        action_id: `${call.service}.${call.action}`,
        error: isFailure(outcome) ? tagOf(outcome) : null,
        ts: Date.now(),
      })
    }

    return outcome
  })

  const winner = yield* race([
    (function* () {
      return { outcome: yield* task }
    })(),
    (function* () {
      yield* sleep(local.timeoutMs)

      return { timeout: true as const }
    })(),
  ])

  if ('timeout' in winner) {
    state.timedOut = true

    if (def.meta.onDisconnect === 'cancel') {
      controller.abort(ServerErrors.TimeoutPending)
      yield* task.halt()

      yield* local.actions.outcome({
        cid,
        state: 'cancelled',
        service_id: kernel.serviceId,
        action_id: `${call.service}.${call.action}`,
        error: ServerErrors.TimeoutPending,
        ts: Date.now(),
      })
    }

    return yield* fail(
      ServerErrors.TimeoutPending,
      `${local.service}.${local.action} did not reply within ${local.timeoutMs}ms`,
      breadcrumb('local', { requestId: local.requestId, spanId: seen.spanId }),
    )
  }

  if (isFailure(winner.outcome)) {
    return yield* winner.outcome
  }

  return yield* materialize(winner.outcome.value)
}
