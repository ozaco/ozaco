import type { Operation, StreamQueue, Task } from 'std:effect'
import {
  attempt,
  createStreamQueue,
  ensure,
  operation,
  sleep,
  streamForEach,
  useContext,
} from 'std:effect'
import { isSuccess } from 'std:result'
import type { AnyType, Schema } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'

import { DataType, SESSION_IDLE_MS, SESSION_PING_MS, SOCKET_ID_META } from '../const'
import { Broker, Gateway } from '../definitions'
import type { GatewayDef } from '../types/gateway'
import type { Impl } from '../types/impl'
import type { SocketService } from '../types/socket'

import { defineAction } from './action'
import { stream as streamChannel, value as valueChannel } from './channel'
import { ActionRequestContext } from './context'
import { useRequest, useSource } from './hooks'
import { isControlFrame } from './is'
import { autoWire } from './role'
import { defineService } from './service'

/**
 * A WebSocket endpoint, defined the way a service is.
 *
 * The handler object is the SAME one `Gateway.actions.listen` takes and the `socket` is the same
 * {@link GatewayDef.Socket}, so one object can drive both. The difference is only where the code
 * runs: `listen` registers a raw endpoint inside the gateway process, while this is a service —
 * install it, register it, mount it like any other, and the gateway forwards whole connections to
 * whichever pod owns it.
 *
 * Everything a live connection needs (an outbound stream, a scope that outlives the dispatch,
 * teardown on either ending, event routing) lives here instead of in every app that wants a socket.
 */

/**
 * Frames are untyped at the framework level — the app speaks its own protocol — but the wire needs a
 * DECLARATION: schema presence marks the lane as codec values rather than raw bytes, and the stream
 * channels are what make `acceptsLane`/`producesLane` true, which the sink path, the transport's
 * lane manifest, and the streaming-timeout exemption all key off.
 */
const FRAMES = {
  '~standard': {
    version: 1,
    vendor: 'ozaco',
    validate: (value: unknown) => ({ value }),
    jsonSchema: { input: () => ({}), output: () => ({}) },
  },
} as Schema

/** Parse an inbound frame the same way the per-message path does: JSON when it looks like it. */
const parseFrame = operation(function* (payload: unknown) {
  if (typeof payload !== 'string') {
    return payload
  }
  const trimmed = payload.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return payload
  }
  const parsed = yield* attempt(JsonCodec.actions.parse(payload))
  return isSuccess(parsed) ? parsed.value : payload
})

/**
 * The socket handle for a session connection. Anything touching the gateway's registry becomes a
 * {@link GatewayDef.ControlFrame} on this connection's own outbound stream, which the gateway
 * applies (its push actions already fan `toRoom`/`broadcast`/`emit` out to peer replicas). So the
 * handle behaves identically whether the action runs beside the gateway or three pods away;
 * `rooms` is what THIS connection has joined.
 */
/** Typed so a mistyped command is a compile error rather than a frame the gateway quietly ignores. */
const frame = (value: GatewayDef.ControlFrame): GatewayDef.ControlFrame => value

const makeSocket = (
  id: string,
  out: StreamQueue<unknown, void>,
  tasks: Set<Task<unknown>>,
): GatewayDef.Socket => {
  const rooms = new Set<string>()

  return {
    id,
    data: undefined,
    rooms,
    send: operation(function* (message: unknown) {
      out.add(message)
    }),
    join: operation(function* (room: string) {
      rooms.add(room)
      out.add(frame({ '$ozaco:gw': 'join', room }))
    }),
    leave: operation(function* (room: string) {
      rooms.delete(room)
      out.add(frame({ '$ozaco:gw': 'leave', room }))
    }),
    toRoom: operation(function* (room: string, message: unknown) {
      out.add(frame({ '$ozaco:gw': 'toRoom', room, message }))
    }),
    broadcast: operation(function* (message: unknown) {
      out.add(frame({ '$ozaco:gw': 'broadcast', message }))
    }),
    emit: operation(function* (to: string, message: unknown) {
      out.add(frame({ '$ozaco:gw': 'emit', to, message }))
    }),
    spawn: operation(function* (op: () => Operation<void>) {
      const broker = yield* useContext(Broker)
      const task = broker.scope.run(op)
      tasks.add(task)
      return task
    }),
  }
}

/** Route one frame exactly as `listen` does: `on[event]` first, then the `message` catch-all. */
const route = operation(function* (
  handlers: GatewayDef.ListenHandlers,
  socket: GatewayDef.Socket,
  raw: unknown,
) {
  const message = yield* parseFrame(raw)
  const event = (message as AnyType)?.event

  if (handlers.on && typeof event === 'string' && handlers.on[event]) {
    yield* handlers.on[event]!(socket, message as AnyType)
    return
  }
  if (handlers.message) {
    yield* handlers.message(socket, message)
  }
})

/**
 * The connection as a single action. Use this to hang a socket off a service that also has REST
 * actions; for a socket-only service reach for {@link defineSocket} instead.
 */
export const socketAction = (config: SocketService.Route, handlers: SocketService.Handlers) =>
  defineAction(
    {
      ...(config.title === undefined ? {} : { title: config.title }),
      ...(config.description === undefined ? {} : { description: config.description }),
      input: [valueChannel(FRAMES), streamChannel(FRAMES)],
      output: streamChannel(FRAMES),
      settings: [Gateway.actions.ws({ path: config.path ?? '/', mode: 'session' })],
    },
    function* () {
      const inbound = (yield* useSource(DataType.stream))?.stream
      const out = createStreamQueue<unknown, void>()

      // not a session dispatch (the action was called directly): answer with a closed, empty stream
      // rather than failing — there is no socket to talk to either way
      if (!inbound) {
        out.close()
        return out
      }

      const request = yield* useRequest()
      const tasks = new Set<Task<unknown>>()
      const socket = makeSocket(String(request.meta[SOCKET_ID_META] ?? ''), out, tasks)
      const broker = yield* useContext(Broker)

      let live = true
      let renewed = Date.now()

      // The owner's half of the lease. The gateway cannot tell a busy owner from a dead one — a
      // remote stream that simply stops neither ends nor errors — so without a beat travelling THIS
      // way, an owner that dies leaves every proxied client sitting on an open socket that will
      // never say anything again. Rides the connection's own outbound stream, so it costs no new
      // plumbing. Beat FIRST, then wait: the gateway arms its watchdog only once it has SEEN a beat
      // (it must not reap a hand-rolled session that never sends one), so an owner killed inside
      // the first interval would otherwise never be noticed — and that is exactly when a pod dies:
      // during a rollout, moments after taking the connection.
      const heartbeat = broker.scope.run(function* () {
        for (;;) {
          out.add(frame({ '$ozaco:gw': 'ping' }))
          yield* sleep(SESSION_PING_MS)
          if (!live) {
            return
          }
        }
      })

      // The connection outlives this dispatch — that scope closes the moment we return `out` — so
      // the pump runs on the broker's install scope, which is alive as long as the process is.
      //
      // The request is REPLAYED around it: the pump runs outside the dispatch, so without this a
      // handler (or an access guard it calls) asking for `useRequest`/`useAuth` sees no request at
      // all and fails with `missing-context`. The principal that opened the socket owns the session.
      const pump = broker.scope.run(() =>
        ActionRequestContext.with(request, function* () {
          yield* ensure(function* () {
            live = false
            yield* attempt(() => heartbeat.halt())
            for (const task of tasks) {
              yield* attempt(() => task.halt())
            }
            if (handlers.close) {
              yield* attempt(() => handlers.close!(socket))
            }
            out.close()
          })

          if (handlers.open) {
            yield* handlers.open(socket)
          }

          yield* streamForEach(inbound, function* (inboundFrame: unknown) {
            renewed = Date.now()
            // gateway keepalives (and any other control frame) are ours, never the handlers' business
            if (isControlFrame(inboundFrame)) {
              return
            }
            // One frame is one frame. Letting a handler failure escape would unwind the pump on the
            // BROKER's scope — i.e. take the whole process down and every service co-located with
            // it — so a single malformed message from one client could stop the node. Report it on
            // the connection that caused it and keep serving.
            const outcome = yield* attempt(() => route(handlers, socket, inboundFrame))
            if (!isSuccess(outcome)) {
              out.add({ error: outcome.error, message: outcome.message })
            }
          })
        }),
      )

      // Reap a session whose gateway stopped renewing it. A clean close ends the inbound stream and
      // this never fires; a killed gateway ends nothing, and without this the pump would run forever.
      broker.scope.run(function* () {
        for (;;) {
          yield* sleep(SESSION_PING_MS)
          if (!live) {
            return
          }
          if (Date.now() - renewed > SESSION_IDLE_MS) {
            yield* attempt(() => pump.halt())
            return
          }
        }
      })

      return out
    },
  )

/**
 * `defineSocket(config, handlers)` — `defineService`'s sibling, for a live connection.
 *
 * A peer definer rather than a wrapper: it builds its own plugin, so the thing you get back is a
 * {@link SocketService} with its install args pinned to `[SocketService.Options?]`, not a `Service`
 * that has forgotten what it is. Its actions are fixed — a `session` connection is ONE dispatch, so
 * there is exactly one `connect` — which is precisely why it takes handlers instead of an actions
 * record.
 */
export const defineSocket: Impl.DefineSocket = (config, handlers) => {
  const socket: AnyType = defineService({
    name: config.name,
    version: config.version ?? '0.0.0',
    ...(config.description === undefined ? {} : { description: config.description }),

    actions: { connect: socketAction(config, handlers) } as AnyType,

    setup: function* (options?: SocketService.Options) {
      yield* autoWire(socket, options)
    } as AnyType,
  })

  return socket
}
