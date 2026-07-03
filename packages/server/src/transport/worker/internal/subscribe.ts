import type { Queue, Stream } from 'std:effect'
import { createQueue, operation } from 'std:effect'
import type { Result } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import type { WorkerDef } from '../types'

import { streamOf } from './stream'

type InboundQueue = Queue<unknown, true | Result.Failure<unknown>>

export const registerInbound = (ctx: WorkerDef.Context, sid: string): InboundQueue => {
  const queue = createQueue<unknown, true | Result.Failure<unknown>>()
  ctx.streams.set(sid, queue)
  return queue
}

export const consumeInbound = operation(function* (
  endpoint: WorkerDef.Endpoint,
  queue: InboundQueue,
) {
  if (endpoint.wire === 'codec') {
    return (yield* JsonCodec.actions.decodeStream(
      streamOf(queue) as Stream<Uint8Array, unknown>,
    )) as Stream<unknown, true | Result.Failure<unknown>>
  }

  return streamOf(queue)
})

export const captureInputStreams = operation(function* (
  ctx: WorkerDef.Context,
  endpoint: WorkerDef.Endpoint,
  sids: readonly string[],
) {
  const streams: Stream<unknown, void>[] = []
  for (const sid of sids) {
    const queue = ctx.streams.get(sid) ?? registerInbound(ctx, sid)
    streams.push((yield* consumeInbound(endpoint, queue)) as Stream<unknown, void>)
  }
  return streams
})
