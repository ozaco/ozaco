import type { Action, ActionRequest, ActionResponse, CallOptions } from 'server:core'
import {
  ActionRawRequestContext,
  ActionRawResponseContext,
  ActionRequestContext,
  ActionResponseContext,
  ActionSignalContext,
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
  options?: CallOptions,
) {
  const ctx = yield* useContext(NatsTransportImpl.context)
  const parent = options?.parent
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
            if (options?.signal) {
              return yield* ActionSignalContext.with(options.signal, function* () {
                return yield* (action as AnyType)(body)
              })
            }
            return yield* (action as AnyType)(body)
          })
        })
      })
    })
    return result
  }

  const timeoutMs = options?.timeoutMs ?? ctx.options.requestTimeoutMs ?? DEFAULT_TIMEOUT
  const msg = yield* until(
    ctx.nc.request(subject, encodeBody(body), {
      timeout: timeoutMs,
    }),
  )

  const decoded: AnyType = yield* decodeResult(msg.data)
  return decoded
})
