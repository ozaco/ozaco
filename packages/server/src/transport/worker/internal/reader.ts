import { CoreErrors } from 'server:core'
import { createQueue, spawn, streamForEach } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail } from 'std:result'

import type { WorkerDef } from '../types'

import { handleBroadcast, handleDispatch, handleEmit } from './handlers'
import { registerInbound } from './subscribe'
import { failureFromPayload, wireFailure } from './wire'

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
  ctx.owners.delete(sid)
  queue.close(reason)
}

/** Terminate one parts assembly: a file still open when its body ends was truncated — an error. */
const closeParts = (
  ctx: WorkerDef.Context,
  sid: string,
  reason: true | Result.Failure<unknown>,
) => {
  const assembly = ctx.parts.get(sid)
  if (!assembly) {
    return
  }
  ctx.parts.delete(sid)
  ctx.owners.delete(sid)
  if (assembly.file) {
    assembly.file.close(
      reason === true ? asFailure(fail('cancelled', 'parts body closed early')) : reason,
    )
    assembly.file = null
  }
  assembly.parts.close(reason)
}

// oxlint-disable-next-line max-params
const routeParts = (
  ctx: WorkerDef.Context,
  env: Extract<WorkerDef.Envelope, { kind: 'part-field' | 'part-file' | 'part-file-end' }>,
) => {
  const assembly = ctx.parts.get(env.sid)
  if (!assembly) {
    return
  }

  if (env.kind === 'part-field') {
    assembly.parts.add({ kind: 'field', name: env.name, value: env.value })
    return
  }

  if (env.kind === 'part-file') {
    const file = createQueue<Uint8Array, unknown>()
    assembly.file = file
    assembly.parts.add({
      kind: 'file',
      name: env.name,
      filename: env.filename,
      mediaType: env.mediaType,
      stream: {
        *[Symbol.iterator]() {
          return file
        },
      },
    })
    return
  }

  assembly.file?.close(true)
  assembly.file = null
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
      endpoint.services = new Set(env.services)
      endpoint.markReady()
      return
    }
    case 'reply': {
      const resolve = ctx.pending.get(env.cid)
      if (resolve) {
        ctx.pending.delete(env.cid)
        ctx.owners.delete(env.cid)
        resolve(env.wire)
      }
      return
    }
    case 'chunk': {
      // a chunk on a parts sid is the CURRENT file's bytes; on a plain sid, the lane's next value
      const assembly = ctx.parts.get(env.sid)
      if (assembly) {
        assembly.file?.add(env.data as Uint8Array)
        return
      }
      ctx.streams.get(env.sid)?.add(env.data)
      return
    }
    case 'end': {
      closeParts(ctx, env.sid, true)
      closeStream(ctx, env.sid, true)
      return
    }
    case 'error': {
      closeParts(ctx, env.sid, failureFromPayload(env.failure))
      closeStream(ctx, env.sid, failureFromPayload(env.failure))
      return
    }
    case 'part-field':
    case 'part-file':
    case 'part-file-end': {
      routeParts(ctx, env)
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
        ctx.owners.set(sid, endpoint)
      }
      if (env.partsStream !== undefined) {
        ctx.parts.set(env.partsStream, {
          parts: createQueue(),
          file: null,
        })
        ctx.owners.set(env.partsStream, endpoint)
      }
      ctx.handlers.set(env.cid, ctx.scope.run(handleDispatch(ctx, endpoint, env)))
      return
    }
    default: {
      break
    }
  }
}

/**
 * A dead endpoint answers everything it owes.
 *
 * The worker plane needs no keepalives: death is LOCAL and observable — the port closes, the recv
 * stream ends, and this sweep runs. Every reply still pending against the endpoint fails with an
 * answer instead of parking its caller forever, and every stream or parts body it was feeding
 * closes with a failure rather than going quiet mid-transfer.
 */
const settleEndpoint = (ctx: WorkerDef.Context, endpoint: WorkerDef.Endpoint) => {
  const gone = asFailure(
    fail(CoreErrors.TransportDispatch, 'worker endpoint closed before finishing'),
  )

  // deleting the CURRENT entry while iterating a Map is well-defined, and that is all this does
  for (const [key, owner] of ctx.owners) {
    if (owner !== endpoint) {
      continue
    }
    ctx.owners.delete(key)

    const resolve = ctx.pending.get(key)
    if (resolve) {
      ctx.pending.delete(key)
      resolve(wireFailure(gone))
    }

    closeStream(ctx, key, gone)
    closeParts(ctx, key, gone)
  }
}

export const startReader = (ctx: WorkerDef.Context, endpoint: WorkerDef.Endpoint) =>
  spawn(function* () {
    try {
      yield* streamForEach(endpoint.recv, next => route(ctx, endpoint, next as WorkerDef.Envelope))
    } finally {
      settleEndpoint(ctx, endpoint)
    }
  })
