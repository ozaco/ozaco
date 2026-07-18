import type { Operation, Stream } from 'std:effect'
import { useContext } from 'std:effect'
import { fail } from 'std:result'

import type { Action } from '../types/action'
import type { BrokerDef } from '../types/broker'
import type { ActionRequest, ActionResponse, MultipartPart } from '../types/gateway'
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
  MultipartContext,
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

/**
 * The stream of `multipart/form-data` parts for a route that opted into streaming via
 * `rest({ multipart: 'stream' })`. Iterate it in order (`each`) and fully consume each file part's
 * `stream` before advancing. Fails if the current request is not a streaming multipart route.
 */
export function* useMultipart(): Operation<Stream<MultipartPart, unknown>> {
  const stream = yield* MultipartContext.get()
  if (!stream) {
    return yield* fail(
      'gateway/multipart',
      'useMultipart() requires a multipart/form-data body on a route configured with rest({ multipart: "stream" })',
    )
  }
  return stream
}
