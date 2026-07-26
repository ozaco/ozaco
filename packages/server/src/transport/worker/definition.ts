import type { Response, Source, TransportDef } from 'server:core'
import { Broker, CoreErrors, DataType, Transport, lanesOf, valuesOf } from 'server:core'
import type { Operation, Stream } from 'std:effect'
import { ensure, operation, race, sleep, useScope, withResolvers } from 'std:effect'
import { fail, nothing } from 'std:result'

import { getSelf, useWorkerContext } from './internal/context'
import { createEndpoints } from './internal/endpoint'
import { pumpPartsStream, pumpStream } from './internal/pump'
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
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      pending: new Map(),
      streams: new Map(),
      parts: new Map(),
      owners: new Map(),
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

    const partsSource = req.sources.find(source => source.type === DataType.multistream) as
      | Source.Lanes
      | undefined
    const partsStream = partsSource === undefined ? undefined : generateId('s')

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
      ...(partsStream === undefined ? {} : { partsStream }),
      ...(req.contexts === undefined
        ? {}
        : { contexts: yield* encodeValue(endpoint.wire, req.contexts) }),
    }

    const reply = withResolvers<WorkerDef.Wire>('worker:reply')
    worker.pending.set(cid, reply.resolve)
    worker.owners.set(cid, endpoint)
    worker.owners.set(outputStream, endpoint)

    /**
     * `adopted` mirrors the NATS carrier: once a `__stream__` reply is handed onward, the dispatch
     * returning is the BEGINNING of the transfer — cancelling the owner and unregistering the
     * output queue here was how a worker-relayed download died at chunk zero. The stream's own
     * close (reader-side) is what cleans an adopted lane up.
     */
    let adopted = false

    yield* ensure(function* () {
      worker.pending.delete(cid)
      worker.owners.delete(cid)
      if (!adopted) {
        worker.streams.delete(outputStream)
        worker.owners.delete(outputStream)
        endpoint.post({ kind: 'cancel', cid })
      }
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
    if (partsSource !== undefined && partsStream !== undefined) {
      worker.scope.run(function* () {
        try {
          yield* pumpPartsStream(endpoint, partsStream, partsSource.parts)
        } catch {
          /* ditto */
        }
      })
    }

    /**
     * A DEAD worker is settled immediately by the endpoint sweep; this timer covers the one that
     * is alive but never answers. `<= 0` disables it — the action TimeoutPolicy is then the sole
     * authority, exactly as on the NATS carrier.
     */
    const expired = function* (): Operation<WorkerDef.Wire> {
      yield* sleep(worker.requestTimeoutMs)
      return yield* fail(
        CoreErrors.Timeout,
        `no reply within ${worker.requestTimeoutMs}ms from the worker hosting "${req.service}.${req.path}"`,
      ) as Operation<never>
    }

    const wire =
      worker.requestTimeoutMs <= 0
        ? yield* reply.operation
        : yield* race([reply.operation, expired()])

    if (wire._t === '__stream__') {
      adopted = true
      // a LANE source, not a value: `adopt` on the caller's edge looks for `DataType.stream`, and
      // wrapping the feed as a normal value was how a worker-relayed download answered 204
      return {
        status: wire.status,
        meta: wire.meta ?? {},
        sources: [
          {
            type: DataType.stream,
            stream: (yield* consumeInbound(endpoint, outputQueue)) as Stream<unknown, unknown>,
          },
        ],
      } satisfies Response
    }

    worker.streams.delete(outputStream)
    worker.owners.delete(outputStream)
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

  /**
   * The worker plane has no groups, so a queued emit cannot pick "one member" — the closest honest
   * behaviour is to hand the event to every endpoint and CLAIM the delivery, so the local bus does
   * not echo a second copy on the emitting side. A real one-member split needs the wire transport.
   */
  emit: operation(function* (req: TransportDef.EventRequest) {
    const worker = yield* useWorkerContext()
    const payload = yield* encodeValue(worker.wire, req)

    for (const endpoint of worker.endpoints) {
      endpoint.post({ kind: 'emit', req: payload })
    }

    return 'handled' as const
  }),

  broadcast: operation(function* (req: TransportDef.EventRequest) {
    const worker = yield* useWorkerContext()
    const payload = yield* encodeValue(worker.wire, req)

    for (const endpoint of worker.endpoints) {
      endpoint.post({ kind: 'broadcast', req: payload })
    }
  }),
})
