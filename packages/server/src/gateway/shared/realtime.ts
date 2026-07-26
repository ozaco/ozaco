import type { GatewayDef } from 'server:core'
import { Broker, CoreErrors, Gateway } from 'server:core'
import { operation, useContext } from 'std:effect'
import { asFailure, auto, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { ConnectionContext } from './const'
import { dispatchAction } from './dispatch'
import { resolveRouteAction } from './util'
import { buildRequest, buildResponse, encodeWsBody, sendResult } from './ws'

// The gateway's socket.io-like real-time layer. WS connections are tracked in the gateway's shared
// context (`sockets` by id, `rooms` by name), so server-push (emit/broadcast/toRoom) works from ANY
// scope — not just from within an action's return value. `join`/`leave` act on the current socket.
// The lifecycle actions here are platform-agnostic: both the Bun and Node gateways funnel their raw
// socket callbacks through `Gateway.actions.onOpen/onMessage/onClose`, which run these impls.

// ---- connection registry -----------------------------------------------------------------------

/** Track a freshly-opened socket in the live-connection map. The `id` is stamped onto `raw.data` at
 * upgrade time; `send` is a guarded wrapper so a race with close cannot throw. */
const registerSocket = (ctx: GatewayDef.Context, raw: AnyType): GatewayDef.GatewaySocket => {
  const id = String(raw?.data?.id ?? '')
  const socket: GatewayDef.GatewaySocket = {
    id,
    rooms: new Set<string>(),
    tasks: new Set(),
    raw,
    send: data => {
      try {
        raw.send(data)
      } catch {
        /* socket already closed — drop the frame */
      }
    },
  }
  ctx.sockets.set(id, socket)
  return socket
}

/**
 * Tear down EVERY live WS connection — halt each socket's background tasks (subscription pumps), close
 * the raw socket, and drop the registry. Called from the gateway destroy path so an open WS client
 * cannot block shutdown (Bun's graceful `server.stop()` waits on open sockets; a spawned pump would
 * otherwise keep the scope alive).
 */
const closeSockets = operation(function* (ctx: GatewayDef.Context) {
  // snapshot: closing a raw socket schedules its (async) onClose which mutates the registry
  for (const socket of Array.from(ctx.sockets.values())) {
    for (const task of socket.tasks) {
      yield* task.halt()
    }
    // `terminate()` closes the TCP immediately (Bun ServerWebSocket + node `ws` both have it) so the
    // graceful `server.stop()` isn't left waiting on a lingering close-handshake; fall back to close().
    const raw = socket.raw as AnyType
    try {
      if (typeof raw?.terminate === 'function') {
        raw.terminate()
      } else {
        raw?.close?.()
      }
    } catch {
      /* already gone */
    }
  }
  ctx.sockets.clear()
  ctx.rooms.clear()
})

/** Remove a closed socket from the registry and from every room it had joined. */
const unregisterSocket = (ctx: GatewayDef.Context, id: string): void => {
  const socket = ctx.sockets.get(id)
  if (!socket) {
    return
  }
  for (const room of socket.rooms) {
    const members = ctx.rooms.get(room)
    if (!members) {
      continue
    }
    members.delete(id)
    if (members.size === 0) {
      ctx.rooms.delete(room)
    }
  }
  ctx.sockets.delete(id)
}

// ---- cross-replica fan-out ---------------------------------------------------------------------

/**
 * Rooms span gateway REPLICAS. Membership stays local (a socket lives on exactly one gateway), but
 * a push — `toRoom`, `broadcast`, a targeted `emit` — must reach members held by every replica: a
 * client on gw-1 and one on gw-2 sharing a room would otherwise each hear only half the
 * conversation. So every push delivers LOCALLY and relays the same frame over the broker's
 * broadcast plane; peers replay it onto their own sockets. The emitter skips its own echo by
 * ORIGIN, because its local delivery already happened.
 */
const GW_FANOUT = '$gw.fanout'

interface FanoutFrame {
  op: 'toRoom' | 'broadcast' | 'emit'
  room?: string
  socketId?: string
  message: unknown
}

const relayFanout = operation(function* (frame: FanoutFrame) {
  // no broker means no replicas to reach — single-process apps pay nothing
  if ((yield* Broker.context.get()) === undefined) {
    return
  }
  yield* Broker.actions.broadcast(GW_FANOUT, frame)
})

const fanoutAttached = new WeakSet<GatewayDef.Context>()

const ensureFanoutWatcher = operation(function* () {
  const ctx = yield* useContext(Gateway.context)
  if (fanoutAttached.has(ctx)) {
    return
  }
  const broker = yield* Broker.context.get()
  if (broker === undefined) {
    return
  }
  fanoutAttached.add(ctx)

  yield* Broker.actions.on('event.broadcast', info => {
    if (info.name !== GW_FANOUT) {
      return
    }
    // own echo: this gateway already delivered locally when it published
    if (info.origin !== undefined && info.origin === broker.nodeId) {
      return
    }
    const frame = info.payload as FanoutFrame

    ctx.scope.run(function* () {
      if (frame.op === 'toRoom' && frame.room !== undefined) {
        yield* deliverToRoom(ctx, frame.room, frame.message)
      } else if (frame.op === 'broadcast') {
        yield* deliverBroadcast(ctx, frame.message)
      } else if (frame.op === 'emit' && frame.socketId !== undefined) {
        yield* deliverTo(ctx, frame.socketId, frame.message)
      }
    })
  })
})

// ---- lifecycle (platform-agnostic) -------------------------------------------------------------

const onOpenAction = operation(function* (ws: AnyType) {
  const ctx = yield* useContext(Gateway.context)
  registerSocket(ctx, ws)
  // idempotent: the first socket a replica accepts is the moment peer pushes start mattering to it
  yield* ensureFanoutWatcher()
  const setting = ws?.data?.entry?.setting as GatewayDef.WsSetting | undefined
  if (setting?.onOpen) {
    yield* setting.onOpen(ws)
  }
})

const onMessageAction = operation(function* (ws: AnyType, message: unknown) {
  const entry = ws?.data?.entry as GatewayDef.RegisteredRoute | undefined
  if (!entry) {
    return
  }

  // opt-in: a route that supplies `onMessage` owns the raw frame (socket.io-style); otherwise the
  // frame runs the default per-message request/response dispatch — unchanged, never broken.
  const setting = entry.setting as GatewayDef.WsSetting | undefined
  if (setting?.onMessage) {
    yield* setting.onMessage(ws, message)
    return
  }

  const [req, body] = yield* buildRequest(ws, message)
  const res = buildResponse()
  const signal: AbortSignal | undefined = ws?.data?.controller?.signal
  const action = resolveRouteAction(entry)

  try {
    const ret = yield* dispatchAction({ req, res, connection: ws, signal }, entry, action, body)
    yield* sendResult(ws, res, auto(ret))
  } catch (error) {
    yield* sendResult(ws, res, asFailure(error))
  }
})

const onCloseAction = operation(function* (ws: AnyType, code: number, reason: string) {
  const setting = ws?.data?.entry?.setting as GatewayDef.WsSetting | undefined
  if (setting?.onClose) {
    yield* setting.onClose(ws, code, reason)
  }
  const ctx = yield* useContext(Gateway.context)
  const socket = ctx.sockets.get(String(ws?.data?.id ?? ''))
  if (socket) {
    // halt every per-socket background task (subscription pumps) so nothing survives the disconnect
    for (const task of socket.tasks) {
      yield* task.halt()
    }
  }
  unregisterSocket(ctx, String(ws?.data?.id ?? ''))
  ws?.data?.controller?.abort()
})

// ---- realtime push + rooms ---------------------------------------------------------------------

const useCurrent = operation(function* () {
  const raw = (yield* ConnectionContext.get()) as AnyType
  const ctx = yield* useContext(Gateway.context)
  const id = raw?.data?.id as string | undefined
  return { ctx, socket: id === undefined ? undefined : ctx.sockets.get(id) }
})

// pure registry mutations, reused by the context actions (join/leave) AND the listen() socket handle.
const joinRoom = (ctx: GatewayDef.Context, socketId: string, room: string): void => {
  const socket = ctx.sockets.get(socketId)
  if (!socket) {
    return
  }
  socket.rooms.add(room)
  const members = ctx.rooms.get(room) ?? new Set<string>()
  members.add(socketId)
  ctx.rooms.set(room, members)
}

const leaveRoom = (ctx: GatewayDef.Context, socketId: string, room: string): void => {
  const socket = ctx.sockets.get(socketId)
  if (!socket) {
    return
  }
  socket.rooms.delete(room)
  const members = ctx.rooms.get(room)
  if (!members) {
    return
  }
  members.delete(socketId)
  if (members.size === 0) {
    ctx.rooms.delete(room)
  }
}

const joinAction = operation(function* (room: string) {
  const { ctx, socket } = yield* useCurrent()
  if (!socket) {
    return yield* fail(
      CoreErrors.BrokerInternal,
      'Gateway.actions.join must run inside a WebSocket request (no current socket)',
    )
  }
  joinRoom(ctx, socket.id, room)
})

const leaveAction = operation(function* (room: string) {
  const { ctx, socket } = yield* useCurrent()
  if (socket) {
    leaveRoom(ctx, socket.id, room)
  }
})

// LOCAL delivery halves — what a peer's relayed frame replays, and what the actions below do
// before relaying. Never publish from these, or a relay would relay again.

const deliverTo = operation(function* (
  ctx: GatewayDef.Context,
  socketId: string,
  message: unknown,
) {
  const socket = ctx.sockets.get(socketId)
  if (!socket) {
    return
  }
  const data = yield* encodeWsBody(message)
  if (data !== null) {
    socket.send(data as AnyType)
  }
})

const deliverBroadcast = operation(function* (ctx: GatewayDef.Context, message: unknown) {
  const data = yield* encodeWsBody(message)
  if (data === null) {
    return
  }
  for (const socket of ctx.sockets.values()) {
    socket.send(data as AnyType)
  }
})

const deliverToRoom = operation(function* (
  ctx: GatewayDef.Context,
  room: string,
  message: unknown,
) {
  const members = ctx.rooms.get(room)
  if (!members || members.size === 0) {
    return
  }
  const data = yield* encodeWsBody(message)
  if (data === null) {
    return
  }
  for (const id of members) {
    ctx.sockets.get(id)?.send(data as AnyType)
  }
})

const emitAction = operation(function* (socketId: string, message: unknown) {
  const ctx = yield* useContext(Gateway.context)
  yield* deliverTo(ctx, socketId, message)
  // the target may live on another replica — everyone else finds no such socket and no-ops
  yield* relayFanout({ op: 'emit', socketId, message })
})

const broadcastAction = operation(function* (message: unknown) {
  const ctx = yield* useContext(Gateway.context)
  yield* deliverBroadcast(ctx, message)
  yield* relayFanout({ op: 'broadcast', message })
})

const toRoomAction = operation(function* (room: string, message: unknown) {
  const ctx = yield* useContext(Gateway.context)
  yield* deliverToRoom(ctx, room, message)
  yield* relayFanout({ op: 'toRoom', room, message })
})

export {
  broadcastAction,
  closeSockets,
  emitAction,
  joinAction,
  joinRoom,
  leaveAction,
  leaveRoom,
  onCloseAction,
  onMessageAction,
  onOpenAction,
  registerSocket,
  toRoomAction,
  unregisterSocket,
}
