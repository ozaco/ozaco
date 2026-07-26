import type { Response, TransportDef } from 'server:core'
import { Broker, CoreErrors, DataType, Transport, lanesOf, valuesOf } from 'server:core'
import type { Operation, Stream } from 'std:effect'
import { ensure, operation, useScope, withResolvers } from 'std:effect'
import { fail, nothing } from 'std:result'

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
      rr: new Map(),
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

    const broker = yield* Broker.context.get()
    const services = broker
      ? [...new Set([...broker.services.values()].map(service => service.name))]
      : []

    for (const endpoint of endpoints) {
      endpoint.post({ kind: 'ready', wire: context.wire, services })
    }

    return context
  },
}).build({
  /**
   * No discovery yet, so the honest answer is `nothing()` for everything.
   *
   * `just(false)` is deliberately never returned from an incomplete view: a fast-fail built on
   * partial knowledge is a new outage mode, not a saving. A presence watcher can upgrade a known
   * claim to `just(true)` later; this stays the floor.
   */
  hosts: operation(function* () {
    return nothing()
  }),

  dispatch: operation(function* (req: TransportDef.DispatchRequest) {
    const worker = yield* useWorkerContext()

    const candidates = worker.endpoints.filter(
      endpoint => endpoint.services.size === 0 || endpoint.services.has(req.service),
    )
    if (candidates.length === 0) {
      return yield* fail(
        CoreErrors.NotFound,
        `worker transport has no endpoint hosting "${req.service}"`,
      )
    }

    const cursor = worker.rr.get(req.service) ?? 0
    const endpoint = candidates[cursor % candidates.length]!
    worker.rr.set(req.service, cursor + 1)

    const cid = generateId('c')
    const inputs = lanesOf(req.sources) as Stream<unknown, void>[]
    const inputStreams = inputs.length > 0 ? inputs.map(() => generateId('s')) : undefined
    const outputStream = generateId('s')

    const outputQueue = registerInbound(worker, outputStream)

    const envelope: WorkerDef.DispatchEnvelope = {
      kind: 'dispatch',
      cid,
      serviceName: req.service,
      actionKey: req.path,
      origin: String(req.origin).includes('external') ? 'external' : 'internal',
      meta: req.meta,
      ...(req.wire === undefined ? {} : { wire: req.wire }),
      outputStream,
      ...(valuesOf(req.sources).length === 0
        ? {}
        : { params: yield* encodeValue(endpoint.wire, valuesOf(req.sources)) }),
      ...(inputStreams === undefined ? {} : { inputStreams }),
      ...(req.contexts === undefined
        ? {}
        : { contexts: yield* encodeValue(endpoint.wire, req.contexts) }),
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
        `worker endpoint failed to post dispatch for "${req.service}.${req.path}"`,
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
      return {
        status: wire.status,
        meta: wire.meta ?? {},
        sources: [{ type: DataType.normal, value: yield* consumeInbound(endpoint, outputQueue) }],
      } satisfies Response
    }

    worker.streams.delete(outputStream)
    if (wire._t === '__failure__') {
      return yield* unwrapWire(wire) as Operation<never>
    }
    // The status and headers the owner set, rebuilt on this side rather than dropped.
    const value = yield* decodeValue(endpoint.wire, wire.value)

    return {
      status: wire.status,
      meta: wire.meta ?? {},
      sources: value === undefined ? [] : [{ type: DataType.normal, value }],
    } satisfies Response
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
