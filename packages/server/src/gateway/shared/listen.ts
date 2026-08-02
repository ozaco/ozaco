import type { GatewayDef } from 'server:core'
import { ActionRequestContext, defineAction, Gateway } from 'server:core'
import type { Operation } from 'std:effect'
import { operation, useContext } from 'std:effect'
import type { AnyType } from 'std:shared'

import { broadcastAction, emitAction, joinRoom, leaveRoom, toRoomAction } from './realtime'
import { encodeWsBody, parseWsPayload, wsUpgradeRequest } from './ws'

// `Gateway.actions.listen(path, handlers)` — register a WS endpoint WITHOUT defineAction/mount. It
// synthesizes a WS route entry whose `onOpen/onMessage/onClose` (the existing lifecycle hooks) wrap the
// handler object, building an effect-native `Socket` handle per event. `on` gives socket.io-style event
// routing; `message` is the raw catch-all. Rooms come free via the socket handle + the room registry.

// Placeholder action for the synthetic route — never invoked: a listen route always sets `onMessage`,
// so onMessageAction short-circuits into the hook before it ever touches `entry.action`.
const noop = defineAction(function* () {})

const makeSocket = (ctx: GatewayDef.Context, ws: AnyType): GatewayDef.Socket => {
  const id = String(ws?.data?.id ?? '')
  const reg = ctx.sockets.get(id)
  return {
    id,
    data: ws?.data,
    ...(ws?.data?.principal === undefined ? {} : { principal: ws.data.principal }),
    rooms: reg?.rooms ?? new Set<string>(),
    send: operation(function* (message: unknown) {
      const data = yield* encodeWsBody(message)
      if (data !== null) {
        reg?.send(data as AnyType)
      }
    }),
    join: operation(function* (room: string) {
      joinRoom(ctx, id, room)
    }),
    leave: operation(function* (room: string) {
      leaveRoom(ctx, id, room)
    }),
    toRoom: toRoomAction,
    broadcast: broadcastAction,
    emit: emitAction,
    close: operation(function* (code?: number, reason?: string) {
      try {
        ;(reg?.raw as AnyType)?.close?.(code, reason)
      } catch {
        /* already gone */
      }
    }),
    spawn: operation(function* (op: () => Operation<void>) {
      // run on the gateway scope, tracked on this socket so onClose halts it (no leaked pumps).
      const task = ctx.scope.run(op)
      reg?.tasks.add(task)
      return task
    }),
  }
}

export const listenAction = operation(function* (
  path: string,
  handlers: GatewayDef.ListenHandlers,
) {
  const ctx = yield* useContext(Gateway.context)

  // Every handler runs inside the UPGRADE request's context — the same envelope `authorize` saw —
  // so `useRequest()`/`useAuth(...)` answer on a raw WS route too (mid-stream re-auth included).
  const inRequest = (ws: AnyType, body: () => Operation<void>): Operation<void> =>
    ws?.data?.url ? ActionRequestContext.with(wsUpgradeRequest(ws.data), body) : body()

  const onOpen = handlers.open
    ? operation(function* (ws: AnyType) {
        yield* inRequest(ws, () => handlers.open!(makeSocket(ctx, ws)))
      })
    : undefined

  const onClose = handlers.close
    ? operation(function* (ws: AnyType) {
        yield* inRequest(ws, () => handlers.close!(makeSocket(ctx, ws)))
      })
    : undefined

  // always set — this is what makes onMessageAction hand us the raw frame instead of per-message RPC.
  const onMessage = operation(function* (ws: AnyType, raw: unknown) {
    const socket = makeSocket(ctx, ws)
    const message = yield* parseWsPayload(raw)
    const event = (message as AnyType)?.event

    if (handlers.on && typeof event === 'string' && handlers.on[event]) {
      yield* inRequest(ws, () => handlers.on![event]!(socket, message as AnyType))
      return
    }
    if (handlers.message) {
      yield* inRequest(ws, () => handlers.message!(socket, message))
    }
  })

  const setting = {
    method: 'WS',
    path,
    transformer: Gateway,
    ...(handlers.authorize ? { authorize: handlers.authorize } : {}),
    ...(onOpen ? { onOpen } : {}),
    onMessage,
    ...(onClose ? { onClose } : {}),
  } as GatewayDef.WsSetting

  const sym = Symbol(`listen#WS#${path}`)
  const entry: GatewayDef.RegisteredRoute = { sym, prefix: '', setting, target: noop, action: noop }
  ctx.handlers.set(sym, entry)

  yield* Gateway.actions.add('WS', path, sym)
  yield* Gateway.actions.optimize() // recompile the matcher so the route is live immediately
})
