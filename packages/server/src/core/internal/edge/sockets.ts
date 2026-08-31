import type { Operation } from 'std:effect'
import { attempt, createQueue, race, scoped, sleep } from 'std:effect'
import { IO } from 'std:io'
import { isFailure } from 'std:result'

import { SOCKET_AUTH_GRACE_MS } from '../../const'
import { CtxRef } from '../../context'
import type { EdgeDef } from '../../types/edge'
import type { Helpers } from '../../types/helpers'
import { tagOf } from '../../utils/failure'
import { report } from '../../utils/trace'
import { validate } from '../../utils/validation'
import { observing } from '../capture'
import { contextFor } from '../dispatch'

const decoder = new TextDecoder()

/** The auth-frame shape a deferred socket waits for (validated structurally — it arrives
 * before the route's `receives` schema applies). */
const authFrameOf = (value: unknown): string | null =>
  typeof value === 'object' &&
  value !== null &&
  (value as { t?: unknown }).t === 'auth' &&
  typeof (value as { token?: unknown }).token === 'string'
    ? ((value as { token: string }).token as string)
    : null

/**
 * Drive one accepted socket: inbound frames (JSON text) feed a queue the handler consumes as a
 * Flow; `send` encodes values as JSON text; the handler runs in its own scope that ends with the
 * socket (a close from either side halts it). Every frame is an observe event.
 *
 * A DEFERRED handshake (an `authorize` route reached without an authorization header) settles
 * here: the first frame within a short grace either carries `{ t: 'auth', token }` or the
 * route authorizes token-less (open resources); a failing verdict closes the socket with 4401
 * before the handler ever runs.
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
        // the socket SESSION span is the frame's parent in the trace
        span_id: trace.span_id,
        kind,
        name: route.path,
        size: text === null || text === undefined ? null : text.length,
        ts: Date.now(),
        ...(watched ? { data: payload } : {}),
      },
    })
  }

  // --- deferred first-frame auth ------------------------------------------------------------

  let principal: unknown = input.auth.kind === 'settled' ? input.auth.principal : undefined
  // a non-auth first frame consumed while waiting is handed to the handler afterwards
  let pending: IteratorResult<unknown, void> | null = null

  if (input.auth.kind === 'deferred' && route.authorize) {
    const first = yield* race([
      (function* (): Operation<IteratorResult<unknown, void> | 'grace'> {
        yield* sleep(SOCKET_AUTH_GRACE_MS)
        return 'grace'
      })(),
      (function* (): Operation<IteratorResult<unknown, void> | 'grace'> {
        return yield* inbound.next()
      })(),
    ])

    const token =
      first === 'grace' || first.done ? undefined : (authFrameOf(first.value) ?? undefined)
    const verdict = yield* attempt(() => route.authorize!(input.request, token))

    if (isFailure(verdict)) {
      yield* report(kernel, {
        t: 'failure',
        row: {
          request_id: trace.request_id,
          span_id: trace.span_id,
          tag: tagOf(verdict),
          message: verdict.message,
          status: 401,
          where: `socket:${route.path}`,
          causes: ['auth:first-frame'],
          ts: Date.now(),
        },
      })
      raw.close(4401, 'authorization required')
      return
    }

    principal = verdict.value ?? undefined

    // the frame that opened the session but was NOT an auth frame still belongs to the handler
    if (first !== 'grace' && !first.done && authFrameOf(first.value) === null) {
      pending = first
    }

    if (first !== 'grace' && first.done) {
      return
    }
  }

  const ctx = yield* contextFor(
    kernel,
    {
      trace,
      headers: input.headers,
      signal: input.signal,
      name: route.path,
      auth: principal,
    },
    input.actions,
  )

  const socket: EdgeDef.Socket = {
    id,
    params: input.params,
    headers: input.headers,
    url: input.url,
    ctx,

    messages: {
      *[Symbol.iterator]() {
        return {
          *next() {
            for (;;) {
              const step = pending ?? (yield* inbound.next())
              pending = null

              if (step.done) {
                return step
              }

              // an in-band auth frame is the transport's, never the handler's — and its token
              // must not land in the observe rows
              if (authFrameOf(step.value) !== null) {
                yield* frame('socket-in', { t: 'auth', token: '[redacted]' })
                continue
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
  yield* scoped(() => CtxRef.with(ctx, () => route.handler(socket)))
}
