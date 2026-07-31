import { useDatabase } from 'db:realtime'
import type { GatewayDef } from 'server:core'
import {
  Broker,
  CoreErrors,
  defineAction,
  Gateway,
  socketAction,
  stream as streamChannel,
  useRequest,
} from 'server:core'
import {
  attempt,
  createStreamQueue,
  ensure,
  mapError,
  operation,
  useContext,
  validate,
} from 'std:effect'
import type { Operation, Task } from 'std:effect'
import { fail, isSuccess } from 'std:result'
import type { Result } from 'std:result'
import type { AnyType } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'
import type { ZodType } from 'zod'
import { z } from 'zod'

import { assertAccess } from '../internal/access'
import { resolveActionArgs } from '../internal/args'
import { matchesWatch, resolveWatchTarget } from '../internal/realtime'
import type { WatchTarget } from '../internal/realtime'
import type { FnModule, WizardActionDef } from '../types'

/** Wrap a payload for the wire. Over `_realtime` it is `{ id?, result }` (matched by the client's
 * subscription id); over a dedicated SSE stream route it is the raw value. */
type Frame = (value: AnyType) => AnyType

/** All a pump needs of its destination. A `session` socket handle satisfies it directly; an SSE
 * feed satisfies it with the stream queue the action hands back — so one pump serves both edges. */
interface Sink {
  send(message: unknown): Operation<void>
}

interface PumpDeps {
  readonly action: WizardActionDef
  readonly socket: Sink
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

/** The frame shape the client matches subscriptions by: `{ id, result }`, or bare `{ result }` when
 * the subscription carried no id (SSE, single-watch sockets). */
const frameFor = (target: WatchTarget): Frame =>
  target.subId === undefined
    ? value => ({ result: value })
    : value => ({ id: target.subId, result: value })

/** Read a watch target out of an SSE request's query string (`?fn=&args=&resourceVersion=`). Path
 * params the route matched (`/calls/:id/stream` → `{ id }`) merge OVER the `?args=` envelope: the
 * route's own address is authoritative, and a dedicated stream route works without any `?args=`. */
const targetFromQuery = operation(function* (name?: string) {
  const request = yield* useRequest()
  const fn = name ?? request.url.searchParams.get('fn')
  const rawArgs = request.url.searchParams.get('args')
  const resourceVersion = request.url.searchParams.get('resourceVersion') ?? undefined
  const decoded = rawArgs ? yield* attempt(JsonCodec.actions.parse(rawArgs)) : undefined
  const parsed = decoded && isSuccess(decoded) ? decoded.value : {}
  const base = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  const args = { ...(base as Record<string, unknown>), ...request.params }
  return resolveWatchTarget({ fn, args, resourceVersion })
})

/**
 * Run one pump into a fresh stream and hand that stream back as the action's result.
 *
 * SSE is the easy half: a GET is already ONE dispatch, so there is nothing to keep sticky — the
 * node that owns the resource answers, streams, and the gateway frames it (`sse: true` on the
 * route). The pump still runs on the broker's install scope, because the dispatch scope closes the
 * moment this returns; the `ensure` on the dispatch is what reaps it when the client hangs up.
 */
const streamOf = operation(function* (deps: Omit<PumpDeps, 'socket'>) {
  const out = createStreamQueue<unknown, void>()
  const sink: Sink = {
    send: operation(function* (message: unknown) {
      out.add(message)
    }),
  }

  // KEEP the task — discarding it would leave a pump nothing can halt, so a client that hangs up
  // would leave the owner re-running its query on every write, forever.
  const broker = yield* useContext(Broker)
  const pump = broker.scope.run(function* () {
    yield* ensure(function* () {
      out.close()
    })
    yield* pumpFor({ ...deps, socket: sink })()
  })

  // the consumer stopped reading (client gone, gateway gone, stream cancelled) → stop producing
  yield* ensure(function* () {
    yield* attempt(() => pump.halt())
  })

  return out
})

/**
 * The `_realtime` channel as a socket on the resource itself.
 *
 * `socketAction` owns everything a live connection needs — the outbound stream, a scope that
 * outlives the dispatch, teardown on either ending, `on[event]` routing — so all that is left here
 * is the two events wizard actually speaks. Being an action rather than a gateway-local endpoint is
 * what lets the gateway forward the whole socket to whichever pod owns the resource, where the
 * database is.
 */
export const realtimeAction = (namespace: string, module: FnModule) => {
  // per connection, keyed by socket: `unwatch` must stop ONE feed, not the socket
  const feeds = new Map<string, Map<string, Task<void>>>()
  let seq = 0

  const pumpsOf = (socket: GatewayDef.Socket) => {
    const existing = feeds.get(socket.id)
    if (existing) {
      return existing
    }
    const created = new Map<string, Task<void>>()
    feeds.set(socket.id, created)
    return created
  }

  /** Stop one subscription, tolerating a pump that already finished on its own. */
  const stop = operation(function* (socket: GatewayDef.Socket, key: string) {
    const pumps = pumpsOf(socket)
    const task = pumps.get(key)
    pumps.delete(key)
    if (task) {
      yield* attempt(() => task.halt())
    }
  })

  // `.wizard` is the metadata lane Docs reads (resource-action.ts attaches it to every REST-routed
  // fn); without it the channel reaches OpenAPI with no realtime annotation and codegen cannot pick
  // the namespace transport.
  return Object.assign(
    socketAction(
      { title: `${namespace}._realtime`, path: '/_realtime' },
      {
        on: {
          watch: operation(function* (socket: GatewayDef.Socket, message: AnyType) {
            const target = resolveWatchTarget(message, message?.id)
            const action = target ? module[target.name] : undefined
            if (!target || !action) {
              return
            }

            // a rejected subscription (bad args, denied access) must not tear down the connection
            const outcome = yield* attempt(function* () {
              // the SAME access + input validation as the REST path, before any data flows; the
              // handler runs inside the connection's request context, so a guard reading `useAuth()`
              // sees the principal that opened the socket
              const args = yield* authorizeWatch(namespace, action, target)
              const key = target.subId ?? `#${(seq += 1)}`
              yield* stop(socket, key)
              pumpsOf(socket).set(
                key,
                yield* socket.spawn(
                  pumpFor({
                    action,
                    socket,
                    target: { ...target, args },
                    frame: frameFor(target),
                    emits: emitsOf(action),
                  }),
                ),
              )
            })

            if (!isSuccess(outcome)) {
              yield* socket.send({
                ...(message?.id === undefined ? {} : { id: message.id }),
                error: outcome.error,
              })
            }
          }),

          unwatch: operation(function* (socket: GatewayDef.Socket, message: AnyType) {
            yield* stop(socket, String(message?.id ?? ''))
          }),
        },

        // `socketAction` already halts every spawned pump; this just drops the bookkeeping
        close: operation(function* (socket: GatewayDef.Socket) {
          feeds.delete(socket.id)
        }),
      },
    ),
    { wizard: { realtime: 'websocket' as const } },
  )
}

/**
 * The SSE flavour of `_realtime`, as an action rather than a gateway-local endpoint — same
 * reasoning as the WebSocket one: a route can be served by a pod that holds no code, a
 * `Gateway.actions.sse` handler cannot. The subscription is chosen by `?fn=&args=`, one per
 * connection.
 */
export const sseRealtimeAction = (namespace: string, module: FnModule) =>
  Object.assign(
    defineAction(
      {
        title: `${namespace}._realtime`,
        // the output DECLARATION is what routes the answer through the streaming sink — the wire is
        // declaration-driven, so an undeclared lane would be JSON-stringified as a value
        output: streamChannel(z.unknown()),
        settings: [Gateway.actions.rest({ method: 'GET', path: '/_realtime', sse: true })],
      },
      function* () {
        const target = yield* targetFromQuery()
        const action = target ? module[target.name] : undefined

        if (!target || !action) {
          return yield* fail(
            CoreErrors.NotFound,
            `${namespace}._realtime: unknown or missing \`fn\``,
          )
        }

        // same access + input validation as the REST path, before a single row flows
        const args = yield* authorizeWatch(namespace, action, target)
        // `_realtime` always wraps (the client reads `.result`); only a dedicated stream route is raw
        return yield* streamOf({
          action,
          target: { ...target, args },
          frame: frameFor(target),
          emits: emitsOf(action),
        })
      },
    ),
    // same `.wizard` lane as the WS flavour — Docs annotates the channel, codegen picks `sse`
    { wizard: { realtime: 'sse' as const } },
  )

/**
 * A dedicated SSE endpoint for a `stream` action that declared a `rest` route (a live metrics /
 * vitals / log-tail feed). Each connection drains a fresh subscription and the raw value becomes
 * the `data` payload.
 */
export const streamRouteAction = (namespace: string, name: string, def: WizardActionDef) =>
  Object.assign(
    defineAction(
      {
        title: `${namespace}.${name}`,
        output: streamChannel(z.unknown()),
        settings: [
          Gateway.actions.rest({ method: 'GET', path: def.rest?.path ?? `/${name}`, sse: true }),
        ],
      },
      function* () {
        const target = (yield* targetFromQuery(name)) as WatchTarget | undefined

        if (!target) {
          return yield* fail(CoreErrors.NotFound, `${namespace}.${name}: no stream target`)
        }

        const args = yield* authorizeWatch(namespace, def, target)
        return yield* streamOf({
          action: def,
          target: { ...target, args },
          frame: wrapped,
          emits: emitsOf(def),
        })
      },
    ),
    // the def knows its kind and tick schema; without this lane the route reached OpenAPI as a
    // plain GET and codegen typed the SSE feed as a one-shot `query`
    {
      wizard: {
        kind: 'stream' as const,
        ...(emitsOf(def) ? { emits: emitsOf(def) } : {}),
      },
    },
  )
