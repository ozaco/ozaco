import type { TransportDef } from 'server:core'
import { CoreErrors, Transport } from 'server:core'
import type { Stream } from 'std:effect'
import { ensure, operation, useScope, withResolvers } from 'std:effect'
import { fail } from 'std:result'

import { getSelf, useWorkerContext } from './internal/context'
import { createEndpoints } from './internal/endpoint'
import { pumpStream } from './internal/pump'
import { startReader } from './internal/reader'
import { consumeInbound, registerInbound } from './internal/subscribe'
import { decodeValue, encodeValue, unwrapWire } from './internal/wire'
import type { WorkerDef } from './types'

const generateId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

export const WorkerTransport = Transport.implement({
  name: 'server/worker-transport',
  version: '0.0.0',

  *setup(options: WorkerDef.Options = {}) {
    const scope = yield* useScope()
    const endpoints = yield* createEndpoints(options)
    const adoptWire = options.script === undefined && options.endpoint === undefined

    const context: WorkerDef.Context = {
      name: options.name ?? 'server/worker-transport',
      priority: options.priority ?? 10,
      next: options.next ?? (() => false),
      wire: options.wire ?? 'structured',
      adoptWire,
      endpoints,
      pending: new Map(),
      streams: new Map(),
      handlers: new Map(),
      scope,
      rr: { index: 0 },
    }

    yield* Transport.actions.register(getSelf(), context)
    yield* ensure(function* () {
      for (const endpoint of endpoints) {
        endpoint.close()
      }
      yield* Transport.actions.unregister(getSelf())
    })

    for (const endpoint of endpoints) {
      yield* startReader(context, endpoint)
    }

    for (const endpoint of endpoints) {
      endpoint.post({ kind: 'ready', wire: context.wire })
    }

    return context
  },
}).build({
  dispatch: operation(function* (req: TransportDef.DispatchRequest) {
    const worker = yield* useWorkerContext()

    if (worker.endpoints.length === 0) {
      return yield* fail(CoreErrors.NotFound, 'worker transport has no endpoints')
    }

    const endpoint = worker.endpoints[worker.rr.index % worker.endpoints.length]!
    worker.rr.index += 1

    const cid = generateId('c')
    const inputs = (req.streams ?? []) as Stream<unknown, void>[]
    const inputStreams = inputs.length > 0 ? inputs.map(() => generateId('s')) : undefined
    const outputStream = generateId('s')

    const outputQueue = registerInbound(worker, outputStream)

    const envelope: WorkerDef.DispatchEnvelope = {
      kind: 'dispatch',
      cid,
      serviceName: req.serviceName,
      actionKey: req.actionKey,
      outputStream,
      ...(req.params === undefined
        ? {}
        : { params: yield* encodeValue(endpoint.wire, req.params) }),
      ...(inputStreams === undefined ? {} : { inputStreams }),
      ...(req.rawReq === undefined
        ? {}
        : { rawReq: yield* encodeValue(endpoint.wire, req.rawReq) }),
      ...(req.traceContext === undefined ? {} : { traceContext: req.traceContext }),
    }

    const reply = withResolvers<WorkerDef.Wire>('worker:reply')
    worker.pending.set(cid, reply.resolve)

    yield* ensure(function* () {
      worker.pending.delete(cid)
      worker.streams.delete(outputStream)
      endpoint.post({ kind: 'cancel', cid })
    })

    if (!endpoint.post(envelope)) {
      return yield* fail(
        CoreErrors.TransportDispatch,
        `worker endpoint failed to post dispatch for "${req.serviceName}.${req.actionKey}"`,
      )
    }
    if (inputStreams) {
      for (let i = 0; i < inputStreams.length; i++) {
        const sid = inputStreams[i]!
        const source = inputs[i]!
        worker.scope.run(function* () {
          try {
            yield* pumpStream(endpoint, sid, source)
          } catch {
            /* input pump errors surface to the peer as the stream's error close */
          }
        })
      }
    }

    const wire = yield* reply.operation

    if (wire._t === '__stream__') {
      return yield* consumeInbound(endpoint, outputQueue)
    }

    worker.streams.delete(outputStream)
    if (wire._t === '__failure__') {
      return yield* unwrapWire(wire)
    }
    return yield* decodeValue(endpoint.wire, wire.value)
  }),

  emit: operation(function* (req: TransportDef.EventRequest) {
    const worker = yield* useWorkerContext()
    const payload = yield* encodeValue(worker.wire, req)

    for (const endpoint of worker.endpoints) {
      endpoint.post({ kind: 'emit', req: payload })
    }
  }),

  broadcast: operation(function* (req: TransportDef.EventRequest) {
    const worker = yield* useWorkerContext()
    const payload = yield* encodeValue(worker.wire, req)

    for (const endpoint of worker.endpoints) {
      endpoint.post({ kind: 'broadcast', req: payload })
    }
  }),
})
