import type { GatewayDef } from 'server:core'
import {
  DataType,
  EdgeSourcesContext,
  Gateway,
  isControlFrame,
  ResponseSinkContext,
  SESSION_IDLE_MS,
  SESSION_PING_MS,
  SOCKET_ID_META,
} from 'server:core'
import type { Stream } from 'std:effect'
import { attempt, createStreamQueue, operation, sleep, streamForEach, useContext } from 'std:effect'
import { isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import { ConnectionContext } from './const'
import { dispatchAction } from './dispatch'
import { resolveRouteAction } from './util'
import { buildRequest, buildResponse, encodeWsBody } from './ws'

/**
 * `session`-mode WebSocket proxying.
 *
 * The gateway makes ONE broker dispatch for the whole connection: inbound frames become the
 * action's input stream, and the stream it answers with is pumped back out to the socket. Affinity
 * is a property of that single dispatch — one node answers it and its lanes are keyed to that call
 * — so every frame of a connection reaches the same process without any sticky routing table. The
 * gateway holds the socket and none of the logic, which is what lets a WS route live in another pod.
 *
 * Delivery rides the ordinary `ResponseSink`: in-process the action's own scope pumps into it, and
 * across a wire `dispatchAction`'s adopt hands it the lane — so this file never has to know where
 * the owner runs.
 */

const socketId = (ws: AnyType): string => String(ws?.data?.id ?? '')

/** Push one frame at the socket, tolerating a close that raced the write. */
const sendFrame = operation(function* (ctx: GatewayDef.Context, id: string, frame: unknown) {
  const socket = ctx.sockets.get(id)
  if (!socket) {
    return
  }
  const data = yield* encodeWsBody(frame)
  if (data !== null) {
    socket.send(data as AnyType)
  }
})

/**
 * Hang up on the client.
 *
 * Only the PLATFORM socket is closed — the channel is left alone on purpose. Closing the socket
 * makes the platform fire its own close handler, which calls {@link closeChannel}, which is what
 * halts the pump. Tearing the channel down from here instead would mean the pump halting itself.
 */
const closeSocket = (ctx: GatewayDef.Context, id: string): void => {
  const socket = ctx.sockets.get(id)
  try {
    ;(socket?.raw as AnyType)?.close?.()
  } catch {
    /* already gone */
  }
}

/** Close the socket after an upstream failure, telling the client why rather than dropping silently. */
const failSocket = operation(function* (ctx: GatewayDef.Context, id: string, failure: AnyType) {
  yield* sendFrame(ctx, id, {
    error: String(failure?.error ?? 'channel'),
    message: String(failure?.message ?? 'channel closed'),
  })
  closeSocket(ctx, id)
})

/**
 * Apply one control frame for the socket that produced it.
 *
 * `join`/`leave` stop at this gateway — the socket lives here and nowhere else. The push commands
 * go through the gateway's own actions, whose `$gw.fanout` relay already reaches every peer
 * replica, so a room spanning two gateways hears the whole conversation.
 */
const applyControl = operation(function* (ws: AnyType, frame: GatewayDef.ControlFrame) {
  const command = frame['$ozaco:gw']
  if (command === 'join' || command === 'leave') {
    yield* ConnectionContext.with(ws, () =>
      command === 'join'
        ? Gateway.actions.join(String(frame.room ?? ''))
        : Gateway.actions.leave(String(frame.room ?? '')),
    )
    return
  }
  if (command === 'toRoom') {
    yield* Gateway.actions.toRoom(String(frame.room ?? ''), frame.message)
    return
  }
  if (command === 'broadcast') {
    yield* Gateway.actions.broadcast(frame.message)
    return
  }
  if (command === 'emit') {
    yield* Gateway.actions.emit(String(frame.to ?? ''), frame.message)
  }
})

/**
 * Bind a freshly-opened socket to its action. Runs on the gateway scope so the pump outlives the
 * open handler; the dispatch is torn down by {@link closeChannel}.
 */
export const openChannel = operation(function* (
  ws: AnyType,
  entry: GatewayDef.RegisteredRoute,
  socket: GatewayDef.GatewaySocket,
) {
  const ctx = yield* useContext(Gateway.context)
  const id = socketId(ws)
  // buffered, not a bare channel: a client that sends the instant the socket opens must not lose
  // those frames — the owning node only starts reading once the dispatch reaches it.
  const inbound = createStreamQueue<unknown, void>()

  // The owner's half of the lease. `leased` only arms once the owner has actually sent a ping, so
  // a hand-rolled `mode: 'session'` action that knows nothing about the protocol keeps its old
  // behaviour instead of being reaped by a gateway expecting a beat it will never send.
  let heard = Date.now()
  let leased = false

  const task = ctx.scope.run(function* () {
    // params travel as the single argument, matching the REST path shape (`:id` + query)
    const body = (ws?.data?.params as unknown) ?? {}

    // The envelope is built ONCE, from the upgrade — `buildRequest` promotes `?token=` into an
    // authorization header (the only way a browser can authenticate a WebSocket), and the
    // dispatch context onion carries it, so every auth check inside the session sees the
    // principal that opened the socket. The socket id rides in the meta because the envelope is
    // the only thing that survives a remote hop.
    const [request] = yield* buildRequest(ws, null)
    request.meta[SOCKET_ID_META] = id
    const res = buildResponse()

    // Everything the owner streams back lands here — locally from the action's own scope, across
    // a wire via adopt. Control frames are the action driving THIS gateway's registry
    // (join / toRoom / …); they are consumed here and never reach the client.
    let delivered = false
    const sink = {
      respond: operation(function* (streamed: Stream<Uint8Array, unknown>) {
        delivered = true
        yield* streamForEach(streamed as Stream<unknown, unknown>, function* (frame: unknown) {
          heard = Date.now()
          if (!isControlFrame(frame)) {
            yield* sendFrame(ctx, id, frame)
            return
          }
          if (frame['$ozaco:gw'] === 'ping') {
            leased = true
            return
          }
          yield* applyControl(ws, frame)
        })
      }),
    }

    const action = resolveRouteAction(entry)
    const signal: AbortSignal | undefined = ws?.data?.controller?.signal

    const outcome = yield* attempt(() =>
      EdgeSourcesContext.with([{ type: DataType.stream, stream: inbound }], () =>
        ResponseSinkContext.with(sink, () =>
          dispatchAction({ req: request, res, connection: ws, signal }, entry, action, body),
        ),
      ),
    )

    if (!isSuccess(outcome)) {
      yield* failSocket(ctx, id, outcome)
      return
    }

    // a session action answers with a stream (drained through the sink above); a plain value is
    // sent as one final frame
    if (!delivered) {
      yield* sendFrame(ctx, id, outcome.value)
    }

    // The owner ended the connection (handler returned, service shut down cleanly). The socket has
    // nothing left to carry, so it must not be left open pretending otherwise.
    closeSocket(ctx, id)
  })
  socket.tasks.add(task)

  // Reap a socket whose owner stopped answering. Its counterpart lives in `socketAction`, which
  // halts a session the gateway stopped renewing; this is the same idea pointed the other way, and
  // without it a dead owner leaves the client parked on a live socket that will never produce
  // another frame.
  //
  // Only a HARD death needs this. An owner that shuts down cleanly ends its outbound stream and
  // the `closeSocket` above hangs up at once — so a rolling restart is instant and the lease only
  // covers a kill, a crash or a partition. Polled at a fraction of the beat so the wait is the
  // lease itself (~SESSION_IDLE_MS) rather than the lease plus a whole tick.
  const watchdog = ctx.scope.run(function* () {
    for (;;) {
      yield* sleep(SESSION_PING_MS / 5)
      if (leased && Date.now() - heard > SESSION_IDLE_MS) {
        yield* failSocket(ctx, id, { error: 'session-lost', message: 'owner stopped responding' })
        return
      }
    }
  })

  // Renew the lease. This is the ONLY thing that tells the owner the gateway is still alive: a
  // SIGKILLed gateway runs no teardown, so silence has to be what reaps the session.
  const lease = ctx.scope.run(function* () {
    for (;;) {
      yield* sleep(SESSION_PING_MS)
      inbound.add({ '$ozaco:gw': 'ping' })
    }
  })

  ctx.channels.set(id, {
    push: operation(function* (frame: unknown) {
      // a client must not be able to forge one: control frames are ours, in both directions
      if (!isControlFrame(frame)) {
        inbound.add(frame)
      }
    }),
    close: operation(function* () {
      yield* attempt(() => watchdog.halt())
      yield* attempt(() => lease.halt())
      inbound.close()
      yield* attempt(() => task.halt())
    }),
  })
})

/** Feed one inbound frame to the owning node. Returns false when this socket has no open channel. */
export const pushChannel = operation(function* (ws: AnyType, frame: unknown) {
  const ctx = yield* useContext(Gateway.context)
  const channel = ctx.channels.get(socketId(ws))
  if (!channel) {
    return false
  }
  yield* channel.push(frame)
  return true
})

/** Close the inbound side and halt the pump — unwinding the dispatch cancels it upstream. */
export const closeChannel = operation(function* (ws: AnyType) {
  const ctx = yield* useContext(Gateway.context)
  const id = socketId(ws)
  const channel = ctx.channels.get(id)
  if (!channel) {
    return
  }
  ctx.channels.delete(id)
  yield* attempt(() => channel.close())
})
