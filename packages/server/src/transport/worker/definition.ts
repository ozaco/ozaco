import type { TransportDispatch, TransportEvent } from 'server:core'
import { CoreErrors, Transport, useBroker } from 'server:core'
import { moduleLogger } from 'server:utils'
import { ensure, operation, useScope } from 'std:effect'
import { fail, just, nothing } from 'std:result'

import { REPLY_CACHE_TTL_MS, WORKER_TRANSPORT_NAME, WORKER_TRANSPORT_PRIORITY } from './const'
import { attachParent, spawnWorker } from './internal/port'
import {
  createMessageHandler,
  createPeer,
  createTtlCache,
  dispatchVia,
  killPeer,
  postEvent,
} from './internal/shared'
import type { WorkerRole, WorkerTransportOptions, WorkerWire } from './types'

const livePeers = (ctx: WorkerWire.Context): readonly WorkerWire.Peer[] =>
  ctx.peers.filter(peer => !peer.dead)

const pickPeer = (ctx: WorkerWire.Context): WorkerWire.Peer | undefined => {
  const live = livePeers(ctx)

  if (live.length === 0) {
    return undefined
  }

  const peer = live[ctx.cursor % live.length]

  ctx.cursor += 1

  return peer
}

const hostsVia = operation(function* (ctx: WorkerWire.Context, _service: string) {
  // Child: the parent might reach anything — always a fallback candidate.
  // Host: fallback while any worker is live; a drained pool positively does not host.
  if (ctx.role === 'child') {
    return nothing<boolean>()
  }

  return livePeers(ctx).length > 0 ? nothing<boolean>() : just(false)
})

const dispatchOn = operation(function* (ctx: WorkerWire.Context, dispatch: TransportDispatch) {
  const peer = pickPeer(ctx)

  if (!peer) {
    return yield* fail(
      CoreErrors.Unavailable,
      `no live workers behind carrier "${ctx.name}"`,
      `transport:${ctx.name} dispatch cid:${dispatch.request.cid}`,
    )
  }

  return yield* dispatchVia({ ctx, peer, dispatch })
})

const emitOn = operation(function* (ctx: WorkerWire.Context, event: TransportEvent) {
  // Delivery on the far side happens later on its local bus — never claimable synchronously.
  postEvent(ctx, event)

  return 'skipped' as const
})

const broadcastOn = operation(function* (ctx: WorkerWire.Context, event: TransportEvent) {
  postEvent(ctx, event)
})

const WorkerTransportImpl = Transport.implement<WorkerWire.Context, [WorkerTransportOptions?]>({
  name: 'worker-transport',
  version: '0.1.0',
  description: 'Worker-thread carrier — core envelopes over message ports via structured clone',

  *setup(options = {}) {
    const broker = yield* useBroker()
    const scope = yield* useScope()
    const log = yield* moduleLogger('server:transport/worker')
    const name = options.name ?? WORKER_TRANSPORT_NAME
    const role: WorkerRole = options.script === undefined ? 'child' : 'host'
    const ctx: WorkerWire.Context = {
      name,
      role,
      broker,
      scope,
      log,
      peers: [],
      replies: createTtlCache(REPLY_CACHE_TTL_MS),
      cursor: 0,
    }

    if (options.script === undefined) {
      const peer = createPeer(0)

      // Parent → child messages cannot be lost: the child announces `online` only after its own
      // listener is attached, and the parent's listener is wired synchronously at spawn.
      peer.online = true
      peer.port = yield* attachParent({
        message: createMessageHandler(ctx, peer),
        death: () => killPeer(ctx, peer, 'parent port closed'),
      })
      ctx.peers.push(peer)
      peer.port.post({ k: 'online', node: broker.nodeId })

      yield* log.debug('attached to the parent port', { node: broker.nodeId })
    } else {
      const count = Math.max(1, Math.floor(options.count ?? 1))

      for (let index = 0; index < count; index += 1) {
        const peer = createPeer(index)

        peer.port = yield* spawnWorker(options.script, {
          message: createMessageHandler(ctx, peer),
          death: () => killPeer(ctx, peer, 'worker exited'),
        })
        ctx.peers.push(peer)

        yield* log.debug('worker spawned', { index, script: String(options.script) })
      }
    }

    yield* Transport.actions.register({
      name,
      priority: options.priority ?? WORKER_TRANSPORT_PRIORITY,
      actions: {
        hosts: (service: string) => hostsVia(ctx, service),
        dispatch: (dispatch: TransportDispatch) => dispatchOn(ctx, dispatch),
        emit: (event: TransportEvent) => emitOn(ctx, event),
        broadcast: (event: TransportEvent) => broadcastOn(ctx, event),
      },
    })

    yield* ensure(function* () {
      yield* Transport.actions.unregister(name)

      for (const peer of ctx.peers) {
        killPeer(ctx, peer, 'scope closed')
      }
    })

    return ctx
  },
})

/**
 * The worker-thread carrier (`Transport` impl). WITH `script` it is the HOST: spawns `count`
 * workers and round-robins dispatches over them; WITHOUT it is the CHILD: attaches to the parent
 * port and serves its broker's registry. Envelopes cross the port AS OBJECTS (structured clone) —
 * no byte codec; the single wire spec is the envelope shape, and `Wire.Failure` fidelity survives
 * verbatim. Bun uses the Web Worker API, node uses `node:worker_threads`.
 *
 * Source planes (`multistream`/`stream`) travel as `in:*` lane envelopes behind the dispatch, and
 * EVERY flowing lane (input planes and output streams, both directions) is metered by a credit
 * window (`LANE_WINDOW` in flight, one `lane-credit` per `LANE_CREDIT_STEP` consumed). Caller
 * abandonment posts a non-halting `abandoned` envelope (remote `detach` handlers observe their
 * signal); halting the dispatch task itself posts `cancel`.
 *
 * Extra action: `terminate(index)` — kill one spawned worker (tests/ops); its pending dispatches
 * raise `Unavailable` and its open streams close with a Failure.
 */
export const WorkerTransport = WorkerTransportImpl.build({
  hosts: operation(function* (service: string) {
    const ctx = yield* WorkerTransportImpl.context.expect()

    return yield* hostsVia(ctx, service)
  }),

  dispatch: operation(function* (dispatch: TransportDispatch) {
    const ctx = yield* WorkerTransportImpl.context.expect()

    return yield* dispatchOn(ctx, dispatch)
  }),

  emit: operation(function* (event: TransportEvent) {
    const ctx = yield* WorkerTransportImpl.context.expect()

    return yield* emitOn(ctx, event)
  }),

  broadcast: operation(function* (event: TransportEvent) {
    const ctx = yield* WorkerTransportImpl.context.expect()

    yield* broadcastOn(ctx, event)
  }),

  /** Kill one spawned worker by pool index — pendings raise `Unavailable`, streams close failed. */
  terminate: operation(function* (index: number) {
    const ctx = yield* WorkerTransportImpl.context.expect()
    const peer = ctx.peers[index]

    if (!peer) {
      return yield* fail(CoreErrors.NotFound, `no worker at pool index ${index}`)
    }

    killPeer(ctx, peer, 'terminated')
  }),
})
