import type { Flow, Future, Operation } from 'std:effect'
import { attempt, createQueue, fork, operation, resource, sleep, withResolvers } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isSuccess } from 'std:result'

import type { WsDef } from '../types'

import { decodeFrame, encodeFrame } from './frame'

const CONNECTING = 0
const OPEN = 1

/** Fully-resolved reconnect settings (absent entirely when reconnect is disabled). */
interface ReconnectBudget {
  retries: number
  delayMs: number
  backoff: number
  maxDelayMs: number
}

const budgetOf = (options?: WsDef.ReconnectOptions): ReconnectBudget | undefined =>
  options
    ? {
        retries: options.retries ?? 5,
        delayMs: options.delayMs ?? 250,
        backoff: options.backoff ?? 1,
        maxDelayMs: options.maxDelayMs ?? 30_000,
      }
    : undefined

/**
 * Open a connection as a RESOURCE bound to the caller's scope: the body dials the first socket
 * generation (raising `'ws/connect'` on a handshake failure), forks the reconnect supervisor and
 * keepalive pumps, provides the connection handle, and — when the scope closes — closes the
 * socket and finalizes in its teardown. Every socket generation feeds ONE shared raw-frame queue,
 * so `messages` is a single continuous flow across reconnects.
 */
export const createConnection = (
  Ctor: WsDef.Ctor,
  url: string | URL,
  options: WsDef.Options,
): Operation<WsDef.Connection> =>
  resource(function* (provide) {
    const reconnect = budgetOf(options.reconnect)

    // raw frames from every generation; decoding happens lazily on pull (see `messages`)
    const queue = createQueue<unknown, WsDef.FlowClose>()
    // each non-client close of the CURRENT generation lands here for the supervisor to handle
    const outages = createQueue<WsDef.CloseInfo, void>()
    const closedResolvers = withResolvers<WsDef.CloseInfo>('ws:closed')

    const state = {
      /** Current socket generation — adopted inside `onopen`, replaced on every reopen. */
      socket: undefined as WsDef.SocketLike | undefined,
      /** Permanently ended: the queue is closed and `closed` is resolved. */
      ended: false,
      /** `close()` was called (or the scope tore down) — never reconnect past this point. */
      closedByClient: false,
      reconnects: 0,
      lastClose: undefined as WsDef.CloseInfo | undefined,
      /** Post-open socket error on a single-shot connection — becomes the flow's failure close. */
      erred: undefined as Result.Failure<unknown> | undefined,
    }

    // `send` parks on this gate during a reconnect window; every reopen and the permanent end
    // resolve the current gate and arm a fresh one.
    let stateGate = withResolvers<void>('ws:state-change')
    const notifyState = () => {
      const gate = stateGate
      stateGate = withResolvers<void>('ws:state-change')
      gate.resolve()
    }

    /** Permanent end — runs at most once: closes the shared messages queue, resolves `closed`,
     * ends the supervisor, and wakes any parked sender. */
    const settle = (close: WsDef.FlowClose, info: WsDef.CloseInfo) => {
      if (state.ended) {
        return
      }
      state.ended = true
      state.lastClose = info
      queue.close(close)
      closedResolvers.resolve(info)
      outages.close()
      notifyState()
    }

    // Dial ONE socket generation: construct, wire, resolve once OPEN (adopting the socket as
    // current) or raise 'ws/connect'. On failure — or a halt mid-handshake — the socket is
    // unhooked and disposed so nothing leaks.
    const dial = operation(function* () {
      // headers require the Bun/Node options-object constructor form; without them, use the
      // standard `protocols` second arg so the browser WebSocket stays happy.
      let socket: WsDef.SocketLike
      if (options.headers) {
        socket = new Ctor(url, {
          headers: options.headers,
          ...(options.protocols ? { protocols: options.protocols } : {}),
        })
      } else if (options.protocols) {
        socket = new Ctor(url, options.protocols)
      } else {
        socket = new Ctor(url)
      }

      // receive binary frames as ArrayBuffer, not the default Blob — consistent across
      // Bun/Node/browser and passed straight through by `decodeFrame`.
      socket.binaryType = 'arraybuffer'

      const opened = withResolvers<void>('ws:open')

      // on* assignment (not addEventListener): SocketLike is the handler-property shape shared by
      // the browser WebSocket, Bun, and node's global WebSocket.
      /* oxlint-disable unicorn/prefer-add-event-listener */
      socket.onopen = () => {
        if (state.ended || state.closedByClient) {
          // the connection ended while this dial was in flight — do not adopt, just dispose
          socket.close()
          opened.reject(fail('ws/connect', `connection closed during dial: ${String(url)}`))
          return
        }
        state.socket = socket
        opened.resolve()
        notifyState()
      }
      socket.onmessage = event => {
        // every generation feeds the SAME queue — `messages` is one continuous flow
        if (!state.ended) {
          queue.add(event.data)
        }
      }
      socket.onerror = () => {
        const failure = fail(
          'ws/connect',
          `websocket error: ${String(url)}`,
        ) as Result.Failure<unknown>
        opened.reject(failure) // no-op once already open
        if (!state.ended && state.socket === socket && !reconnect) {
          // post-open error on a single-shot connection: the flow closes with this at onclose
          state.erred = failure
        }
      }
      socket.onclose = event => {
        if (state.ended || state.socket !== socket) {
          return // a superseded or never-adopted generation — nothing to do
        }
        const info = { code: event?.code ?? 1000, reason: event?.reason ?? '' }
        state.lastClose = info
        if (state.closedByClient) {
          settle(true, info) // clean client close → the flow ends `true`
          return
        }
        if (!reconnect) {
          settle(state.erred ?? true, info) // single-shot: any server-side end is permanent
          return
        }
        notifyState()
        outages.add(info) // hand the outage to the reconnect supervisor
      }

      let adopted = false
      try {
        yield* opened.operation
        adopted = true
      } finally {
        if (!adopted) {
          // handshake failed OR we were halted mid-dial: unhook and dispose the socket
          socket.onopen = null
          socket.onmessage = null
          socket.onerror = null
          socket.onclose = null
          if (socket.readyState === CONNECTING || socket.readyState === OPEN) {
            socket.close()
          }
        }
      }
      /* oxlint-enable unicorn/prefer-add-event-listener */
    }, 'ws-dial')

    // Reconnect supervisor (forked): one outage at a time — redial after
    // `delayMs * backoff^attempt` (capped by `maxDelayMs`); the attempt budget RESETS after every
    // successful reopen, so only consecutive failed redials exhaust it. Exhaustion ends the
    // connection with a 'ws/reconnect-exhausted' failure close. Never raises: dial failures are
    // attempted, everything else is synchronous bookkeeping.
    const supervise = operation(function* (budget: ReconnectBudget) {
      while (true) {
        const outage = yield* outages.next()
        if (outage.done) {
          return
        }

        let reopened = false
        for (let attemptNo = 0; attemptNo < budget.retries; attemptNo += 1) {
          yield* sleep(Math.min(budget.delayMs * budget.backoff ** attemptNo, budget.maxDelayMs))
          if (state.ended || state.closedByClient) {
            return
          }

          const redialed = yield* attempt(dial)
          if (isSuccess(redialed)) {
            if (state.ended) {
              return // raced with teardown — `onopen` refused adoption and disposed the socket
            }
            state.reconnects += 1
            reopened = true
            break
          }
        }

        if (!reopened) {
          const last = state.lastClose ?? { code: 1006, reason: '' }
          settle(
            fail(
              'ws/reconnect-exhausted',
              `gave up after ${budget.retries} redial attempts (last close: ${last.code}${
                last.reason ? ` ${last.reason}` : ''
              })`,
            ) as Result.Failure<unknown>,
            last,
          )
          return
        }
      }
    }, 'ws-reconnect')

    // Keepalive pump (forked, only when configured): send `payload` through the normal codec
    // framing every `intervalMs` while OPEN. Stops silently if the payload cannot be encoded
    // (e.g. a structured payload with no codec in scope) — it must never raise past the resource.
    const keepAlive = operation(function* (keepalive: WsDef.KeepaliveOptions) {
      const intervalMs = keepalive.intervalMs ?? 30_000
      const payload = keepalive.payload ?? 'ping'
      while (!state.ended) {
        yield* sleep(intervalMs)
        const socket = state.socket
        if (state.ended || !socket || socket.readyState !== OPEN) {
          continue
        }
        const encoded = yield* attempt(() => encodeFrame(payload, options.codec))
        if (!isSuccess(encoded)) {
          return
        }
        socket.send(encoded.value)
      }
    }, 'ws-keepalive')

    // initial dial — a handshake failure ('ws/connect') surfaces directly to the connect() caller
    yield* dial()

    if (reconnect) {
      yield* fork(() => supervise(reconnect))
    }
    if (options.keepalive) {
      const keepalive = options.keepalive
      yield* fork(() => keepAlive(keepalive))
    }

    const closed = operation(function* () {
      return yield* closedResolvers.operation
    })() as Future<WsDef.CloseInfo>

    // a Flow is `Operation<Subscription>`; this hands back a subscription whose `next()` pulls a
    // raw frame off the shared queue and codec-decodes it — buffered frames survive until read.
    const messages = {
      *[Symbol.iterator]() {
        return {
          next: operation(function* () {
            const item = yield* queue.next()
            if (item.done) {
              return item
            }
            return { done: false, value: yield* decodeFrame(item.value, options.codec) }
          }),
        }
      },
    } as Flow<unknown, WsDef.FlowClose>

    const connection: WsDef.Connection = {
      get native() {
        return state.socket as WsDef.SocketLike
      },
      url: String(url),
      get readyState() {
        return (state.socket as WsDef.SocketLike).readyState
      },
      get reconnects() {
        return state.reconnects
      },
      send: operation(function* (data: unknown) {
        const payload = yield* encodeFrame(data, options.codec)
        while (true) {
          if (state.ended || state.closedByClient) {
            return // permanently closed → WHATWG silent discard
          }
          const socket = state.socket
          if (socket && socket.readyState === OPEN) {
            socket.send(payload)
            return
          }
          if (!reconnect) {
            return // closing/closed with no reconnect → WHATWG silent discard
          }
          // reconnect window: park until the next reopen (or the permanent end), then re-check
          yield* stateGate.operation
        }
      }, 'ws-send'),
      messages,
      close: operation(function* (code, reason) {
        state.closedByClient = true
        const socket = state.socket
        if (!state.ended) {
          if (socket && (socket.readyState === OPEN || socket.readyState === CONNECTING)) {
            socket.close(code, reason)
          } else {
            // no live socket (mid-reconnect window or already closed) — finalize right here
            settle(true, state.lastClose ?? { code: code ?? 1000, reason: reason ?? '' })
          }
        }
        yield* closedResolvers.operation
      }, 'ws-close'),
      closed,
    }

    try {
      yield* provide(connection)
    } finally {
      // scope teardown: the connection is a resource — close the socket and finalize. Treated as
      // a clean client close: never reconnected, the flow ends `true`, `closed` resolves.
      state.closedByClient = true
      const socket = state.socket
      if (!state.ended) {
        if (socket && (socket.readyState === OPEN || socket.readyState === CONNECTING)) {
          socket.close(1000, 'scope closed')
          yield* closedResolvers.operation
        } else {
          settle(true, state.lastClose ?? { code: 1000, reason: 'scope closed' })
        }
      }
    }
  })
