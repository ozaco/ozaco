import { useDatabase } from 'db:realtime'
import type { GatewayDef } from 'server:core'
import { Gateway, useRequest } from 'server:core'
import { attempt, operation } from 'std:effect'
import type { Operation } from 'std:effect'
import { isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'
import type { ZodType } from 'zod'

import type { FnModule, RealtimeTransport, WizardActionDef } from '../types'
import { matchesWatch, resolveWatchTarget } from '../utils/realtime'
import type { WatchTarget } from '../utils/realtime'

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

/** Snapshot reactivity (default for queries): re-run the handler on any watched write and send the
 * whole result, deduplicated by JSON so an unrelated write emits nothing. */
const pumpSnapshot = (deps: PumpDeps): (() => Operation<void>) =>
  function* () {
    const { action, target } = deps
    const db = yield* useDatabase()
    const first = yield* action.handler(target.args)
    let previous = yield* JsonCodec.actions.stringify(first)
    yield* emit(deps, first)

    const feed = yield* db.changes
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

    const feed = yield* db.changes
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

const websocketHandlers = (module: FnModule): GatewayDef.ListenHandlers => ({
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
      const frame: Frame = value =>
        target.subId === undefined ? { result: value } : { id: target.subId, result: value }
      yield* socket.spawn(pumpFor({ action, socket, target, frame, emits: emitsOf(action) }))
    }),
  },
})

const sseHandlers = (module: FnModule): GatewayDef.ListenHandlers => ({
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
    const frame: Frame = value => ({ result: value })
    yield* socket.spawn(pumpFor({ action, socket, target, frame, emits: emitsOf(action) }))
  }),
})

/** Mount the resource-local realtime channel (`<basePath>/_realtime`) — WS `watch` frames or SSE
 * `?fn=&args=`, both driving the per-action pump. */
export const mountResourceRealtime = operation(function* (
  basePath: string,
  module: FnModule,
  transport: RealtimeTransport,
) {
  const path = `${basePath}/_realtime`
  yield* transport === 'sse'
    ? Gateway.actions.sse(path, sseHandlers(module))
    : Gateway.actions.listen(path, websocketHandlers(module))
})

/** Mount a dedicated SSE endpoint for a `stream` action that declared a `rest` route (e.g. a live
 * metrics / vitals / log-tail feed). Each connection drains a fresh subscription; the raw value is
 * sent as the SSE `data` payload. */
export const mountStreamRoute = operation(function* (
  basePath: string,
  name: string,
  def: WizardActionDef,
) {
  const path = `${basePath}${def.rest?.path ?? `/${name}`}`
  yield* Gateway.actions.sse(path, {
    open: operation(function* (socket: GatewayDef.Socket) {
      const request = yield* useRequest()
      const rawArgs = request.url.searchParams.get('args')
      const decoded = rawArgs ? yield* attempt(JsonCodec.actions.parse(rawArgs)) : undefined
      const args = decoded && isSuccess(decoded) ? decoded.value : {}
      yield* socket.spawn(
        pumpFor({
          action: def,
          socket,
          target: { subId: undefined, name, args, resourceVersion: undefined },
          frame: wrapped,
          emits: emitsOf(def),
        }),
      )
    }),
  })
})
