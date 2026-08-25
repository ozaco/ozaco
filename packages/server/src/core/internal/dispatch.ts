// oxlint-disable import/exports-last
import { DbClient, Kv } from 'db:core'
import type { Operation } from 'std:effect'
import { attempt, ensure, fork, race, sleep, withResolvers } from 'std:effect'
import type { Result } from 'std:result'
import { appendCauses, fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { CtxRef } from '../context'
import { ServerErrors } from '../errors'
import type { Helpers } from '../types/helpers'
import type { ServerDef } from '../types/server'
import type { ServiceDef } from '../types/service'
import { breadcrumb } from '../utils/failure'
import { isSchema } from '../utils/service'
import { brandStream, isBranded, isStreamDecl, stream } from '../utils/stream'
import { childTrace, report, withSpan } from '../utils/trace'
import { validate } from '../utils/validation'

import { actionKey } from './registry'

/** A database/cache handle that fails `server.configuration` on first use when nothing is
 * installed — so `ctx.db` exists on every dispatch and the error names the fix. */
const missing = <T extends object>(what: string, hint: string): T =>
  new Proxy({} as T, {
    get: (_target, key) =>
      typeof key === 'symbol'
        ? undefined
        : () => fail(ServerErrors.Configuration, `${what} is not installed — ${hint}`),
  })

/** Build the handler context for one dispatch. */
interface ContextInput {
  readonly kernel: ServerDef.Context
  readonly call: ServerDef.Call
  readonly meta: ServiceDef.Meta
  readonly actions: Pick<ServerDef.Actions, 'call' | 'emit'>
}

function* contextOf({ kernel, call, meta, actions }: ContextInput): Operation<ServerDef.Ctx> {
  const db =
    (yield* DbClient.context.get()) ??
    missing('the database', 'install DbClient before createServer (or pass it as a plugin)')
  const cache = kernel.kv
    ? Kv.actions
    : missing<AnyType>('the Kv store', 'install MemoryKv/RedisKv before createServer')
  const { trace } = call

  const log = (level: 'debug' | 'info' | 'warn' | 'error') =>
    function* (msg: string, data?: Record<string, unknown>) {
      yield* report(kernel, {
        t: 'log',
        row: {
          request_id: trace.request_id,
          span_id: trace.span_id,
          level,
          msg,
          data: data ?? null,
          ts: Date.now(),
        },
      })
    }

  return {
    requestId: trace.request_id,
    spanId: trace.span_id,
    trace,
    service: call.service,
    action: call.action,
    meta,
    db: db as AnyType,
    cache: cache as AnyType,
    auth: undefined,
    log: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    signal: call.signal,
    headers: call.headers,
    call: actions.call,
    emit: actions.emit,
    *span(name, body, attrs) {
      return yield* withSpan(
        { kernel, trace: yield* childTrace(trace), kind: 'custom', name, attrs },
        body,
      )
    },
  }
}

export const isDeferred = (value: unknown): value is Helpers.DeferredStream =>
  typeof value === 'object' &&
  value !== null &&
  (value as Helpers.DeferredStream)._t === 'deferred-stream'

/** Turn a deferred stream into a branded platform stream in the CALLING scope. */
export function* materialize(value: unknown): Operation<unknown> {
  return isDeferred(value) ? yield* stream.of(value.flow, value.brand) : value
}

/** A handler context outside a dispatch (socket routes, raw routes): same db/cache/log/call
 * surface, bound to the given trace. */
export function* contextFor(
  kernel: ServerDef.Context,
  call: Pick<ServerDef.Call, 'trace' | 'headers' | 'signal'> & { readonly name: string },
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
    route: { method: 'GET', path: call.name },
    onDisconnect: 'cancel',
    outcome: false,
    errors: {},
    tags: [],
    options: {},
  }

  return yield* contextOf({
    kernel,
    call: {
      cid: call.trace.span_id,
      service: '$edge',
      action: call.name,
      input: undefined,
      trace: call.trace,
      headers: call.headers,
      deadline: Number.POSITIVE_INFINITY,
      idempotencyKey: undefined,
      transport: 'edge',
      signal: call.signal,
    },
    meta,
    actions,
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
      return yield* validate(meta.output, result, `output of ${call.service}.${call.action}`)
    }

    if (meta.output && isStreamDecl(meta.output)) {
      // a handler may return a Flow or an already-branded stream: the edge and the carriers
      // need the brand, so normalize here
      if (isBranded(result)) {
        return result
      }

      if (result instanceof ReadableStream) {
        return brandStream(result, meta.output.brand)
      }

      if (result && typeof result === 'object' && Symbol.iterator in result) {
        // materialized by whoever consumes it (see `materialize`): the dispatch task ends here
        const deferred: Helpers.DeferredStream = {
          _t: 'deferred-stream',
          flow: result as AnyType,
          brand: meta.output.brand,
        }

        return deferred
      }

      return yield* fail(
        ServerErrors.Internal,
        `${call.service}.${call.action} declared a stream output but returned a plain value`,
      )
    }

    void kernel

    return result
  }

/** Wrap the handler with every plugin's `dispatch` hook, outermost = first installed. */
const chainOf = (kernel: ServerDef.Context, def: ServiceDef.Action): ServerDef.Dispatch => {
  let next: ServerDef.Dispatch = invoke(kernel, def)

  for (const hooks of kernel.hooks.toReversed()) {
    const around = hooks.dispatch

    if (around) {
      const inner = next
      next = (call, ctx) => around(call, ctx, inner)
    }
  }

  return next
}

/**
 * Run one dispatch on this node end to end: resolve the action, build the context, run the
 * plugin chain around the handler inside a `dispatch` span, and fold the outcome into a Result
 * (carriers and the edge encode failures, they never catch). The deadline and the caller's
 * signal abort the handler's `ctx.signal`.
 */
export function* runDispatch(
  kernel: ServerDef.Context,
  call: ServerDef.Call,
  actions: Pick<ServerDef.Actions, 'call' | 'emit'>,
): Operation<Result<unknown>> {
  const def = kernel.registry.actions.get(actionKey(call.service, call.action))

  if (!def) {
    return fail(ServerErrors.NotFound, `no action "${call.service}.${call.action}" here`) as AnyType
  }

  const ctx = yield* contextOf({ kernel, call, meta: def.meta, actions })
  const chain = chainOf(kernel, def)
  kernel.inflight += 1
  let outcome: Result<unknown>

  try {
    outcome = yield* attempt(() =>
      withSpan(
        {
          kernel,
          trace: call.trace,
          kind: 'dispatch',
          name: `${call.service}.${call.action}`,
          actionId: `${call.service}.${call.action}`,
          transport: call.transport,
        },
        () => chain(call, ctx),
      ),
    )
  } finally {
    kernel.inflight -= 1
  }

  if (isFailure(outcome)) {
    return appendCauses(
      outcome,
      breadcrumb(`action:${call.service}.${call.action}`, {
        requestId: call.trace.request_id,
        spanId: call.trace.span_id,
      }),
    ) as AnyType
  }

  return outcome
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
  const cid = local.trace.span_id

  const call: ServerDef.Call = {
    cid,
    service: local.service,
    action: local.action,
    input: local.input,
    trace: local.trace,
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

  // the dispatch is a task of the caller's scope: racing its RESULT (not the task) lets a
  // detached handler outlive the caller's patience and record its outcome
  const task = yield* fork(function* () {
    const outcome = yield* runDispatch(kernel, call, local.actions)
    if (state.timedOut) {
      yield* local.actions.outcome({
        cid,
        state: isFailure(outcome) ? 'failed' : 'fulfilled',
        service_id: kernel.serviceId,
        action_id: `${call.service}.${call.action}`,
        error: isFailure(outcome) ? String(outcome.error) : null,
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
      breadcrumb('local', { requestId: local.trace.request_id, spanId: local.trace.span_id }),
    )
  }

  if (isFailure(winner.outcome)) {
    return yield* winner.outcome
  }

  return yield* materialize(winner.outcome.value)
}
