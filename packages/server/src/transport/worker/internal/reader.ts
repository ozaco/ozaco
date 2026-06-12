import { spawn, streamForEach } from 'std:effect'
import type { Result } from 'std:result'

import type { WorkerDef } from '../types'

import { handleBroadcast, handleDispatch, handleEmit } from './handlers'
import { registerInbound } from './subscribe'
import { failureFromPayload } from './wire'

const closeStream = (
  ctx: WorkerDef.Context,
  sid: string,
  reason: true | Result.Failure<unknown>,
) => {
  const queue = ctx.streams.get(sid)
  if (!queue) {
    return
  }
  ctx.streams.delete(sid)
  queue.close(reason)
}

const route = function* (
  ctx: WorkerDef.Context,
  endpoint: WorkerDef.Endpoint,
  env: WorkerDef.Envelope,
) {
  switch (env.kind) {
    case 'ready': {
      if (ctx.adoptWire) {
        ctx.wire = env.wire
        endpoint.wire = env.wire
      }
      endpoint.markReady()
      return
    }
    case 'reply': {
      const resolve = ctx.pending.get(env.cid)
      if (resolve) {
        ctx.pending.delete(env.cid)
        resolve(env.wire)
      }
      return
    }
    case 'chunk': {
      ctx.streams.get(env.sid)?.add(env.data)
      return
    }
    case 'end': {
      closeStream(ctx, env.sid, true)
      return
    }
    case 'error': {
      closeStream(ctx, env.sid, failureFromPayload(env.failure))
      return
    }
    case 'cancel': {
      const task = ctx.handlers.get(env.cid)
      if (task) {
        yield* task.halt()
      }
      return
    }
    case 'emit': {
      yield* handleEmit(ctx, env.req)
      return
    }
    case 'broadcast': {
      yield* handleBroadcast(ctx, env.req)
      return
    }
    case 'dispatch': {
      for (const sid of env.inputStreams ?? []) {
        registerInbound(ctx, sid)
      }
      ctx.handlers.set(env.cid, ctx.scope.run(handleDispatch(ctx, endpoint, env)))
      return
    }
    default: {
      break
    }
  }
}

export const startReader = (ctx: WorkerDef.Context, endpoint: WorkerDef.Endpoint) =>
  spawn(function* () {
    yield* streamForEach(endpoint.recv, next => route(ctx, endpoint, next as WorkerDef.Envelope))
  })
