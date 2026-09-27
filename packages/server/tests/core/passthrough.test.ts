/**
 * A NON-observing edge in front of an observing service (a gateway that records nothing): it
 * passes a continued caller's context through to the carrier, so the service records the failure
 * in the CALLER's trace, and the failure it answers names where it was answered — the decoder's
 * `remote: <operation> @ <service> span <id8>` cause, a plain string of the envelope's `causes`
 * for a caller the gateway TRUSTS (`trace.trust`; the self-asserted `ozaco=1` is not enough: node
 * ids are the cluster's own — the kernel's breadcrumbs and the plugin runtime's labels are plain
 * string causes every caller gets). That cause names 8 hex digits of the span, no whole span id:
 * the gateway has no span of its own and none it could name, so no caller gets a
 * `traceresponse`.
 */
import type { ObserveDef } from 'server:core'
import { action, createServer, Edge, HEADERS, ObserveExporter, service } from 'server:core'
import type { Operation } from 'std:effect'
import { createQueue, fork, run, scoped, sleep, until } from 'std:effect'
import { fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { NetworkCarrier } from 'server:impl/carrier/network'
import { BunEdge } from 'server:impl/edge/bun'
import { createLink, MemoryTransport } from 'transport:impl/memory'

import { LABELS, storage } from '../helpers'

const TRACE = '0af7651916cd43dd8448eb211c80319c'
const CALLER = 'b7ad6b7169203331'

const math = service('math', {
  kaput: action.query({}, function* () {
    return yield* fail('math.kaput', 'the math is kaput')
  }),
})

const gate = service('gate', {
  relay: action.query({}, function* ({ ctx }) {
    return yield* ctx.call(math, 'kaput')
  }),
})

/** Every observed event of the node it is installed on. */
const memoryExporter = () => {
  const events: ObserveDef.Event[] = []
  const plugin = ObserveExporter.implement<ObserveDef.ExporterContext, []>({
    name: 'test/passthrough-memory',
    version: '0.0.0',
    *setup() {
      return { exporter: 'memory' }
    },
  }).build({
    *export(event: ObserveDef.Event) {
      events.push(event)
    },
    *start() {},
    *flush() {},
  })

  const spans = (): TraceDef.SpanData[] =>
    events.flatMap(event => (event.t === 'span' ? [event.span] : []))
  const exceptions = (): TraceDef.LogData[] =>
    events.flatMap(event =>
      event.t === 'log' && event.log.attributes['exception.type'] !== undefined ? [event.log] : [],
    )

  return { plugin, spans, exceptions }
}

/** Node B (observing) hosts `math`; node A (observing NOTHING) hosts `gate` behind its edge. */
const gateway = async (body: () => Operation<void>, trust?: (request: Request) => boolean) => {
  const link = createLink()
  const sink = memoryExporter()

  unwrap(
    await run(function* () {
      const ready = createQueue<void, void>()
      const remote = yield* fork(() =>
        scoped(function* () {
          yield* storage()
          yield* MemoryTransport.use({ prefix: 'app', link })
          yield* createServer({
            services: [math],
            carrier: NetworkCarrier,
            name: 'app',
            instance: 'b',
            plugins: [sink.plugin],
          })
          ready.add(undefined)
          yield* sleep(60_000)
        }),
      )
      yield* ready.next()
      yield* scoped(function* () {
        yield* storage()
        yield* MemoryTransport.use({ prefix: 'app', link })
        const server = yield* createServer({
          services: [gate],
          carrier: NetworkCarrier,
          edge: BunEdge,
          name: 'app',
          instance: 'a',
          timeoutMs: 2000,
          ...(trust ? { trace: { trust } } : {}),
        })
        yield* server.start({ port: 0 })
        yield* sleep(50)
        yield* body()
        yield* server.stop()
      })
      yield* remote.halt()
    }),
  )

  return sink
}

/**
 * The location causes a relayed failure carries, in order: the owner's breadcrumb (its SERVER
 * span, the request), the plugin runtime's labels of the gateway's hop (transport request,
 * carrier send, kernel call), the gateway's own breadcrumb (`relayed`: its dispatch span — the
 * caller's, passed through — or none) and the edge dispatch's labels.
 */
const locations = (
  answer: { body: AnyType },
  owner: TraceDef.SpanData,
  relayed: string,
): string[] => {
  const request = answer.body.error.requestId

  return [
    `action:math.kaput span:${owner.context.spanId} req:${request}`,
    ...LABELS.transport,
    ...LABELS.carrier,
    ...LABELS.call,
    `action:gate.relay ${relayed}req:${request}`,
    ...LABELS.dispatch,
  ]
}

const relay = function* (headers: Record<string, string>) {
  const response = yield* Edge.actions.handle(new Request('http://edge/gate/relay', { headers }))
  const body = yield* until(response.json())

  return { status: response.status, headers: response.headers, body }
}

describe('pass-through edge — a failure recorded behind it', () => {
  it('a continued caller is answered in its own trace; no traceresponse, no cluster names', async () => {
    let continued: { status: number; headers: Headers; body: AnyType } | null = null
    let stranger: { status: number; headers: Headers; body: AnyType } | null = null

    const sink = await gateway(function* () {
      continued = yield* relay({
        traceparent: `00-${TRACE}-${CALLER}-01`,
        tracestate: 'ozaco=1',
      })
      stranger = yield* relay({ traceparent: `00-${TRACE}-${CALLER}-01` })
    })

    expect(continued!.status).toBe(500)
    expect(stranger!.status).toBe(500)

    // the service recorded the failure ONCE, on its SERVER span in the caller's trace
    const recorded = sink.exceptions().filter(log => log.context?.traceId === TRACE)
    expect(recorded).toHaveLength(1)
    const owner = sink.spans().find(data => data.context.spanId === recorded[0]!.context?.spanId)!
    expect(owner).toMatchObject({ name: 'math.kaput', kind: 'server' })
    expect(owner.parent?.spanId).toBe(CALLER)

    // `ozaco=1` is self-asserted: the answer carries no `remote: …` cause (the node that
    // answered) — its plain string causes are the location labels alone
    const alone = sink
      .spans()
      .find(data => data.name === 'math.kaput' && data.context.traceId !== TRACE)!
    expect(continued!.body.error.causes).toEqual(locations(continued!, owner, `span:${CALLER} `))
    expect(stranger!.body.error.causes).toEqual(locations(stranger!, alone, ''))

    // the gateway traced nothing: no traceresponse (the breadcrumbs above still name the spans
    // the dispatches ran in, as the kernel always did)
    expect(continued!.headers.get(HEADERS.traceresponse)).toBeNull()

    // a caller the gateway does not continue (link mode): its context never went on, the
    // service recorded in a trace of its own — nothing to name either
    expect(stranger!.headers.get(HEADERS.traceresponse)).toBeNull()
  })

  it('a caller the gateway trusts learns where it was answered (remote cause)', async () => {
    let trusted: { status: number; headers: Headers; body: AnyType } | null = null

    const sink = await gateway(
      function* () {
        trusted = yield* relay({ traceparent: `00-${TRACE}-${CALLER}-01`, 'x-proxy': 'yes' })
      },
      request => request.headers.get('x-proxy') === 'yes',
    )

    expect(trusted!.status).toBe(500)

    const recorded = sink.exceptions().find(log => log.context?.traceId === TRACE)
    const owner = sink.spans().find(data => data.context.spanId === recorded!.context?.spanId)!

    // the owner's operation, node and span (8 digits) — and still no traceresponse
    const [breadcrumb, ...rest] = locations(trusted!, owner, `span:${CALLER} `)
    expect(trusted!.body.error.causes).toEqual([
      breadcrumb,
      `remote: math.kaput @ app@0.0.0#b span ${owner.context.spanId.slice(0, 8)}`,
      ...rest,
    ])
    expect(trusted!.headers.get(HEADERS.traceresponse)).toBeNull()
  })
})
