import type { ActionContext } from 'server:core'
import { ACTION_CONTEXT } from 'server:core'
import { createChannel, each, operation, spawn, until, useContext, useScope } from 'std:effect'
import { asFailure, auto, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Msg } from '@nats-io/nats-core'

import { decodeBody, encodeResult } from '../internal/codec'

import { NatsTransportImpl } from './impl'

export const startAction = operation(function* () {
  const ctx = yield* useContext(NatsTransportImpl.context)
  if (ctx.isStarted) {
    return
  }

  const scope = yield* useScope()

  for (const entry of ctx.subjects.values()) {
    if (ctx.subscriptions.has(entry.subject)) {
      continue
    }

    const subOptions = entry.queueGroup ? { queue: entry.queueGroup } : undefined
    const sub = ctx.nc.subscribe(entry.subject, subOptions)
    ctx.subscriptions.set(entry.subject, sub)

    const channel = createChannel<Msg, void>()

    yield* spawn(function* () {
      const iter = sub[Symbol.asyncIterator]()
      while (true) {
        const next = yield* until(iter.next())
        if (next.done) {
          yield* channel.close()
          break
        }
        yield* channel.send(next.value)
      }
    })

    yield* spawn(function* () {
      for (const msg of yield* each(channel)) {
        if (ctx.isPaused) {
          msg.respond(encodeResult(fail('transport-paused', String(ctx.isPaused))))

          continue
        }

        try {
          const result = yield* scope.run(function* () {
            const body = decodeBody(msg.data)
            const actionCtx: ActionContext<unknown> = {
              _t: ACTION_CONTEXT,
              type: 'rpc',
              from: entry.subject,
              body,
              files: {},
              meta: {},
              req: {
                method: 'NATS',
                url: new URL(`nats:///${entry.subject}`),
                meta: {},
                files: {},
                body,
                raw: msg,
                rawBody: null,
              },
              res: { status: null, meta: {}, files: {}, body: null, raw: null },
            }
            return yield* (entry.action as AnyType)(actionCtx)
          })
          msg.respond(encodeResult(auto(result)))
        } catch (error) {
          msg.respond(encodeResult(asFailure(error)))
        }

        yield* each.next()
      }
    })
  }

  ctx.isStarted = true
})
