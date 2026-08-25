import type { Operation } from 'std:effect'
import { createQueue, scoped } from 'std:effect'
import { IO } from 'std:io'

import type { EdgeDef } from '../../types/edge'
import type { ServerDef } from '../../types/server'
import type { TraceDef } from '../../types/trace'
import { report } from '../../utils/trace'
import { observing } from '../capture'

interface SocketInput {
  readonly kernel: ServerDef.Context
  readonly route: EdgeDef.SocketRoute
  readonly raw: EdgeDef.RawSocket
  readonly params: Readonly<Record<string, string>>
  readonly headers: Readonly<Record<string, string>>
  readonly ctx: ServerDef.Ctx
  readonly trace: TraceDef.Trace
}

const decoder = new TextDecoder()

/**
 * Drive one accepted socket: inbound frames (JSON text) feed a queue the handler consumes as a
 * Flow; `send` encodes values as JSON text; the handler runs in its own scope that ends with the
 * socket (a close from either side halts it). Every frame is an observe event.
 */
export function* driveSocket(input: SocketInput): Operation<void> {
  const { kernel, route, raw, trace } = input
  const id = (yield* IO.actions.uuid()).slice(0, 8)
  const inbound = createQueue<unknown, void>()

  raw.onMessage(data => {
    const text = typeof data === 'string' ? data : decoder.decode(data)
    try {
      inbound.add(JSON.parse(text))
    } catch {
      inbound.add(text)
    }
  })

  raw.onClose(() => {
    inbound.close(undefined)
  })

  const watched = observing(kernel)

  // while observing, every frame keeps its FULL payload — the console can replay the exchange
  const frame = (kind: 'socket-in' | 'socket-out', payload: unknown) => {
    const text = watched ? JSON.stringify(payload) : null

    return report(kernel, {
      t: 'event',
      row: {
        request_id: trace.request_id,
        kind,
        name: route.path,
        size: text === null || text === undefined ? null : text.length,
        ts: Date.now(),
        ...(watched ? { data: payload } : {}),
      },
    })
  }

  const socket: EdgeDef.Socket = {
    id,
    params: input.params,
    headers: input.headers,
    ctx: input.ctx,

    messages: {
      *[Symbol.iterator]() {
        return {
          *next() {
            const step = yield* inbound.next()

            if (!step.done) {
              yield* frame('socket-in', step.value)
            }

            return step
          },
        }
      },
    },
    *send(value) {
      raw.send(JSON.stringify(value))
      yield* frame('socket-out', value)
    },
    *close(code, reason) {
      raw.close(code, reason)
    },
  }

  yield* scoped(() => route.handler(socket))
}
