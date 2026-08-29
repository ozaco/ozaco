import type { Operation } from 'std:effect'
import { attempt, createQueue, scoped } from 'std:effect'
import { IO } from 'std:io'
import { isFailure } from 'std:result'

import { CtxRef } from '../../context'
import type { EdgeDef } from '../../types/edge'
import type { Helpers } from '../../types/helpers'
import { tagOf } from '../../utils/failure'
import { report } from '../../utils/trace'
import { validate } from '../../utils/validation'
import { observing } from '../capture'

const decoder = new TextDecoder()

/**
 * Drive one accepted socket: inbound frames (JSON text) feed a queue the handler consumes as a
 * Flow; `send` encodes values as JSON text; the handler runs in its own scope that ends with the
 * socket (a close from either side halts it). Every frame is an observe event.
 */
export function* driveSocket(input: Helpers.SocketInput): Operation<void> {
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
    url: input.url,
    ctx: input.ctx,

    messages: {
      *[Symbol.iterator]() {
        return {
          *next() {
            for (;;) {
              const step = yield* inbound.next()

              if (step.done) {
                return step
              }

              yield* frame('socket-in', step.value)

              if (!route.receives) {
                return step
              }

              // a malformed frame from ONE client must not kill the session: drop it, report it
              // (it shows up in the console and the exporters), keep reading
              const checked = yield* attempt(() =>
                validate(route.receives!, step.value, `frame of ${route.path}`),
              )

              if (!isFailure(checked)) {
                return { done: false as const, value: checked.value }
              }

              yield* report(kernel, {
                t: 'failure',
                row: {
                  request_id: trace.request_id,
                  span_id: trace.span_id,
                  tag: tagOf(checked),
                  message: checked.message,
                  status: 400,
                  where: `socket:${route.path}`,
                  causes: [`frame:${id}`],
                  ts: Date.now(),
                },
              })
            }
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

  // the socket ctx is ambient for the handler too — runnable ops (`crud.list`) work here
  // exactly as they do inside a dispatch
  yield* scoped(() => CtxRef.with(input.ctx, () => route.handler(socket)))
}
