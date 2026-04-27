import { operation, until, useContext } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Action, ActionContext } from 'server:core'
import { ACTION_CONTEXT, ActionContextRef, createEmptyReq, createEmptyRes } from 'server:core'

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

  const local = ctx.byAction.get(action)

  if (local) {
    const internal: ActionContext<unknown> = {
      _t: ACTION_CONTEXT,
      type: 'internal',
      from: local.subject,
      body,
      files: inherited?.files ?? {},
      meta: inherited?.meta ?? {},
      req: inherited?.req ?? createEmptyReq(body),
      res: inherited?.res ?? createEmptyRes(),
    }
    return yield* (action as AnyType)(internal)
  }

  const subject = (action as Action & { _subject?: string })._subject
  if (!subject) {
    return yield* fail(
      'transport',
      'action not registered with transport — call Transport.actions.mount(service) first',
    )
  }

  const msg = yield* until(
    ctx.nc.request(subject, encodeBody(body), {
      timeout: ctx.options.requestTimeoutMs ?? DEFAULT_TIMEOUT,
    }),
  )

  return yield* decodeResult(msg.data)
})
