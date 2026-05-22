import type { Operation, Stream } from 'std:effect'
import { useContext } from 'std:effect'

import type { Action } from '../types/action'
import type { BrokerDef } from '../types/broker'
import type { Service } from '../types/service'
import type { TracerDef } from '../types/tracer'

import { ActionContext, CallContext, ServiceContext, StreamContext, TraceContext } from './context'

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
