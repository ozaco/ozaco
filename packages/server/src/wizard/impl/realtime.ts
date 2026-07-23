import { useDatabase } from 'db:realtime'
import type { GatewayDef } from 'server:core'
import { CoreErrors, Gateway, useRequest } from 'server:core'
import { attempt, mapError, operation, validate } from 'std:effect'
import type { Operation } from 'std:effect'
import { fail, isSuccess } from 'std:result'
import type { Result } from 'std:result'
import type { AnyType } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'
import type { ZodType } from 'zod'

import { assertAccess } from '../internal/access'
import { resolveActionArgs } from '../internal/args'
import { matchesWatch, resolveWatchTarget } from '../internal/realtime'
import type { WatchTarget } from '../internal/realtime'
import type { FnModule, RealtimeTransport, WizardActionDef } from '../types'

/** Wrap a payload for the wire. Over `_realtime` it is `{ id?, result }` (matched by the client's
 * subscription id); over a dedicated SSE stream route it is the raw value. */
type Frame = (value: AnyType) => AnyType

interface PumpDeps {
  readonly action: WizardActionDef
  readonly socket: GatewayDef.Socket
  readonly target: WatchTarget
  readonly frame: Frame
  /** The action's reactive payload validator (`emits`, falling back to `returns`); each outgoing frame
   * is validated against it so the wire never carries a contract-violating payload. */
  readonly emits: ZodType | undefined
}

/** Send one frame, re-validated against the action's `emits` contract. A frame that fails validation
 * is dropped (never pushed to the client) rather than corrupting the stream. */
const emit = operation(function* (deps: PumpDeps, value: AnyType) {
  if (deps.emits) {
    const parsed = deps.emits.safeParse(value)
    if (!parsed.success) {
      return
    }
    yield* deps.socket.send(deps.frame(parsed.data))
    return
  }
  yield* deps.socket.send(deps.frame(value))
})

/**
 * Authorize and validate a watch BEFORE its pump runs — the realtime equivalent of the guard the
 * REST action composes in `resource-action.ts` (input validation via `defineAction`, then
 * `assertAccess`). The client args are parsed through the action's own validator, so
 * `limit`/`sort`/`direction`/`cursor` and custom-action args are capped and checked identically to
 * the REST path (a realtime `list` can no longer request an unbounded window), and the action's
 * `access` guard is evaluated against them. Returns the parsed args the pump feeds the handler;
 * FAILS — refusing the subscription so no row data ever flows — when validation fails or access is
 * denied. The check runs once here at subscribe time (args + access decision are constant for the
 * subscription's lifetime); the pump then re-invokes the raw handler with these already-validated,
 * already-authorized args on each watched write.
 */
const authorizeWatch = operation(function* (
  namespace: string,
  action: WizardActionDef,
  target: WatchTarget,
) {
  const args = (yield* mapError(
    validate(resolveActionArgs(action), target.args),
    failure => fail(CoreErrors.Validation, failure.message, 'input') as Result.Failure<unknown>,
  )) as AnyType
  yield* assertAccess(action.access, { op: target.name, namespace, args })
  return args
})

/** Snapshot reactivity (default for queries): re-run the handler on any watched write and send the
 * whole result, deduplicated by JSON so an unrelated write emits nothing. */
const pumpSnapshot = (deps: PumpDeps): (() => Operation<void>) =>
  function* () {
    const { action, target } = deps
    const db = yield* useDatabase()
    // Subscribe FIRST, then take the snapshot: a write committed between the two must land in the
    // feed (createSignal only delivers events registered after subscription), so subscribing after
    // the snapshot would permanently miss it. The JSON dedup below absorbs the overlap: a change
    // already in the snapshot re-runs the handler to an identical result and emits nothing.
    const feed = yield* db.changes
    const first = yield* action.handler(target.args)
    let previous = yield* JsonCodec.actions.stringify(first)
    yield* emit(deps, first)

    for (;;) {
      const step = yield* feed.next()
      if (step.done) {
        break
      }
      if (!matchesWatch(action.watch, step.value.table)) {
        continue
      }
      const next = yield* action.handler(target.args)
      const key = yield* JsonCodec.actions.stringify(next)
      if (key === previous) {
        continue
      }
      previous = key
      yield* emit(deps, next)
    }
  }

/**
 * Delta reactivity (CRUD `list`): re-run the cursor-bound list query on each watched write and diff it
 * against the last window by `_id`/`_version` → per-row `added`/`modified`/`removed` events. Because
 * the query is bound to `target.args` (the active cursor + sort + filters), only changes affecting the
 * client's current page produce events. A `sync` frame carries the window once on subscribe; a `reset`
 * frame precedes it when the client's `resourceVersion` is stale (server regressed → 410 Gone). To
 * follow a new page the client re-subscribes with the new cursor.
 */
const pumpDelta = (deps: PumpDeps): (() => Operation<void>) =>
  function* () {
    const { action, target } = deps
    const db = yield* useDatabase()
    const versions = new Map<string, number>()

    // Subscribe FIRST, then take the snapshot (see pumpSnapshot): a write between the two must be
    // in the feed. The overlap is idempotent here — a change already reflected in the snapshot
    // re-runs the list to the same window, each row's `_version` already matches, so no delta fires.
    const feed = yield* db.changes
    const snapshot = (yield* action.handler(target.args)) as AnyType

    // 410-equivalent: the client's cursor is from a NEWER version than the server now has → the server
    // regressed (restart / version reset), so its cached window is gone. Tell it to refetch first.
    if (
      target.resourceVersion !== undefined &&
      Number(target.resourceVersion) > Number(snapshot.resourceVersion)
    ) {
      yield* emit(deps, { type: 'reset', resourceVersion: snapshot.resourceVersion })
    }

    for (const row of snapshot.data as AnyType[]) {
      versions.set(String(row._id), Number(row._version))
    }
    yield* emit(deps, {
      type: 'sync',
      resourceVersion: snapshot.resourceVersion,
      data: snapshot.data,
      pageInfo: snapshot.pageInfo,
    })

    for (;;) {
      const step = yield* feed.next()
      if (step.done) {
        break
      }
      if (!matchesWatch(action.watch, step.value.table)) {
        continue
      }
      const next = (yield* action.handler(target.args)) as AnyType
      const rv = next.resourceVersion as string
      // Every delta carries the CURRENT pageInfo so the client's cursors stay fresh as the window
      // mutates — a later "next/prev page" always re-subscribes with an accurate boundary.
      const pageInfo = next.pageInfo as AnyType
      const seen = new Set<string>()
      for (const row of next.data as AnyType[]) {
        const id = String(row._id)
        seen.add(id)
        const previous = versions.get(id)
        if (previous === undefined) {
          yield* emit(deps, { type: 'added', resourceVersion: rv, pageInfo, row })
        } else if (previous !== Number(row._version)) {
          yield* emit(deps, { type: 'modified', resourceVersion: rv, pageInfo, row })
        }
        versions.set(id, Number(row._version))
      }
      const removed = [...versions.keys()].filter(id => !seen.has(id))
      for (const id of removed) {
        versions.delete(id)
        yield* emit(deps, { type: 'removed', resourceVersion: rv, pageInfo, id })
      }
    }
  }

/** Producer-driven stream: drain the subscription the handler returns and forward each value. Bound
 * to the socket via `socket.spawn`, so it halts on disconnect. */
const pumpStream = (deps: PumpDeps): (() => Operation<void>) =>
  function* () {
    const subscription = (yield* deps.action.handler(deps.target.args)) as AnyType
    for (;;) {
      const step = yield* subscription.next()
      if (step.done) {
        break
      }
      yield* emit(deps, step.value)
    }
  }

/** Pick the pump for an action's kind + reactive mode. */
const pumpFor = (deps: PumpDeps): (() => Operation<void>) => {
  if (deps.action.kind === 'stream') {
    return pumpStream(deps)
  }
  if (deps.action.kind === 'query') {
    return deps.action.reactive === 'delta' ? pumpDelta(deps) : pumpSnapshot(deps)
  }
  return function* () {}
}

const wrapped: Frame = value => value

/** The reactive payload validator for an action: `emits` if declared, else the one-shot `returns`. */
const emitsOf = (action: WizardActionDef): ZodType | undefined => action.emits ?? action.returns

const websocketHandlers = (namespace: string, module: FnModule): GatewayDef.ListenHandlers => ({
  on: {
    watch: operation(function* (socket: GatewayDef.Socket, message: AnyType) {
      const target = resolveWatchTarget(message, message?.id)
      if (!target) {
        return
      }
      const action = module[target.name]
      if (!action) {
        return
      }
      // Enforce the SAME access + input validation as the REST path before any data flows. This runs
      // in the message-handler scope (which carries the connection's request/auth context), not the
      // spawned pump scope; the pump then re-runs the handler with these validated, authorized args.
      const args = yield* authorizeWatch(namespace, action, target)
      const frame: Frame = value =>
        target.subId === undefined ? { result: value } : { id: target.subId, result: value }
      yield* socket.spawn(
        pumpFor({ action, socket, target: { ...target, args }, frame, emits: emitsOf(action) }),
      )
    }),
    // TODO(M3): an `unwatch` handler for per-`subId` teardown does not fit the current model cleanly.
    // `socket.spawn` (gateway/shared/listen.ts) returns void — it keeps each pump's Task in the
    // socket's PRIVATE registry and exposes no handle to halt one subscription, and that file is
    // outside this module. A wizard-only fix would need a per-socket `Map<subId, stopSignal>` that
    // every pump loop races against (`race(feed.next(), stop)`), fired from `unwatch` and reaped in a
    // `close` handler — a bespoke cancellation channel deferred to keep this security change minimal.
  },
})

const sseHandlers = (namespace: string, module: FnModule): GatewayDef.ListenHandlers => ({
  open: operation(function* (socket: GatewayDef.Socket) {
    const request = yield* useRequest()
    const fn = request.url.searchParams.get('fn')
    const rawArgs = request.url.searchParams.get('args')
    const resourceVersion = request.url.searchParams.get('resourceVersion') ?? undefined
    const decoded = rawArgs ? yield* attempt(JsonCodec.actions.parse(rawArgs)) : undefined
    const args = decoded && isSuccess(decoded) ? decoded.value : {}
    const target = resolveWatchTarget({ fn, args, resourceVersion })
    if (!target) {
      return
    }
    const action = module[target.name]
    if (!action) {
      return
    }
    // Same access + input validation as the REST path (see websocketHandlers). The SSE `open` handler
    // runs inside its route action, so it carries the request's auth context for the guard.
    const validated = yield* authorizeWatch(namespace, action, target)
    const frame: Frame = value => ({ result: value })
    yield* socket.spawn(
      pumpFor({
        action,
        socket,
        target: { ...target, args: validated },
        frame,
        emits: emitsOf(action),
      }),
    )
  }),
})

/** Mount the resource-local realtime channel (`<basePath>/_realtime`) — WS `watch` frames or SSE
 * `?fn=&args=`, both driving the per-action pump. */
export const mountResourceRealtime = operation(function* (config: {
  basePath: string
  namespace: string
  module: FnModule
  transport: RealtimeTransport
}) {
  const { basePath, namespace, module, transport } = config
  const path = `${basePath}/_realtime`
  yield* transport === 'sse'
    ? Gateway.actions.sse(path, sseHandlers(namespace, module))
    : Gateway.actions.listen(path, websocketHandlers(namespace, module))
})

/** Mount a dedicated SSE endpoint for a `stream` action that declared a `rest` route (e.g. a live
 * metrics / vitals / log-tail feed). Each connection drains a fresh subscription; the raw value is
 * sent as the SSE `data` payload. */
export const mountStreamRoute = operation(function* (config: {
  basePath: string
  namespace: string
  name: string
  def: WizardActionDef
}) {
  const { basePath, namespace, name, def } = config
  const path = `${basePath}${def.rest?.path ?? `/${name}`}`
  yield* Gateway.actions.sse(path, {
    open: operation(function* (socket: GatewayDef.Socket) {
      const request = yield* useRequest()
      const rawArgs = request.url.searchParams.get('args')
      const decoded = rawArgs ? yield* attempt(JsonCodec.actions.parse(rawArgs)) : undefined
      const args = decoded && isSuccess(decoded) ? decoded.value : {}
      const target: WatchTarget = { subId: undefined, name, args, resourceVersion: undefined }
      // Same access + input validation as the REST path before the stream is drained (see
      // websocketHandlers). The `open` handler runs inside its route action, carrying auth context.
      const validated = yield* authorizeWatch(namespace, def, target)
      yield* socket.spawn(
        pumpFor({
          action: def,
          socket,
          target: { ...target, args: validated },
          frame: wrapped,
          emits: emitsOf(def),
        }),
      )
    }),
  })
})
