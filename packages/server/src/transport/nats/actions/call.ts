import type { Action, ActionContext } from 'server:core'
import { ACTION_CONTEXT, ActionContextRef, createEmptyReq, createEmptyRes } from 'server:core'
import { operation, until, useContext } from 'std:effect'
import { getService } from 'std:plugin'
import type { AnyType } from 'std:shared'
import { isFunction } from 'std:shared'

import { decodeResult, encodeBody } from '../internal/codec'

import { NatsTransportImpl } from './impl'

const DEFAULT_TIMEOUT = 5000

export const callAction = operation(function* (
  action: Action,
  body: unknown,
  parent?: ActionContext<unknown>,
) {
  const ctx = yield* useContext(NatsTransportImpl.context)
  const inherited = parent ?? (yield* ActionContextRef.get())

  const rawAction = yield* getService(action)

  const subject = `${rawAction.context.name}#${rawAction.key}`

  const local = typeof subject === 'string' ? ctx.subjects.get(subject) : undefined

  if ((typeof subject !== 'string' && !isFunction(subject)) || local) {
    const internal: ActionContext<unknown> = {
      _t: ACTION_CONTEXT,
      type: 'internal',
      from: subject ?? (action as Action & { title?: string }).title ?? 'internal',
      body,
      files: inherited?.files ?? {},
      meta: inherited?.meta ?? {},
      req: inherited?.req ?? createEmptyReq(body),
      res: inherited?.res ?? createEmptyRes(),
    }
    return yield* (action as AnyType)(internal)
  }

  const msg = yield* until(
    ctx.nc.request(subject, encodeBody(body), {
      timeout: ctx.options.requestTimeoutMs ?? DEFAULT_TIMEOUT,
    }),
  )

  return yield* decodeResult(msg.data)
})
