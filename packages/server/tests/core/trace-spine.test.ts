/**
 * The kernel's telemetry spine on std:trace, end to end: what a local call, a nested call, a
 * carrier hop, an emit and a handler's log lines become — as the SINKS see them (an in-memory
 * `ObserveExporter` per node: every `{ t: 'span' | 'log', …, resource }` the kernel reports).
 */
import type { Change } from 'db:core'
import { useDb } from 'db:core'
import type { ObserveDef, ServerDef } from 'server:core'
import {
  action,
  createServer,
  ObserveExporter,
  Server,
  ServerErrors,
  service,
  stream,
} from 'server:core'
import { edgeSpan } from 'server:internal'
import type { Operation } from 'std:effect'
import { attempt, createQueue, fork, race, run, scoped, sleep, useContext } from 'std:effect'
import type { LoggerDef } from 'std:logger'
import { DefaultLogger, Logger, LoggerTransport, LogLevel } from 'std:logger'
import { definePlugin } from 'std:plugin'
import { fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { enableTracing, inject, isTracing, suppressed, Tracer } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { NetworkCarrier } from 'server:impl/carrier/network'
import { createLink, MemoryTransport } from 'transport:impl/memory'
import { z } from 'zod'

import { LABELS, storage, testSchema, todos } from '../helpers'

let installs = 0

/** An in-memory exporter: every observed event of the node it is installed on. */
const memoryExporter = () => {
  installs += 1
  const events: ObserveDef.Event[] = []
  const calls = { start: 0, flush: 0 }

  const plugin = ObserveExporter.implement<ObserveDef.ExporterContext, []>({
    name: `test/memory-exporter-${installs}`,
    version: '1.0.0',
    *setup() {
      return { exporter: 'memory' }
    },
  }).build({
    *export(event: ObserveDef.Event) {
      events.push(event)
    },
    *start() {
      calls.start += 1
    },
    *flush() {
      calls.flush += 1
    },
  })

  const spans = (): TraceDef.SpanData[] =>
    events.flatMap(event => (event.t === 'span' ? [event.span] : []))
  const logs = (): TraceDef.LogData[] =>
    events.flatMap(event => (event.t === 'log' ? [event.log] : []))

  /** The one span named `name` of the kernel's own scope (fails when there is not exactly one). */
  const span = (name: string): TraceDef.SpanData => {
    const found = spans().filter(data => data.name === name)
    if (found.length !== 1) {
      throw new Error(`expected one span "${name}", got ${found.length}: ${names()}`)
    }
    return found[0]!
  }

  const names = (): string =>
    spans()
      .map(data => data.name)
      .join(', ')

  const exceptions = (): TraceDef.LogData[] =>
    logs().filter(log => log.attributes['exception.type'] !== undefined)

  const resourceOf = (data: TraceDef.SpanData): ObserveDef.Resource =>
    events.find(event => event.t === 'span' && event.span === data)!.resource

  return { plugin, events, calls, spans, logs, span, names, exceptions, resourceOf }
}

/** An in-memory std:trace `Tracer` installed around a server (a test's / an OTel bridge's). */
const memoryTracer = () => {
  installs += 1
  const spans: TraceDef.SpanData[] = []

  const plugin = Tracer.implement({
    name: `test/memory-tracer-${installs}`,
    version: '1.0.0',
    *setup() {
      yield* enableTracing()
      return {}
    },
  }).build({
    *export(data: TraceDef.SpanData) {
      spans.push(data)
    },
    *emit() {},
  })

  return { plugin, spans }
}

const isSpanId = (value: unknown): boolean =>
  typeof value === 'string' && /^[0-9a-f]{16}$/u.test(value)

const math = service('math', {
  add: action.query(
    { input: z.object({ a: z.number(), b: z.number() }), output: z.number() },
    function* ({ input }) {
      return input.a + input.b
    },
  ),
  kaput: action.query({}, function* () {
    return yield* fail('math.kaput', 'the math is kaput')
  }),
  count: action.stream(
    { input: z.object({ n: z.number() }), output: stream.ndjson(z.number()) },
    function* ({ input }) {
      return Array.from({ length: input.n }, (_, at) => at)
    },
  ),
  whoami: action.query({}, function* ({ ctx }) {
    return { requestId: ctx.requestId, traceId: ctx.trace.traceId, spanId: ctx.spanId }
  }),
  slow: action.query({ output: z.string() }, function* () {
    yield* sleep(400)
    return 'late'
  }),
})

const front = service('front', {
  sum: action.query(
    { input: z.object({ a: z.number(), b: z.number() }), output: z.number() },
    function* ({ input, ctx }) {
      return yield* ctx.call(math, 'add', input)
    },
  ),
})

const notes = service('notes', {
  write: action.mutation(
    { input: z.object({ text: z.string().min(1) }), output: z.object({ ok: z.boolean() }) },
    function* ({ input, ctx }) {
      yield* ctx.log.info('writing', { size: input.text.length })
      yield* ctx.span('notes.persist', function* () {
        yield* ctx.log.debug('persisting', { text: input.text })
        yield* ctx.event('notes.persisted', { 'notes.size': input.text.length })
      })
      yield* ctx.emit('note.written', { text: input.text })
      return { ok: true }
    },
  ),
  twice: action.mutation(
    { input: z.object({ text: z.string() }), output: z.object({ ok: z.boolean() }) },
    // a SELF-call: the return annotation breaks the inference cycle
    function* ({ input, ctx }): Operation<{ ok: boolean }> {
      return yield* ctx.call(notes, 'write', input)
    },
  ),
  explode: action.query({}, function* () {
    return yield* fail('notes.kaput', 'notes exploded')
  }),
  both: action.mutation({}, function* ({ ctx }) {
    yield* ctx.log.info('from ctx.log')
    yield* Logger.actions.info('from the Logger', { via: 'logger' })
    yield* ctx.log.debug('debug always reaches the sinks')
    return { ok: true }
  }),
  probe: action.query({}, function* ({ ctx }) {
    return { tracing: yield* isTracing(), trace: ctx.trace, spanId: ctx.spanId }
  }),
})

describe('trace spine — kernel spans on std:trace', () => {
  it('a local call: one INTERNAL dispatch span per action, nested calls and work beneath it', async () => {
    const sink = memoryExporter()

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [notes], plugins: [sink.plugin] })
        yield* server.call(notes, 'twice', { text: 'hello' })
      }),
    )

    const twice = sink.span('notes.twice')
    const write = sink.span('notes.write')
    const persist = sink.span('notes.persist')
    const publish = sink.span('publish note.written')

    // a call from outside any request: the dispatch span is the trace's ROOT
    expect(twice).toMatchObject({ kind: 'internal', parent: null, service: 'notes' })
    expect(twice.attributes).toMatchObject({ 'code.function.name': 'notes.twice' })
    expect(twice.attributes['rpc.system.name']).toBeUndefined()

    // ctx.call nests; ctx.span and emit nest under the ACTIVE span
    expect(write.parent?.spanId).toBe(twice.context.spanId)
    expect(write.kind).toBe('internal')
    expect(persist.parent?.spanId).toBe(write.context.spanId)
    // a user span's scope is the dispatch's ozaco service, never std's default
    expect(persist.scope).toEqual({ name: 'notes', version: '1.0.0' })
    expect(publish).toMatchObject({ kind: 'producer' })
    expect(publish.parent?.spanId).toBe(write.context.spanId)
    expect(publish.attributes).toMatchObject({
      'messaging.system': 'ozaco',
      'messaging.operation.type': 'send',
      'messaging.operation.name': 'publish',
      'messaging.destination.name': 'note.written',
    })
    expect(publish.attributes['messaging.message.id']).toMatch(/^[0-9a-f]{32}$/u)
    for (const data of [twice, write, persist, publish]) {
      expect(data.context.traceId).toBe(twice.context.traceId)
      expect(data.status.code).toBe('unset')
    }

    // ctx.event: a span event on the active span + a log record
    expect(persist.events.map(event => event.name)).toEqual(['notes.persisted'])
    const persisted = sink.logs().find(log => log.eventName === 'notes.persisted')!
    expect(persisted.attributes).toMatchObject({
      'notes.size': 5,
      'otel.event.name': 'notes.persisted',
    })

    // ctx.log: correlated to the span active AT THE CALL (debug included)
    const writing = sink.logs().find(log => log.body === 'writing')!
    const persisting = sink.logs().find(log => log.body === 'persisting')!
    expect(writing.context?.spanId).toBe(write.context.spanId)
    expect(persisting.context?.spanId).toBe(persist.context.spanId)
    expect(persisting).toMatchObject({ severityNumber: 5, severityText: 'DEBUG' })

    // service.name per ozaco service; records outside any dispatch use the node's name
    expect(sink.resourceOf(write)['service.name']).toBe('notes')
    expect(sink.resourceOf(write)['service.instance.id']).toBeString()
    expect(sink.resourceOf(write)['telemetry.sdk.name']).toBe('@ozaco/server')
  })

  it('failure status by class: 4xx ⇒ unset + error.type + ONE WARN, 5xx ⇒ error + ONE ERROR', async () => {
    const sink = memoryExporter()

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [notes], plugins: [sink.plugin] })

        const invalid = yield* attempt(server.call(notes, 'write', { text: '' }))
        expect((invalid as AnyType).error).toBe(ServerErrors.Validation)

        const exploded = yield* attempt(server.call(notes, 'explode'))
        expect((exploded as AnyType).error).toBe('notes.kaput')
      }),
    )

    const write = sink.span('notes.write')
    expect(write.status.code).toBe('unset')
    expect(write.attributes['error.type']).toBe(ServerErrors.Validation)

    const explode = sink.span('notes.explode')
    expect(explode.status).toEqual({ code: 'error', message: 'notes exploded' })
    expect(explode.attributes['error.type']).toBe('notes.kaput')

    const [warn, error] = sink.exceptions()
    expect(sink.exceptions()).toHaveLength(2)
    expect(warn).toMatchObject({
      eventName: 'ozaco.action.exception',
      severityNumber: 13,
      attributes: { 'exception.type': ServerErrors.Validation },
    })
    expect(warn!.context?.spanId).toBe(write.context.spanId)
    expect(error).toMatchObject({
      eventName: 'ozaco.action.exception',
      severityNumber: 17,
      attributes: {
        'exception.type': 'notes.kaput',
        'ozaco.failure.chain': ['notes.kaput: notes exploded'],
      },
    })
    expect(write.events.map(event => event.name)).toEqual(['exception'])
    expect(explode.events.map(event => event.name)).toEqual(['exception'])
  })

  it('a long-lived listener links the first 32 items it receives; every item is an event', async () => {
    const sink = memoryExporter()

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [notes], plugins: [sink.plugin] })
        const feed = yield* server.events('note.written')

        for (let index = 0; index < 34; index += 1) {
          yield* server.call(notes, 'write', { text: `note ${index}` })
        }

        yield* Server.actions.span('consumer.loop', function* () {
          for (let index = 0; index < 34; index += 1) {
            yield* feed.next()
          }
        })
      }),
    )

    const loop = sink.span('consumer.loop')
    const publishes = sink.spans().filter(span => span.name === 'publish note.written')

    expect(loop.events.filter(event => event.name === 'ozaco.event.recv')).toHaveLength(34)
    expect(loop.links).toHaveLength(32)
    expect(loop.droppedLinks).toBe(0)
    expect(loop.links.map(link => link.context.spanId)).toEqual(
      publishes.slice(0, 32).map(span => span.context.spanId),
    )
  })

  it('emit ⇒ PRODUCER; Server.actions.process ⇒ CONSUMER linking it; events() items expose it', async () => {
    const sink = memoryExporter()
    let itemId: string | undefined

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [notes], plugins: [sink.plugin] })
        const feed = yield* server.events('note.written')

        yield* server.call(notes, 'write', { text: 'hi' })

        // the item arrives under an ambient recording span: it gets `ozaco.event.recv`
        const item = yield* Server.actions.span('consumer.loop', function* () {
          const step = yield* feed.next()
          return step.value
        })
        expect(item.trace?.spanId).toBe(sink.span('publish note.written').context.spanId)
        expect(item.requestId).toBeString()
        itemId = item.id

        // no ambient span: the consumer continues the producer's trace (and LINKS it)
        yield* Server.actions.process(item, function* () {
          yield* Server.actions.report({ stream: 'audit', verb: 'note.seen', size: 2 })
        })
      }),
    )

    const publish = sink.span('publish note.written')
    const loop = sink.span('consumer.loop')
    const processed = sink.span('process note.written')

    expect(loop.events.map(event => event.name)).toEqual(['ozaco.event.recv'])
    expect(loop.events[0]!.attributes).toEqual({
      'messaging.destination.name': 'note.written',
      'messaging.message.id': itemId!,
    })
    // …and LINKS the item's creation context, like a consumer span does
    expect(loop.links).toHaveLength(1)
    expect(loop.links[0]!.context.spanId).toBe(publish.context.spanId)
    expect(loop.links[0]!.attributes).toEqual({
      'ozaco.link.reason': 'creation',
      'messaging.message.id': itemId!,
    })

    expect(processed).toMatchObject({ kind: 'consumer' })
    expect(processed.parent?.spanId).toBe(publish.context.spanId)
    expect(processed.context.traceId).toBe(publish.context.traceId)
    expect(processed.links).toHaveLength(1)
    expect(processed.links[0]!.context.spanId).toBe(publish.context.spanId)
    expect(processed.links[0]!.attributes).toEqual({ 'ozaco.link.reason': 'creation' })
    expect(processed.attributes).toMatchObject({
      'messaging.operation.type': 'process',
      'messaging.operation.name': 'process',
    })

    // one message id per envelope: the producer's and the consumer's `messaging.message.id`
    expect(itemId).toMatch(/^[0-9a-f]{32}$/u)
    expect(publish.attributes['messaging.message.id']).toBe(itemId!)
    expect(processed.attributes['messaging.message.id']).toBe(itemId!)

    // a domain record: ONE log record on the consumer span
    const domain = sink.logs().find(log => log.eventName === 'ozaco.domain')!
    expect(domain.context?.spanId).toBe(processed.context.spanId)
    expect(domain.attributes).toMatchObject({
      'ozaco.domain.stream': 'audit',
      verb: 'note.seen',
      size: 2,
      'otel.event.name': 'ozaco.domain',
    })
  })

  it('a dispatch write ships its span as bus meta (Change.Event.meta) — only while recording', async () => {
    const writer = service('writer', {
      add: action.mutation({ input: z.object({ title: z.string() }) }, function* ({ input }) {
        const db = yield* useDb(testSchema)
        yield* db.insert('todos', { title: input.title, done: false })
      }),
    })
    const sink = memoryExporter()
    const metas: unknown[] = []

    // observed: the change event names the writer (the `writer.add` dispatch span)
    unwrap(
      await run(function* () {
        yield* storage()
        const feed = yield* (yield* useDb(testSchema)).changes('todos')
        const server = yield* createServer({ services: [writer], plugins: [sink.plugin] })
        yield* server.call(writer, 'add', { title: 'traced' })
        metas.push(((yield* feed.next()).value as Change.Event).meta)
      }),
    )

    // nothing observes: no meta at all
    unwrap(
      await run(function* () {
        yield* storage()
        const feed = yield* (yield* useDb(testSchema)).changes('todos')
        const server = yield* createServer({ services: [writer] })
        yield* server.call(writer, 'add', { title: 'dark' })
        metas.push(((yield* feed.next()).value as Change.Event).meta)
      }),
    )

    const add = sink.span('writer.add')
    const [traced, dark] = metas as [Change.Event['meta'], Change.Event['meta']]
    expect(traced?.['traceparent']).toBe(`00-${add.context.traceId}-${add.context.spanId}-03`)
    expect(dark).toBeUndefined()
  })

  it('ctx.log and the std Logger: exactly ONE record each, whatever is installed', async () => {
    const sink = memoryExporter()
    const entries: LoggerDef.Entry[] = []
    const Capture = LoggerTransport.implement({
      name: 'test/capture-transport',
      version: '1.0.0',
      *setup() {
        return { name: 'capture', level: LogLevel.trace }
      },
    }).build({
      *write(entry: LoggerDef.Entry) {
        entries.push(entry)
      },
      *flush() {},
      *close() {},
    })

    unwrap(
      await run(function* () {
        yield* storage()
        yield* DefaultLogger.use({ level: LogLevel.info })
        yield* Capture.use()
        const server = yield* createServer({ services: [notes], plugins: [sink.plugin] })
        yield* server.call(notes, 'both')
      }),
    )

    const both = sink.span('notes.both')
    const byBody = (body: string) => sink.logs().filter(log => log.body === body)

    // ctx.log: one record (scope @ozaco/server), forwarded to the Logger marked as sent
    expect(byBody('from ctx.log')).toHaveLength(1)
    expect(byBody('from ctx.log')[0]).toMatchObject({ scope: { name: '@ozaco/server' } })
    expect(byBody('from ctx.log')[0]!.context?.spanId).toBe(both.context.spanId)
    const forwarded = entries.find(entry => entry.msg === 'from ctx.log')!
    expect(forwarded.bindings['ozaco.telemetry']).toBe('sent')
    expect(forwarded.trace?.spanId).toBe(both.context.spanId)

    // a plain Logger line reaches the sinks through the auto-installed TraceTransport
    expect(byBody('from the Logger')).toHaveLength(1)
    expect(byBody('from the Logger')[0]).toMatchObject({
      scope: { name: '@ozaco/std/logger' },
      attributes: { via: 'logger' },
    })
    expect(byBody('from the Logger')[0]!.context?.spanId).toBe(both.context.spanId)

    // the Logger's level gates the Logger, not the telemetry of ctx.log
    expect(byBody('debug always reaches the sinks')).toHaveLength(1)
    expect(entries.some(entry => entry.msg === 'debug always reaches the sinks')).toBe(false)
  })

  it('user spans take the dispatch’s ozaco service as their scope — else the node’s, else the given one', async () => {
    const sink = memoryExporter()

    const scopes = service('scoped', {
      work: action.query({}, function* ({ ctx }) {
        yield* ctx.span('scoped.own', function* () {})
        yield* Server.actions.span('scoped.root', function* () {})
        yield* ctx.span('scoped.lib', function* () {}, { scope: 'my-lib' })
        yield* ctx.span('scoped.versioned', function* () {}, {
          scope: { name: 'my-lib', version: '2.1.0' },
        })
      }),
    })

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          name: 'shop',
          version: '3.0.0',
          services: [scopes],
          plugins: [sink.plugin],
        })
        yield* server.call(scopes, 'work')
        // outside any dispatch: the node's
        yield* Server.actions.span('background', function* () {})
      }),
    )

    expect(sink.span('scoped.own').scope).toEqual({ name: 'scoped', version: '1.0.0' })
    expect(sink.span('scoped.root').scope).toEqual({ name: 'scoped', version: '1.0.0' })
    expect(sink.span('scoped.lib').scope).toEqual({ name: 'my-lib' })
    expect(sink.span('scoped.versioned').scope).toEqual({ name: 'my-lib', version: '2.1.0' })
    expect(sink.span('background').scope).toEqual({ name: 'shop', version: '3.0.0' })
    // the kernel's own spans keep the server's scope
    expect(sink.span('scoped.work').scope.name).toBe('@ozaco/server')
  })

  it('a handler answering outside its output: server.output WRAPS the validation failure', async () => {
    const shape = service('shape', {
      bad: action.query({ output: z.number() }, function* () {
        return 'not a number' as AnyType
      }),
    })
    let failed: AnyType

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [shape] })
        failed = yield* attempt(server.call(shape, 'bad'))
      }),
    )

    // a handler answering outside its output is the server's fault: the validation failure it
    // wraps is its nested cause, not flattened strings
    expect(failed.error).toBe(ServerErrors.Output)
    const inner = failed.causes.find((cause: unknown) => typeof cause !== 'string')
    expect(inner).toMatchObject({ error: ServerErrors.Validation })
    expect(inner.message).toBe(failed.message)
  })

  it('nothing observes ⇒ tracing is off; the carrier correlation id never depends on it', async () => {
    const cids: string[] = []
    const Spy = definePlugin<ServerDef.PluginContext, []>({
      name: 'cid-spy',
      version: '0.0.0',
      *setup() {
        return {
          hooks: {
            name: 'cid-spy',
            *dispatch(call, ctx, next) {
              cids.push(call.cid)
              return yield* next(call, ctx)
            },
          },
        }
      },
    }).build()

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [notes], plugins: [Spy] })
        const probe = yield* server.call(notes, 'probe')

        expect(probe.tracing).toBe(false)
        expect(probe.trace.traceId).toBe('')
        expect(probe.spanId).toBe('')
        expect(probe.trace.requestId).toMatch(/^[0-9a-f]{32}$/u)

        const kernel = yield* useContext(Server)
        expect(kernel.observing).toBe(false)
      }),
    )

    expect(cids).toHaveLength(1)
    expect(isSpanId(cids[0])).toBe(true)
  })

  it('a Tracer enabled around createServer counts as observing (and is not switched off)', async () => {
    const tracer = memoryTracer()

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()
        const server = yield* createServer({ services: [notes] })
        const probe = yield* server.call(notes, 'probe')
        expect(probe.tracing).toBe(true)
        expect(isSpanId(probe.spanId)).toBe(true)
      }),
    )

    expect(tracer.spans.map(data => data.name)).toEqual(['notes.probe'])
  })

  it('a nested server that observes nothing records nothing into the outer one', async () => {
    const outer = memoryExporter()

    unwrap(
      await run(function* () {
        yield* storage()
        yield* createServer({ services: [math], plugins: [outer.plugin] })

        const nested = yield* scoped(function* () {
          const inner = yield* createServer({ services: [notes], name: 'nested' })
          return yield* inner.call(notes, 'probe')
        })

        expect(nested.tracing).toBe(false)
      }),
    )

    expect(outer.spans()).toEqual([])
  })

  it('the same-process LocalCarrier: no CLIENT/SERVER pair, the callee dispatch is INTERNAL', async () => {
    const sink = memoryExporter()

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [front, math], plugins: [sink.plugin] })

        // `math` stays served by the LocalCarrier but is no longer hosted: the call goes through
        // the carrier (what a `reload` narrowing `hosted` does)
        const kernel = yield* useContext(Server)
        kernel.hosted.delete('math')

        expect(yield* server.call(front, 'sum', { a: 1, b: 2 })).toBe(3)
      }),
    )

    const sum = sink.span('front.sum')
    const add = sink.span('math.add')
    expect(add.kind).toBe('internal')
    expect(add.parent?.spanId).toBe(sum.context.spanId)
    expect(sink.spans().filter(data => data.kind === 'client' || data.kind === 'server')).toEqual(
      [],
    )
  })
})

describe('trace spine — pass-through and node boundaries', () => {
  const producer: TraceDef.SpanContext = {
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    flags: 1,
    remote: true,
  }

  it('a NON-observing node handling an event forwards the producer context to its own hops', async () => {
    const carried = unwrap(
      await run(function* () {
        yield* storage()
        yield* createServer({ services: [notes] })

        return yield* Server.actions.process(
          {
            name: 'note.written',
            payload: null,
            origin: 'elsewhere',
            trace: producer,
            requestId: 'r1',
          },
          () => inject(),
        )
      }),
    )

    expect(carried.traceparent).toBe(`00-${producer.traceId}-${producer.spanId}-01`)
  })

  it('a NON-observing edge forwards a TRUSTED inbound context, never an untrusted one (link mode)', async () => {
    const forwarded = (headers: Record<string, string>) =>
      run(function* () {
        yield* storage()
        yield* createServer({
          services: [notes],
          trace: { trust: probe => probe.headers.get('x-internal') === 'yes' },
        })
        const kernel = yield* useContext(Server)
        const request = new Request('http://node.local/notes', { headers })
        const edge = yield* edgeSpan({
          kernel,
          request,
          url: new URL(request.url),
          route: '/notes',
        })

        return yield* edge.run(() => inject())
      })

    // a stranger's `-00` would blind every node behind this one (carriers honour what they get)
    const untrusted = unwrap(
      await forwarded({ traceparent: `00-${producer.traceId}-${producer.spanId}-00` }),
    )
    expect(untrusted.traceparent).toBeUndefined()

    // an observing ozaco caller (`ozaco=1`) is continued: its context rides on
    const trusted = unwrap(
      await forwarded({
        traceparent: `00-${producer.traceId}-${producer.spanId}-01`,
        tracestate: 'ozaco=1',
      }),
    )
    expect(trusted.traceparent).toBe(`00-${producer.traceId}-${producer.spanId}-01`)

    // `ozaco=1` is self-asserted: continued, but a `-00` rides on SAMPLED — it never blinds the
    // observing nodes behind this one
    const marked = unwrap(
      await forwarded({
        traceparent: `00-${producer.traceId}-${producer.spanId}-00`,
        tracestate: 'ozaco=1',
      }),
    )
    expect(marked.traceparent).toBe(`00-${producer.traceId}-${producer.spanId}-01`)

    // a caller `trace.trust` accepts keeps its sampling decision
    const vouched = unwrap(
      await forwarded({
        traceparent: `00-${producer.traceId}-${producer.spanId}-00`,
        'x-internal': 'yes',
      }),
    )
    expect(vouched.traceparent).toBe(`00-${producer.traceId}-${producer.spanId}-00`)
  })

  it('a nested observing server exports into, starts and flushes ONLY its own exporters', async () => {
    const outer = memoryExporter()
    const inner = memoryExporter()

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [math], plugins: [outer.plugin] })
        yield* server.start()

        yield* scoped(function* () {
          const nested = yield* createServer({
            services: [notes],
            name: 'nested',
            plugins: [inner.plugin],
          })
          yield* nested.start()
          yield* nested.call(notes, 'probe')
          yield* nested.stop()
        })

        yield* server.call(math, 'add', { a: 1, b: 2 })
        yield* server.stop()
      }),
    )

    expect(inner.spans().map(data => data.name)).toEqual(['notes.probe'])
    expect(outer.spans().map(data => data.name)).toEqual(['math.add'])
    expect(inner.calls).toEqual({ start: 1, flush: 1 })
    expect(outer.calls).toEqual({ start: 1, flush: 1 })
  })
})

describe('trace spine — across a network carrier (MemoryTransport)', () => {
  /** Two nodes on one in-memory link: B hosts `math`, A hosts `front`; each has its own sink. */
  type Sinks = { a: ReturnType<typeof memoryExporter>; b: ReturnType<typeof memoryExporter> }

  const twoNodes = async (
    body: (a: ServerDef.Handle<AnyType>, sinks: Sinks) => Operation<void>,
  ): Promise<Sinks> => {
    const link = createLink()
    const a = memoryExporter()
    const b = memoryExporter()

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
              plugins: [b.plugin],
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
            services: [front],
            carrier: NetworkCarrier,
            name: 'app',
            instance: 'a',
            timeoutMs: 2000,
            plugins: [a.plugin],
          })
          yield* sleep(50)
          yield* body(server as AnyType, { a, b })
        })
        yield* remote.halt()
      }),
    )

    return { a, b }
  }

  it('a remote call is a CLIENT span here and a SERVER span there, one trace', async () => {
    const { a, b } = await twoNodes(function* (server) {
      expect(yield* server.call(front, 'sum', { a: 2, b: 3 })).toBe(5)
    })

    const sum = a.span('front.sum')
    const client = a.span('math.add')
    const serverSpan = b.span('math.add')

    expect(sum).toMatchObject({ kind: 'internal', parent: null })
    expect(client).toMatchObject({ kind: 'client', service: 'front' })
    expect(client.parent?.spanId).toBe(sum.context.spanId)
    expect(client.attributes).toMatchObject({
      'rpc.system.name': 'ozaco',
      'rpc.method': 'math.add',
      'rpc.response.status_code': '200',
    })

    expect(serverSpan).toMatchObject({ kind: 'server', service: 'math' })
    expect(serverSpan.context.traceId).toBe(sum.context.traceId)
    expect(serverSpan.parent).toMatchObject({ spanId: client.context.spanId, remote: true })
    expect(serverSpan.attributes).toMatchObject({
      'rpc.system.name': 'ozaco',
      'rpc.method': 'math.add',
      'rpc.response.status_code': '200',
    })
    expect(serverSpan.attributes['code.function.name']).toBeUndefined()

    // each side names its own service and instance
    expect(a.resourceOf(client)['service.name']).toBe('front')
    expect(b.resourceOf(serverSpan)['service.name']).toBe('math')
    expect(b.resourceOf(serverSpan)['service.instance.id']).toBe('b')
    expect(b.resourceOf(serverSpan)['ozaco.carrier.name']).toBe('memory')
  })

  it('the CLIENT span of a streamed reply ends when its lane is drained', async () => {
    let before: string[] = []

    const { a } = await twoNodes(function* (server, sinks) {
      const out = yield* server.call(math, 'count', { n: 3 })
      yield* sleep(20)
      before = sinks.a.spans().map(data => data.name)

      const values: number[] = []
      const flow = yield* stream.flow(out as AnyType)
      for (;;) {
        const step = yield* flow.next()
        if (step.done) {
          break
        }
        values.push(step.value as number)
      }
      expect(values).toEqual([0, 1, 2])
    })

    // still open while the stream was unread, exported once it was drained
    expect(before).not.toContain('math.count')
    expect(a.span('math.count')).toMatchObject({ kind: 'client', status: { code: 'unset' } })
    expect(a.span('math.count').attributes['rpc.response.status_code']).toBe('200')
  })

  it('a remote failure is recorded ONCE — by its owner; the caller only takes its status', async () => {
    const { a, b } = await twoNodes(function* (server) {
      const failed = yield* attempt(server.call(math, 'kaput'))
      expect((failed as AnyType).error).toBe('math.kaput')
      expect((failed as AnyType).message).toBe('the math is kaput')

      const invalid = yield* attempt(server.call(math, 'add', { a: 'x' } as AnyType))
      expect((invalid as AnyType).error).toBe(ServerErrors.Validation)
    })

    // 5xx: both sides error; ONE exception record across both nodes, on the owner's span
    const kaputClient = a.span('math.kaput')
    const kaputServer = b.span('math.kaput')
    expect(kaputServer.status.code).toBe('error')
    expect(kaputServer.attributes).toMatchObject({
      'error.type': 'math.kaput',
      'rpc.response.status_code': '500',
    })
    expect(kaputServer.events.map(event => event.name)).toEqual(['exception'])
    expect(kaputClient.status.code).toBe('error')
    expect(kaputClient.attributes).toMatchObject({
      'error.type': 'math.kaput',
      'ozaco.failure.remote': true,
      'rpc.response.status_code': '500',
    })
    expect(kaputClient.events).toEqual([])

    const kaputs = [...a.exceptions(), ...b.exceptions()].filter(
      log => log.attributes['exception.type'] === 'math.kaput',
    )
    expect(kaputs).toHaveLength(1)
    expect(kaputs[0]).toMatchObject({ eventName: 'rpc.server.call.exception', severityNumber: 17 })
    expect(kaputs[0]!.context?.spanId).toBe(kaputServer.context.spanId)

    // 4xx: the owner's SERVER span stays unset (error.type set, ONE WARN), the caller's CLIENT
    // span fails (its call failed), no second exception
    const addServer = b.span('math.add')
    const addClient = a.span('math.add')
    expect(addServer.status.code).toBe('unset')
    expect(addServer.attributes['error.type']).toBe(ServerErrors.Validation)
    expect(addClient.status.code).toBe('error')
    expect(addClient.attributes['error.type']).toBe(ServerErrors.Validation)

    const invalids = [...a.exceptions(), ...b.exceptions()].filter(
      log => log.attributes['exception.type'] === ServerErrors.Validation,
    )
    expect(invalids).toHaveLength(1)
    expect(invalids[0]).toMatchObject({ severityNumber: 13 })
  })

  it('a remote failure names where it was answered: operation, node and SERVER span', async () => {
    let failed: AnyType

    const { b } = await twoNodes(function* (server) {
      failed = yield* attempt(server.call(math, 'kaput'))
    })

    // a real Failure again (no `remote` field): the owner's breadcrumb (its SERVER span, the
    // request) crossed the wire with it, the decoder appends where it was answered, then the
    // caller's hops add the plugin runtime's labels: the transport request, the carrier send,
    // the kernel call
    const owner = b.span('math.kaput')
    expect(failed).toMatchObject({ error: 'math.kaput', message: 'the math is kaput' })
    expect(failed.remote).toBeUndefined()
    expect(failed.causes).toEqual([
      expect.stringMatching(
        new RegExp(`^action:math\\.kaput span:${owner.context.spanId} req:[0-9a-f]{32}$`, 'u'),
      ),
      `remote: math.kaput @ app@0.0.0#b span ${owner.context.spanId.slice(0, 8)}`,
      ...LABELS.transport,
      ...LABELS.carrier,
      ...LABELS.call,
    ])
  })

  it('a caller halted mid-hop still ENDS its CLIENT span — cancelled, not lost', async () => {
    const { a } = await twoNodes(function* (server) {
      const winner = yield* race([
        (function* () {
          yield* server.call(math, 'slow')
          return 'call'
        })(),
        (function* () {
          yield* sleep(40)
          return 'timer'
        })(),
      ])
      expect(winner).toBe('timer')
    })

    const client = a.span('math.slow')
    expect(client).toMatchObject({ kind: 'client', status: { code: 'unset' } })
    expect(client.attributes['ozaco.cancelled']).toBe(true)
    expect(a.exceptions()).toEqual([])
  })

  it('the request id rides the wire; a pre-traceparent envelope starts a new trace there', async () => {
    let direct: AnyType
    let viaCall: AnyType

    const { b } = await twoNodes(function* (server) {
      viaCall = yield* server.call(math, 'whoami')

      // an OLD node's envelope: no traceparent, just the request id
      const kernel = yield* useContext(Server)
      const sent = yield* kernel.carrier!.actions.send(
        {
          k: 'dispatch',
          cid: '0123456789abcdef',
          service: 'math',
          action: 'whoami',
          args: undefined,
          trace: { request_id: 'legacy-request-1', span_id: 'x', lane: [] },
          inputs: [],
          deadline: Date.now() + 2000,
        },
        [],
      )
      direct = sent.reply.value
    })

    expect(viaCall.requestId).toMatch(/^[0-9a-f]{32}$/u)
    expect(viaCall.traceId).toMatch(/^[0-9a-f]{32}$/u)
    expect(direct.requestId).toBe('legacy-request-1')

    const [first, legacy] = b.spans().filter(data => data.name === 'math.whoami')
    expect(first!.context.traceId).toBe(viaCall.traceId)
    expect(legacy!.parent).toBeNull()
    expect(legacy!.kind).toBe('server')
    expect(legacy!.context.traceId).toBe(direct.traceId)
  })

  it('a NON-observing node in the middle keeps the trace whole and the failure recorded once', async () => {
    const relay = service('relay', {
      kaput: action.query({}, function* ({ ctx }) {
        return yield* ctx.call(math, 'kaput')
      }),
    })
    const entry = service('entry', {
      go: action.query({}, function* ({ ctx }) {
        return yield* ctx.call(relay, 'kaput')
      }),
    })
    const link = createLink()
    const a = memoryExporter()
    const c = memoryExporter()
    // presence off: each hop goes straight to the transport (whoever serves the topic answers)
    const carrier = NetworkCarrier.use({ presence: false })
    let failed: AnyType

    unwrap(
      await run(function* () {
        const ready = createQueue<void, void>()
        const node = (instance: string, services: AnyType[], plugins: AnyType[]) =>
          fork(() =>
            scoped(function* () {
              yield* storage()
              yield* MemoryTransport.use({ prefix: 'app', link })
              yield* createServer({ services, carrier, name: 'app', instance, plugins })
              ready.add(undefined)
              yield* sleep(60_000)
            }),
          )

        const owner = yield* node('c', [math], [c.plugin])
        yield* ready.next()
        // `b` observes nothing: its hops forward the caller's context as a pass-through
        const middle = yield* node('b', [relay], [])
        yield* ready.next()

        yield* scoped(function* () {
          yield* storage()
          yield* MemoryTransport.use({ prefix: 'app', link })
          const server = yield* createServer({
            services: [entry, relay],
            hosted: ['entry'],
            carrier,
            name: 'app',
            instance: 'a',
            timeoutMs: 2000,
            plugins: [a.plugin],
          })
          failed = yield* attempt(server.call(entry, 'go'))
        })

        yield* middle.halt()
        yield* owner.halt()
      }),
    )

    expect(failed.error).toBe('math.kaput')

    const go = a.span('entry.go')
    const kaput = c.span('math.kaput')
    expect(kaput).toMatchObject({ kind: 'server' })
    expect(kaput.context.traceId).toBe(go.context.traceId)
    // the middle node recorded nothing: the caller's CLIENT span is the owner's parent
    expect(kaput.parent?.spanId).toBe(a.span('relay.kaput').context.spanId)

    expect([...a.exceptions(), ...c.exceptions()]).toHaveLength(1)
    expect(c.exceptions()[0]!.context?.spanId).toBe(kaput.context.spanId)
    expect(a.span('relay.kaput')).toMatchObject({
      kind: 'client',
      attributes: { 'error.type': 'math.kaput', 'ozaco.failure.remote': true },
    })
  })

  it('rpc.response.status_code is the reply’s real status; events carry one message id across', async () => {
    const board = service('board', {
      post: action.mutation({ status: 202 }, function* ({ ctx }) {
        yield* ctx.emit('board.posted', { n: 1 })
        return { queued: true }
      }),
    })
    const link = createLink()
    const a = memoryExporter()
    const b = memoryExporter()
    let itemId: string | undefined

    unwrap(
      await run(function* () {
        const ready = createQueue<void, void>()
        const remote = yield* fork(() =>
          scoped(function* () {
            yield* storage()
            yield* MemoryTransport.use({ prefix: 'app', link })
            yield* createServer({
              services: [board],
              carrier: NetworkCarrier.use({ presence: false }),
              name: 'app',
              instance: 'b',
              plugins: [b.plugin],
            })
            ready.add(undefined)
            yield* sleep(60_000)
          }),
        )
        yield* ready.next()
        yield* scoped(function* () {
          yield* storage()
          yield* MemoryTransport.use({ prefix: 'app', link })
          // a gateway that knows the declaration (its `status`) but hosts nothing
          const server = yield* createServer({
            services: [board],
            role: 'gateway',
            carrier: NetworkCarrier.use({ presence: false }),
            name: 'app',
            instance: 'a',
            timeoutMs: 2000,
            plugins: [a.plugin],
          })
          const feed = yield* server.events('board.posted')
          expect(yield* server.call(board, 'post')).toEqual({ queued: true })

          const item = (yield* feed.next()).value as ServerDef.EventItem
          itemId = item.id
          yield* Server.actions.process(item, function* () {})
        })
        yield* remote.halt()
      }),
    )

    // the owner answered 202 (`status`), and the caller says so too
    expect(b.span('board.post').attributes['rpc.response.status_code']).toBe('202')
    expect(a.span('board.post').attributes['rpc.response.status_code']).toBe('202')

    // the envelope's id is the producer's and the consumer's message id, across the wire
    expect(itemId).toMatch(/^[0-9a-f]{32}$/u)
    expect(b.span('publish board.posted').attributes['messaging.message.id']).toBe(itemId!)
    expect(a.span('process board.posted').attributes['messaging.message.id']).toBe(itemId!)
  })

  it('a local call that times out names the dispatch span it ran in: `local span:<id> req:<id>`', async () => {
    const tracer = memoryTracer()
    let late: AnyType

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()
        const server = yield* createServer({ services: [todos], timeoutMs: 100 })
        late = yield* attempt(server.call(todos, 'slowCancel', { ms: 300 }))
      }),
    )

    expect(late.error).toBe(ServerErrors.TimeoutPending)
    // the callee's dispatch span (cancelled at the deadline), as the kernel's breadcrumb always
    // named it — not the caller's
    const dispatch = tracer.spans.find(data => data.name === 'todos.slowCancel')!
    expect(late.causes[0]).toMatch(
      new RegExp(`^local span:${dispatch.context.spanId} req:[0-9a-f]{32}$`, 'u'),
    )
  })

  it('a transport failure becomes the fulfillment failure WRAPPING it (nested, not flattened)', async () => {
    let failed: AnyType

    unwrap(
      await run(function* () {
        yield* storage()
        yield* MemoryTransport.use({ prefix: 'app', link: createLink() })
        const server = yield* createServer({
          services: [front],
          carrier: NetworkCarrier.use({ presence: false }),
          name: 'app',
          timeoutMs: 500,
        })
        // nobody serves `math` on this link
        failed = yield* attempt(server.call(math, 'add', { a: 1, b: 2 }))
      }),
    )

    expect(failed.error).toBe(ServerErrors.Unavailable)
    expect(failed.message).toBe('math.add: nobody serves it')
    // the transport failure nested FIRST, then the hops the fulfillment failure crossed on its
    // way out (the plugin runtime's labels): the carrier's send, the kernel's call — the nested
    // one keeps the labels of the transport request it crossed before it was wrapped
    expect(failed.causes).toEqual([
      expect.objectContaining({ error: 'transport.no-responders' }),
      ...LABELS.carrier,
      ...LABELS.call,
    ])
    expect(failed.causes[0].causes).toEqual([...LABELS.transport])
  })

  it('suppression crosses the wire: an unsampled caller is not recorded by its owner', async () => {
    const { a, b } = await twoNodes(function* (server) {
      const sum = yield* Server.actions.span('caller', () =>
        suppressed(() => server.call(math, 'add', { a: 1, b: 1 })),
      )
      expect(sum).toBe(2)
    })

    // the caller's own span is recorded; nothing it did while suppressed, on either side
    expect(a.spans().map(data => data.name)).toEqual(['caller'])
    expect(b.spans()).toEqual([])
  })
})
