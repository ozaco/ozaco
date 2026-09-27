/**
 * A gateway's edge answering for a service another node hosts: the owner's `ctx.reply` (status,
 * `Location`) rides the carrier reply back and shapes the gateway's response, the `remote: …`
 * cause a carrier hop adds to a failure (node ids, span ids) stays out of an untrusted caller's
 * envelope — it is kept in telemetry and handed to a caller the node trusts; the kernel's
 * breadcrumbs and the plugin runtime's labels are plain string causes every caller gets — and the
 * realtime watch the gateway serves for such a service belongs to that service in telemetry, not
 * to the node.
 */
import { useDb } from 'db:core'
import type { ObserveDef, ServerDef, ServiceDef } from 'server:core'
import { action, createServer, ObserveExporter, service } from 'server:core'
import { crud } from 'server:plugins'
import type { Operation } from 'std:effect'
import { createQueue, fork, run, scoped, sleep, until } from 'std:effect'
import { fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { NetworkCarrier } from 'server:impl/carrier/network'
import { BunEdge } from 'server:impl/edge/bun'
import { createLink, MemoryTransport } from 'transport:impl/memory'
import { z } from 'zod'

import { LABELS, storage, testSchema, todosTable } from '../helpers'

const jobs = service('jobs', {
  /** 202 declared, the `location` set per call — like the demo's `jobs.submit`. */
  submit: action.mutation(
    {
      input: z.object({ name: z.string() }),
      output: z.object({ id: z.string() }),
      status: 202,
      headers: { 'cache-control': 'no-store' },
    },
    function* ({ input, ctx }) {
      ctx.reply({ headers: { location: `/jobs/status/${input.name}` } })
      return { id: input.name }
    },
  ),

  /** the status set per call too — and a header no `Headers` takes, dropped on the way. */
  create: action.mutation(
    { input: z.object({ name: z.string() }), output: z.object({ id: z.string() }) },
    function* ({ input, ctx }) {
      ctx.reply({
        status: 201,
        headers: { location: `/jobs/${input.name}`, 'bad header': 'dropped' },
      })
      return { id: input.name }
    },
  ),

  kaput: action.query({}, function* () {
    return yield* fail('jobs.kaput', 'the job is kaput', 'at: the storage step')
  }),
})

let installs = 0

/** Every observe event of the node it is installed on. */
const memoryExporter = () => {
  installs += 1
  const events: ObserveDef.Event[] = []

  const plugin = ObserveExporter.implement<ObserveDef.ExporterContext, []>({
    name: `test/gateway-exporter-${installs}`,
    version: '1.0.0',
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
  const logs = (): TraceDef.LogData[] =>
    events.flatMap(event => (event.t === 'log' ? [event.log] : []))
  const resourceOf = (data: TraceDef.SpanData): ObserveDef.Resource =>
    events.find(event => event.t === 'span' && event.span === data)!.resource

  return { plugin, spans, logs, resourceOf }
}

type Exporter = ReturnType<typeof memoryExporter>

interface Nodes {
  readonly gateway: Exporter
  readonly owner: Exporter
}

/** A service node hosting `jobs` and a gateway serving its edge; `body` gets the gateway's url. */
const gatewayOf = async (
  options: {
    readonly observeOwner?: boolean
    readonly gateway?: Partial<ServerDef.Options>
    readonly services?: readonly ServiceDef.Service[]
  },
  body: (url: string) => Operation<void>,
): Promise<Nodes> => {
  const services = options.services ?? [jobs]
  const link = createLink()
  const gateway = memoryExporter()
  const owner = memoryExporter()

  unwrap(
    await run(function* () {
      const ready = createQueue<void, void>()
      const worker = yield* fork(() =>
        scoped(function* () {
          yield* storage()
          yield* MemoryTransport.use({ prefix: 'gw', link })
          const app = yield* createServer({
            services,
            carrier: NetworkCarrier,
            role: 'service',
            name: 'app',
            instance: 'owner',
            plugins: options.observeOwner === false ? [] : [owner.plugin],
          })
          yield* app.start()
          ready.add(undefined)
          yield* sleep(60_000)
        }),
      )
      yield* ready.next()
      yield* scoped(function* () {
        yield* storage()
        yield* MemoryTransport.use({ prefix: 'gw', link })
        const server = yield* createServer({
          services,
          edge: BunEdge,
          carrier: NetworkCarrier,
          role: 'gateway',
          name: 'app',
          instance: 'gw',
          listen: { port: 0 },
          plugins: [gateway.plugin],
          ...options.gateway,
        })
        const info = yield* server.start()
        yield* body(info.url!)
        yield* server.stop()
      })
      yield* worker.halt()
    }),
  )

  return { gateway, owner }
}

const post = (url: string, value: unknown, headers: Record<string, string> = {}) =>
  until(
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(value),
    }),
  )

describe('gateway — the owner shapes the reply', () => {
  it("jobs.submit through the gateway answers 202 with the owner's Location", async () => {
    let status = 0
    let location = null as string | null
    let cache = null as string | null

    const { gateway, owner } = await gatewayOf({}, function* (url) {
      const response = yield* post(`${url}/jobs/submit`, { name: 'j-1' })
      status = response.status
      location = response.headers.get('location')
      cache = response.headers.get('cache-control')
      expect(yield* until(response.json())).toEqual({ id: 'j-1' })
    })

    expect(status).toBe(202)
    expect(location).toBe('/jobs/status/j-1')
    expect(cache).toBe('no-store')

    // both sides of the hop stand for the status the edge answered with
    const client = gateway.spans().find(span => span.name === 'jobs.submit')!
    const server = owner.spans().find(span => span.name === 'jobs.submit')!
    expect(client.attributes['rpc.response.status_code']).toBe('202')
    expect(server.attributes['rpc.response.status_code']).toBe('202')
  })

  it('a status set per call crosses too; a header no response takes is dropped, not fatal', async () => {
    let status = 0
    let location = null as string | null

    const { gateway, owner } = await gatewayOf({}, function* (url) {
      const response = yield* post(`${url}/jobs/create`, { name: 'j-2' })
      status = response.status
      location = response.headers.get('location')
      yield* until(response.arrayBuffer())
    })

    expect(status).toBe(201)
    expect(location).toBe('/jobs/j-2')
    expect(gateway.spans().find(span => span.name === 'jobs.create')!.attributes).toMatchObject({
      'rpc.response.status_code': '201',
    })
    expect(owner.spans().find(span => span.name === 'jobs.create')!.attributes).toMatchObject({
      'rpc.response.status_code': '201',
    })
  })
})

describe('gateway — remote causes stay home', () => {
  const kaput = function* (url: string, headers: Record<string, string> = {}) {
    const response = yield* until(fetch(`${url}/jobs/kaput`, { headers }))
    expect(response.status).toBe(500)
    return ((yield* until(response.json())) as AnyType).error
  }

  /**
   * The string causes of the answer, `remote` (the decoder's `remote: …` cause) where it goes:
   * the handler's own, the owner's breadcrumb (the span its dispatch ran in, the request), then
   * the plugin runtime's labels of the gateway's hop (transport request, carrier send) and of
   * its edge dispatch.
   */
  const causesOf = (envelope: AnyType, span: TraceDef.SpanData, remote: unknown[] = []) => [
    'at: the storage step',
    `action:jobs.kaput span:${span.context.spanId} req:${envelope.requestId}`,
    ...remote,
    ...LABELS.transport,
    ...LABELS.carrier,
    ...LABELS.dispatch,
  ]

  /** The `jobs.kaput` span of `kind` an exporter saw. */
  const spanOf = (exporter: Exporter, kind: TraceDef.SpanKind) =>
    exporter.spans().find(span => span.name === 'jobs.kaput' && span.kind === kind)!

  it('an untrusted caller never sees the `remote: …` cause (node id, span id)', async () => {
    let envelope: AnyType

    const { owner } = await gatewayOf({}, function* (url) {
      envelope = yield* kaput(url)
    })

    expect(envelope).toMatchObject({ error: 'jobs.kaput', message: 'the job is kaput' })
    // the location labels are plain string causes: every caller gets them
    expect(envelope.causes).toEqual(causesOf(envelope, spanOf(owner, 'server')))
    expect(JSON.stringify(envelope)).not.toContain('app@0.0.0#owner')
  })

  it('a caller the node trusts — or `errors.expose: chain` — gets it', async () => {
    const envelopes: AnyType[] = []

    const trusting = await gatewayOf(
      { gateway: { trace: { trust: request => request.headers.get('x-proxy') === 'yes' } } },
      function* (url) {
        envelopes.push(yield* kaput(url, { 'x-proxy': 'yes' }))
      },
    )
    const exposing = await gatewayOf({ gateway: { errors: { expose: 'chain' } } }, function* (url) {
      envelopes.push(yield* kaput(url))
    })

    for (const [envelope, { owner }] of [
      [envelopes[0], trusting],
      [envelopes[1], exposing],
    ] as const) {
      // the owner's breadcrumb came over the wire; the decoder appends where it came from
      const span = spanOf(owner, 'server')
      expect(envelope.causes).toEqual(
        causesOf(envelope, span, [
          `remote: jobs.kaput @ app@0.0.0#owner span ${span.context.spanId.slice(0, 8)}`,
        ]),
      )
    }
  })

  it('telemetry keeps it: the gateway records the failure with its `remote: …` cause', async () => {
    let envelope: AnyType

    // an owner that records nothing: the gateway is where the failure is recorded
    const { gateway } = await gatewayOf({ observeOwner: false }, function* (url) {
      envelope = yield* kaput(url)
    })

    // the owner traced nothing: its dispatch ran in the gateway's CLIENT span, passed through
    expect(envelope.causes).toEqual(causesOf(envelope, spanOf(gateway, 'client')))

    const record = gateway.logs().find(log => log.attributes['exception.type'] === 'jobs.kaput')
    expect(record).toBeDefined()
    expect(JSON.stringify(record!.attributes)).toContain('remote: jobs.kaput @ app@0.0.0#owner')
  })
})

describe('gateway — realtime belongs to the owning service', () => {
  it('the watch and its pushes a gateway serves carry service.name of the resource', async () => {
    const todos = crud(todosTable, {
      *after({ op, output }) {
        const frame = output as AnyType

        // a failing push is exported (`crud.delta` records only its failures)
        if (op === 'watch' && frame.t === 'delta' && frame.added[0]?.title === 'explode') {
          return yield* fail('todos.exploded', 'the delta exploded')
        }
      },
    })
    const frames: AnyType[] = []

    const { gateway } = await gatewayOf({ services: [todos] }, function* (url) {
      const ws = new WebSocket(`${url.replace('http', 'ws')}/todos/_realtime`)
      ws.addEventListener('message', event => frames.push(JSON.parse(String(event.data))))
      yield* until(
        new Promise(resolve => {
          ws.addEventListener('open', resolve)
        }),
      )

      const wait = (count: number) =>
        until(
          new Promise<void>((resolve, reject) => {
            const deadline = Date.now() + 3000
            const poll = () =>
              frames.length >= count
                ? resolve()
                : Date.now() > deadline
                  ? reject(new Error(`frames: ${JSON.stringify(frames)}`))
                  : setTimeout(poll, 10)
            poll()
          }),
        )

      ws.send(JSON.stringify({ t: 'watch', id: 'w1' }))
      yield* wait(1)

      // the gateway's own storage feeds its watch: a write that makes the push fail
      const db = yield* useDb(testSchema)
      yield* db.insert('todos', { title: 'explode', done: false })
      yield* wait(2)
      ws.close()
    })

    expect(frames.map(frame => frame.t)).toEqual(['sync', 'error'])

    const watch = gateway.spans().find(span => span.name === 'watch todos')!
    const push = gateway.spans().find(span => span.name === 'crud.delta todos')!
    const frame = gateway.spans().find(span => span.context.spanId === watch.parent?.spanId)!

    // the resource's own service — not the node's name (`app`)
    for (const data of [watch, push]) {
      expect(data.service).toBe('todos')
      expect(gateway.resourceOf(data)['service.name']).toBe('todos')
      expect(gateway.resourceOf(data)['service.instance.id']).toBe('gw')
    }

    // the db spans under the watch inherit it; the frame span stays the edge's (the node's)
    for (const child of gateway
      .spans()
      .filter(span => span.parent?.spanId === watch.context.spanId)) {
      expect(gateway.resourceOf(child)['service.name']).toBe('todos')
    }
    expect(frame.name).toBe('WS /todos/_realtime')
    expect(gateway.resourceOf(frame)['service.name']).toBe('app')
  })
})
