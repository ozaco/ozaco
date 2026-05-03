import type { Action, ActionRequest, ActionResponse } from 'server:core'
import {
  ActionRawRequestContext,
  ActionRawResponseContext,
  ActionRequestContext,
  ActionResponseContext,
  createEmptyReq,
  createEmptyRes,
} from 'server:core'
import { operation, until, useContext } from 'std:effect'
import { getService } from 'std:plugin'
import type { AnyType } from 'std:shared'
import { isFunction } from 'std:shared'

import { decodeResult, encodeBody } from '../internal/codec'

import { NatsTransportImpl } from './impl'

const DEFAULT_TIMEOUT = 5000

export const callAction: AnyType = operation(function* (
  action: Action,
  body: unknown,
  parent?: ActionRequest,
) {
  const ctx = yield* useContext(NatsTransportImpl.context)
  const inheritedReq = parent ?? (yield* ActionRequestContext.get())
  const inheritedRes = (yield* ActionResponseContext.get()) ?? null
  const inheritedRawReq = (yield* ActionRawRequestContext.get()) ?? null
  const inheritedRawRes = (yield* ActionRawResponseContext.get()) ?? null

  const rawAction = yield* getService(action)

  const subject = `${rawAction.context.name}#${rawAction.key}`

  const local = typeof subject === 'string' ? ctx.subjects.get(subject) : undefined

  if ((typeof subject !== 'string' && !isFunction(subject)) || local) {
    const req: ActionRequest = inheritedReq
      ? // oxlint-disable-next-line oxc/no-rest-spread-properties
        { ...inheritedReq, type: 'internal', from: subject ?? 'internal' }
      : // oxlint-disable-next-line oxc/no-rest-spread-properties
        { ...createEmptyReq(), from: subject ?? 'internal' }
    const res: ActionResponse = inheritedRes ?? createEmptyRes()

    const result: AnyType = yield* ActionRequestContext.with(req, function* () {
      return yield* ActionResponseContext.with(res, function* () {
        return yield* ActionRawRequestContext.with(inheritedRawReq, function* () {
          return yield* ActionRawResponseContext.with(inheritedRawRes, function* () {
            return yield* (action as AnyType)(body)
          })
        })
      })
    })
    return result
  }

  const msg = yield* until(
    ctx.nc.request(subject, encodeBody(body), {
      timeout: ctx.options.requestTimeoutMs ?? DEFAULT_TIMEOUT,
    }),
  )

  const decoded: AnyType = yield* decodeResult(msg.data)
  return decoded
})
