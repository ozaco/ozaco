import type { GatewayDef } from 'server:core'
import { defineAction, Gateway, ResponseSinkContext, useResponse } from 'server:core'
import type { Operation } from 'std:effect'
import { createQueue, ensure, operation, useContext } from 'std:effect'
import { IO } from 'std:io'
import type { AnyType } from 'std:shared'

import { broadcastAction, joinRoom, leaveRoom, toRoomAction, unregisterSocket } from './realtime'
import { encodeWsBody } from './ws'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

/** SSE wire framing: each message is a `data:` event terminated by a blank line. */
const frame = (payload: string | Uint8Array): Uint8Array => {
  const text = typeof payload === 'string' ? payload : DECODER.decode(payload)
  return ENCODER.encode(`data: ${text}\n\n`)
}

/** The effect-native Socket handle for an SSE connection — the SAME shape `listen` hands WS routes, so
 * a subscription pump written for one transport works on the other unchanged. */
const makeSseSocket = (ctx: GatewayDef.Context, id: string): GatewayDef.Socket => {
  const reg = ctx.sockets.get(id)
  return {
    id,
    data: reg?.raw,
    rooms: reg?.rooms ?? new Set<string>(),
    send: operation(function* (message: unknown) {
      const encoded = yield* encodeWsBody(message)
      if (encoded !== null) {
        reg?.send(encoded as AnyType)
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
    spawn: operation(function* (op: () => Operation<void>) {
      reg?.tasks.add(ctx.scope.run(op))
    }),
  }
}

/**
 * `Gateway.actions.sse(path, handlers)` — register a GET Server-Sent-Events endpoint (the one-way
 * sibling of `listen`). Each connection gets an effect-native {@link GatewayDef.Socket}, an entry in
 * the shared socket registry (so `emit`/`broadcast`/`toRoom` reach SSE + WS clients uniformly), and a
 * buffered event queue streamed as `text/event-stream`. The client sends over normal HTTP requests.
 */
export const sseAction = operation(function* (path: string, handlers: GatewayDef.ListenHandlers) {
  const ctx = yield* useContext(Gateway.context)

  const routeAction = defineAction(function* () {
    const sink = yield* ResponseSinkContext.get()
    const id = yield* IO.actions.ulid()
    const queue = createQueue<Uint8Array, void>()

    const socket: GatewayDef.GatewaySocket = {
      id,
      rooms: new Set<string>(),
      tasks: new Set(),
      raw: queue,
      send: data => {
        queue.add(frame(data as AnyType))
      },
    }
    ctx.sockets.set(id, socket)
    queue.add(ENCODER.encode(': ok\n\n')) // open the stream immediately (flush headers past proxies)

    const res = yield* useResponse()
    res.meta['content-type'] = 'text/event-stream'
    res.meta['cache-control'] = 'no-cache'
    res.meta['x-accel-buffering'] = 'no'

    yield* ensure(function* () {
      for (const task of socket.tasks) {
        yield* task.halt()
      }
      if (handlers.close) {
        yield* handlers.close(makeSseSocket(ctx, id))
      }
      unregisterSocket(ctx, id)
      queue.close()
    })

    if (handlers.open) {
      yield* handlers.open(makeSseSocket(ctx, id))
    }

    // hand the buffered queue to the gateway's streaming sink explicitly (the event-stream headers are
    // already on `res`); `respond` delivers the response then drains the queue until the client leaves.
    const stream = operation(function* () {
      return queue
    })()
    if (sink) {
      yield* sink.respond(stream)
    }
  })

  const setting = { method: 'GET', path, sse: true, transformer: Gateway } as GatewayDef.WsSetting
  const sym = Symbol(`sse#GET#${path}`)
  const entry: GatewayDef.RegisteredRoute = {
    sym,
    prefix: '',
    setting,
    target: routeAction,
    action: routeAction,
  }
  ctx.handlers.set(sym, entry)

  yield* Gateway.actions.add('GET', path, sym)
  yield* Gateway.actions.optimize()
})
