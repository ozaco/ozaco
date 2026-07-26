import type { Operation } from 'std:effect'
import { useContext } from 'std:effect'

import type { DataType } from '../const'
import type { Action } from '../types/action'
import type { BrokerDef } from '../types/broker'
import type { Request } from '../types/common'
import type { ActionRequest, ActionResponse } from '../types/gateway'
import type { Service } from '../types/service'
import type { Source } from '../types/source'
import type { TracerDef } from '../types/tracer'

import {
  ActionContext,
  ActionRequestContext,
  RequestContext,
  ActionResponseContext,
  ActionSignalContext,
  CallContext,
  ServiceContext,
  TraceContext,
} from './context'

export function* useAction<T = Action>(): Operation<T> {
  return (yield* useContext(ActionContext)) as T
}

export function* useService<T = Service>(): Operation<T> {
  return (yield* useContext(ServiceContext)) as T
}

export function* useCall<T = BrokerDef.CallContext>(): Operation<T> {
  return (yield* useContext(CallContext)) as T
}

export function* useTrace<T = TracerDef.Context>(): Operation<T> {
  return (yield* useContext(TraceContext)) as T
}

export function* useRequest(): Operation<ActionRequest> {
  return yield* useContext(ActionRequestContext)
}

/**
 * The portable {@link Request} this action is serving — origin, address, meta, sources.
 *
 * Distinct from {@link useRequest}, which hands back the HTTP-shaped envelope an edge built and is
 * therefore only meaningful when one did. This answers the same thing whether the call arrived
 * in-process, over nats or from a worker, which is what makes an access check written against
 * `origin` mean the same in all three.
 */
export function* useCallRequest(): Operation<Request> {
  return yield* useContext(RequestContext)
}

/**
 * One source off the current call, by kind.
 *
 * It replaces `useStream()`, which could only answer the inbound-lane question and answered it with
 * a bare array whose order the caller had to know — a second copy of what the request already
 * carried. A call holds at most one source per kind, so asking by kind is unambiguous, and the
 * narrowing means a `socket` request gives back a socket rather than `unknown`.
 */
export function* useSource<TType extends DataType>(
  type: TType,
): Operation<Source.Of<TType> | undefined> {
  const request = yield* RequestContext.get()
  return request?.sources.find(source => source.type === type) as Source.Of<TType> | undefined
}

export function* useResponse(): Operation<ActionResponse> {
  return yield* useContext(ActionResponseContext)
}

export function* useActionSignal(): Operation<AbortSignal> {
  return yield* useContext(ActionSignalContext)
}
