import type { ActionRequest, ActionResponse } from 'server:core'
import {
  ActionRawRequestContext,
  ActionRawResponseContext,
  ActionRequestContext,
  ActionResponseContext,
  ActionSignalContext,
} from 'server:core'
import { createChannel, each, operation, spawn, until, useContext, useScope } from 'std:effect'
import { asFailure, auto, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Msg } from '@nats-io/nats-core'

import { NatsErrorCode } from '../error-codes'
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
          msg.respond(encodeResult(fail(NatsErrorCode.TransportPaused, String(ctx.isPaused))))

          continue
        }

        try {
          const result = yield* scope.run(function* () {
            const body = decodeBody(msg.data)
            const req: ActionRequest = {
              type: 'rpc',
              method: 'NATS',
              url: new URL(`nats:///${entry.subject}`),
              meta: {},
              files: {},
              rawBody: null,
            }
            const res: ActionResponse = { status: null, meta: {}, files: {}, body: null }

            const controller = new AbortController()
            return yield* ActionRequestContext.with(req, function* () {
              return yield* ActionResponseContext.with(res, function* () {
                return yield* ActionRawRequestContext.with(msg, function* () {
                  return yield* ActionRawResponseContext.with(null, function* () {
                    return yield* ActionSignalContext.with(controller.signal, function* () {
                      return yield* (entry.action as AnyType)(body)
                    })
                  })
                })
              })
            })
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
