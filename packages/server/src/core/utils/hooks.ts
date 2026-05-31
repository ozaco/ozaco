import type { Operation, Stream } from 'std:effect'
import { useContext } from 'std:effect'

import type { Action } from '../types/action'
import type { BrokerDef } from '../types/broker'
import type { ActionRequest, ActionResponse } from '../types/gateway'
import type { Service } from '../types/service'
import type { TracerDef } from '../types/tracer'

import {
  ActionContext,
  ActionRawRequestContext,
  ActionRawResponseContext,
  ActionRequestContext,
  ActionResponseContext,
  ActionSignalContext,
  CallContext,
  ServiceContext,
  StreamContext,
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

export function* useStream<T = unknown>() {
  return (yield* useContext(StreamContext)) as Stream<T, void>[]
}

export function* useRequest(): Operation<ActionRequest> {
  return yield* useContext(ActionRequestContext)
}

export function* useResponse(): Operation<ActionResponse> {
  return yield* useContext(ActionResponseContext)
}

export function* useRawRequest<T = unknown>(): Operation<T> {
  return (yield* useContext(ActionRawRequestContext)) as T
}

export function* useRawResponse<T = unknown>(): Operation<T> {
  return (yield* useContext(ActionRawResponseContext)) as T
}

export function* useActionSignal(): Operation<AbortSignal> {
  return yield* useContext(ActionSignalContext)
}
