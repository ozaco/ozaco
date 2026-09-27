/**
 * `defineEvents` — the typed face of the event plane. Names and payloads are checked where they
 * are written; a subscriber sees the payload typed, and a malformed one is dropped rather than
 * handed on.
 */
import type { CarrierDef, ObserveDef, ServerDef, WireDef } from 'server:core'
import { action, Carrier, createServer, defineEvents, Server, service } from 'server:core'
import type { Operation, Subscription } from 'std:effect'
import { attempt, createQueue, race, run, scoped, sleep } from 'std:effect'
import type { LoggerDef } from 'std:logger'
import { DefaultLogger, LoggerTransport, LogLevel } from 'std:logger'
import { definePlugin } from 'std:plugin'
import { fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { current } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { NetworkCarrier } from 'server:impl/carrier/network'
import { createLink, MemoryTransport } from 'transport:impl/memory'
import { z } from 'zod'

import { storage } from '../helpers'

const events = defineEvents({
  'todo.created': z.object({ id: z.string(), title: z.string() }),
  'media.uploaded': z.object({ id: z.string(), size: z.number().default(0) }),
})

const app = service('app', {
  create: action.mutation(
    { input: z.object({ title: z.string() }), output: z.object({ ok: z.boolean() }) },
    function* ({ input }) {
      yield* events.emit('todo.created', { id: 'a1', title: input.title })
      return { ok: true }
    },
  ),
})

describe('core — defineEvents', () => {
  it('names the events once: emit validates, on() types and filters', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [app] })

        const feed = yield* events.on('todo.created')
        yield* server.call(app, 'create', { title: 'typed' })

        const step = yield* race([
          feed.next(),
          (function* () {
            yield* sleep(1000)
            return { done: true as const, value: undefined }
          })(),
        ])

        expect(step.done).toBe(false)

        // typed end to end — no cast on the payload
        const payload = (step as { value: { id: string; title: string } }).value
        expect(payload).toEqual({ id: 'a1', title: 'typed' })

        // the schema's defaults apply on the way out
        const uploads = yield* events.on('media.uploaded')
        yield* events.emit('media.uploaded', { id: 'u1' })

        const upload = yield* race([
          uploads.next(),
          (function* () {
            yield* sleep(1000)
            return { done: true as const, value: undefined }
          })(),
        ])
        expect((upload as AnyType).value).toEqual({ id: 'u1', size: 0 })

        yield* server.stop()
      }),
    )
  })

  it('a malformed payload fails at the emitter, and is dropped (reported) at the subscriber', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const reported: ObserveDef.Event[] = []

        const Spy = definePlugin<ServerDef.PluginContext, []>({
          name: 'spy',
          version: '0',
          *setup() {
            return {
              hooks: {
                name: 'spy',
                *observe(event) {
                  reported.push(event)
                },
              },
            }
          },
        }).build()

        const server = yield* createServer({ services: [app], plugins: [Spy] })

        // the emitter is where a bad payload is still fixable
        const bad = yield* attempt(() => events.emit('todo.created', { id: 'a1' } as AnyType))
        expect((bad as AnyType).error).toBe('server.validation')

        // one published off the typed plane (the raw wire) with the wrong shape is DROPPED
        const feed = yield* events.on('todo.created')
        yield* server.emit('todo.created', { nope: true })
        yield* server.call(app, 'create', { title: 'good one' })

        const step = yield* race([
          feed.next(),
          (function* () {
            yield* sleep(1000)
            return { done: true as const, value: undefined }
          })(),
        ])

        // the subscriber skipped the bad one and got the good one
        expect((step as AnyType).value).toEqual({ id: 'a1', title: 'good one' })

        // …and said so: the dropped item was PROCESSED in its consumer span — linked to the
        // emitter's producer span, failed by the validation (a 400: `error.type`, status unset)
        // with ONE WARN exception record
        const spans = reported.flatMap(event => (event.t === 'span' ? [event.span] : []))
        const publish = spans.find(span => span.name === 'publish todo.created')!
        const processed = spans.find(span => span.name === 'process todo.created')!
        expect(publish.kind).toBe('producer')
        expect(processed).toMatchObject({
          kind: 'consumer',
          status: { code: 'unset' },
          attributes: {
            'messaging.system': 'ozaco',
            'messaging.operation.type': 'process',
            'messaging.destination.name': 'todo.created',
            'error.type': 'server.validation',
          },
        })
        expect(processed.links.map(link => link.context.spanId)).toContain(publish.context.spanId)
        expect(processed.links[0]!.attributes).toEqual({ 'ozaco.link.reason': 'creation' })

        const exceptions = reported.flatMap(event =>
          event.t === 'log' && event.log.eventName === 'messaging.process.exception'
            ? [event.log]
            : [],
        )
        expect(exceptions).toHaveLength(1)
        expect(exceptions[0]!.severityNumber).toBe(13)
        expect(exceptions[0]!.context?.spanId).toBe(processed.context.spanId)

        yield* server.stop()
      }),
    )
  })
})

/** An observe hook collecting what the kernel reports. */
const spyOf = () => {
  const reported: ObserveDef.Event[] = []
  const plugin = definePlugin<ServerDef.PluginContext, []>({
    name: 'spy',
    version: '0',
    *setup() {
      return {
        hooks: {
          name: 'spy',
          *observe(event) {
            reported.push(event)
          },
        },
      }
    },
  }).build()

  const spans = (name?: string): TraceDef.SpanData[] =>
    reported.flatMap(event =>
      event.t === 'span' && (name === undefined || event.span.name === name) ? [event.span] : [],
    )

  const exceptions = (): TraceDef.LogData[] =>
    reported.flatMap(event =>
      event.t === 'log' && event.log.eventName === 'messaging.process.exception' ? [event.log] : [],
    )

  return { plugin, reported, spans, exceptions }
}

/** Wait (bounded) until `ready()` holds. */
function* settle(ready: () => boolean): Operation<void> {
  for (let tries = 0; tries < 100 && !ready(); tries += 1) {
    yield* sleep(10)
  }
}

describe('core — defineEvents.handle', () => {
  it('runs every event in its CONSUMER span: parented to the producer, linking it — not to the caller', async () => {
    const spy = spyOf()
    const heard: { title: string; origin: string; creation: string | null; span: string }[] = []
    let serviceId = ''

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [app], plugins: [spy.plugin] })
        serviceId = (yield* Server.context.expect()).serviceId

        // called under a span of its own: the loop outlives it, so it never parents the events
        yield* Server.actions.span('subscriber', () =>
          events.handle(
            'todo.created',
            function* (todo, meta) {
              heard.push({
                title: todo.title,
                origin: meta.origin,
                creation: meta.trace?.spanId ?? null,
                span: (yield* current()).context.spanId,
              })
              yield* Server.actions.span('send mail', function* () {})
            },
            { subscription: 'mailer' },
          ),
        )

        yield* server.call(app, 'create', { title: 'one' })
        yield* server.call(app, 'create', { title: 'two' })
        yield* settle(() => heard.length === 2 && spy.spans('send mail').length === 2)
        yield* server.stop()
      }),
    )

    expect(heard.map(entry => entry.title)).toEqual(['one', 'two'])

    const publishes = spy.spans('publish todo.created')
    const processes = spy.spans('process todo.created')
    const mails = spy.spans('send mail')
    expect(publishes).toHaveLength(2)
    expect(processes).toHaveLength(2)

    for (const [index, processed] of processes.entries()) {
      const publish = publishes.find(span => span.context.spanId === processed.parent?.spanId)!
      expect(publish).toBeDefined()

      // a trace continuing the emitter's: its PRODUCER span is the parent AND the link
      expect(processed).toMatchObject({
        kind: 'consumer',
        status: { code: 'unset' },
        attributes: {
          'messaging.system': 'ozaco',
          'messaging.operation.type': 'process',
          'messaging.destination.name': 'todo.created',
          'messaging.destination.subscription.name': 'mailer',
          'ozaco.event.origin': serviceId,
        },
      })
      expect(processed.context.traceId).toBe(publish.context.traceId)
      expect(processed.parent?.spanId).toBe(publish.context.spanId)
      expect(processed.links.map(link => link.context.spanId)).toEqual([publish.context.spanId])
      expect(processed.links[0]!.attributes).toEqual({ 'ozaco.link.reason': 'creation' })

      // the handler ran inside it: its meta names the producer, its own spans nest under it
      expect(heard[index]).toMatchObject({
        origin: serviceId,
        creation: publish.context.spanId,
        span: processed.context.spanId,
      })
      expect(mails.filter(mail => mail.parent?.spanId === processed.context.spanId)).toHaveLength(1)
    }

    // the span `handle` was called under parents nothing it did afterwards
    const subscriber = spy.spans('subscriber')[0]!
    expect(processes.some(span => span.context.traceId === subscriber.context.traceId)).toBe(false)
  })

  it('a failing handler fails ITS span (recorded once) and the loop goes on — a bad payload too', async () => {
    const spy = spyOf()
    const handled: string[] = []

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [app], plugins: [spy.plugin] })

        yield* events.handle('todo.created', function* (todo) {
          handled.push(todo.title)

          if (todo.title === 'boom') {
            yield* fail('mailer.down', 'smtp is down')
          }
        })

        // off the typed plane: never reaches the handler
        yield* server.emit('todo.created', { nope: true })
        yield* server.call(app, 'create', { title: 'boom' })
        yield* server.call(app, 'create', { title: 'fine' })
        yield* settle(() => spy.spans('process todo.created').length === 3)
        yield* server.stop()
      }),
    )

    expect(handled).toEqual(['boom', 'fine'])

    // (told apart by outcome: separate traces, so their start times need not be ordered)
    const processes = spy.spans('process todo.created')
    expect(processes).toHaveLength(3)
    const bad = processes.find(span => span.attributes['error.type'] === 'server.validation')
    const boom = processes.find(span => span.attributes['error.type'] === 'mailer.down')
    const fine = processes.find(span => span.attributes['error.type'] === undefined)

    // the bad publisher: a 400 — unset, `error.type`, one WARN
    expect(bad).toMatchObject({
      status: { code: 'unset' },
      attributes: { 'error.type': 'server.validation' },
    })
    // the broken handler: a 500 — error, one ERROR
    expect(boom).toMatchObject({
      status: { code: 'error' },
      attributes: { 'error.type': 'mailer.down' },
    })
    // …and the next one was handled all the same
    expect(fine!.status.code).toBe('unset')
    expect(fine!.attributes['error.type']).toBeUndefined()

    const exceptions = spy
      .exceptions()
      .map(log => [log.context?.spanId, log.severityNumber])
      .toSorted((left, right) => Number(left[1]) - Number(right[1]))
    expect(exceptions).toEqual([
      [bad!.context.spanId, 13],
      [boom!.context.spanId, 17],
    ])
  })

  it('tracing off: a failed event is never silent — one Logger line', async () => {
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
    let handled = 0

    unwrap(
      await run(function* () {
        yield* storage()
        yield* DefaultLogger.use({ level: LogLevel.info })
        yield* Capture.use()
        // nothing observes: tracing is off on this node
        const server = yield* createServer({ services: [app] })

        yield* events.handle('todo.created', function* () {
          handled += 1
          yield* fail('mailer.down', 'smtp is down')
        })

        yield* server.call(app, 'create', { title: 'boom' })
        yield* server.call(app, 'create', { title: 'again' })
        yield* settle(() => entries.filter(entry => entry.msg.startsWith('event')).length === 2)
        yield* server.stop()
      }),
    )

    expect(handled).toBe(2)
    const lines = entries.filter(entry => entry.msg === 'event "todo.created" was not handled')
    expect(lines).toHaveLength(2)
    expect(lines[0]!.level).toBe(LogLevel.error)
    expect(lines[0]!.bindings['logger']).toBe('@ozaco/server')
  })
})

describe('core — Server.actions.events() when its subscription ends', () => {
  /** A carrier whose event plane delivers one event, then is FINISHED: every further pull
   * answers `done` (a closed transport) — pulling it in a loop would spin. */
  const finiteCarrier = (pulls: number[]) =>
    Carrier.implement<CarrierDef.Options, []>({
      name: 'test-carrier-finite',
      version: '0.0.0',
      description: 'an event plane that ends',
      *setup() {
        return { carrier: 'finite', transport: 'finite' }
      },
    }).build({
      *hosts() {
        return false
      },
      *members() {
        return []
      },
      *send() {
        return yield* fail('test.nowhere', 'nothing is remote here')
      },
      *serve() {},
      *unserve() {},
      *leave() {},
      *emit() {},
      events: () => ({
        *[Symbol.iterator]() {
          const index = pulls.push(0) - 1
          let delivered = false

          return {
            *next(): Operation<IteratorResult<WireDef.Event, never>> {
              if (!delivered) {
                delivered = true
                return {
                  done: false,
                  value: {
                    k: 'event',
                    name: 'todo.created',
                    payload: { id: 'x', title: 'last' },
                    origin: 'elsewhere',
                  },
                }
              }

              pulls[index]! += 1

              if (pulls[index]! > 100) {
                return yield* fail('test.spin', 'a finished subscription was pulled 100 times')
              }

              return { done: true, value: undefined as never }
            },
          }
        },
      }),
      *cancel() {},
      status: () => ({
        *[Symbol.iterator]() {
          const queue = createQueue<'connected' | 'reconnecting' | 'closed', void>()
          queue.add('connected')
          return queue
        },
      }),
    })

  it('ends the flow (no spin) — and with it `on()` and a `handle()` loop', async () => {
    const pulls: number[] = []
    const steps: unknown[] = []
    const typed: unknown[] = []
    const handled: string[] = []

    unwrap(
      await run(function* () {
        yield* storage()
        yield* createServer({ services: [app], carrier: finiteCarrier(pulls) })

        const feed = yield* Server.actions.events()
        steps.push((yield* feed.next()).value, yield* feed.next())

        const on = yield* events.on('todo.created')
        typed.push((yield* on.next()).value, (yield* on.next()).done)

        const loop = yield* events.handle('todo.created', function* (todo) {
          handled.push(todo.title)
        })
        const ended = yield* race([
          (function* () {
            yield* loop
            return 'ended'
          })(),
          (function* () {
            yield* sleep(1000)
            return 'still running'
          })(),
        ])
        expect(ended).toBe('ended')
      }),
    )

    expect(steps[0]).toMatchObject({ name: 'todo.created', origin: 'elsewhere' })
    expect(steps[1]).toEqual({ done: true, value: undefined })
    expect(typed).toEqual([{ id: 'x', title: 'last' }, true])
    expect(handled).toEqual(['last'])
    // each finished subscription was pulled ONCE more — the pull that said it was done
    expect(pulls).toEqual([1, 1, 1])
  })

  it('network carrier: the transport closing its subscriptions ends the flow', async () => {
    const link = createLink()
    let step: unknown = null

    unwrap(
      await run(function* () {
        yield* storage()
        yield* MemoryTransport.use({ prefix: 'app', link })
        yield* createServer({ services: [app], carrier: NetworkCarrier.use({ presence: false }) })

        const feed = yield* Server.actions.events()

        // the broker drops the event-plane subscriptions (both planes)
        for (const subscriber of link.subscribers) {
          if (subscriber.pattern === 'app.event.>') {
            subscriber.queue.close(undefined)
          }
        }

        step = yield* race([
          feed.next(),
          (function* () {
            yield* sleep(1000)
            return 'still waiting'
          })(),
        ])
      }),
    )

    expect(step).toEqual({ done: true, value: undefined })
  })

  it('local carrier: a subscription whose scope ended answers `done` — no wait, no spin', async () => {
    const live: unknown[] = []
    const ended: unknown[] = []

    unwrap(
      await run(function* () {
        yield* storage()
        // no carrier given: the same-process LocalCarrier
        yield* createServer({ services: [app] })

        // while its scope lives, the node's own emits arrive
        const feed = yield* Server.actions.events()
        yield* Server.actions.emit('todo.created', { id: 'a1', title: 'live' })
        live.push((yield* feed.next()).value)

        // subscribed in a scope that is gone by the time it is pulled
        let gone: Subscription<ServerDef.EventItem, never> | null = null
        yield* scoped(function* () {
          gone = yield* Server.actions.events()
        })

        for (let pull = 0; pull < 3; pull += 1) {
          ended.push(
            yield* race([
              gone!.next(),
              (function* () {
                yield* sleep(300)
                return 'still waiting'
              })(),
            ]),
          )
        }
      }),
    )

    expect(live).toMatchObject([{ name: 'todo.created', payload: { id: 'a1', title: 'live' } }])
    expect(ended).toEqual([
      { done: true, value: undefined },
      { done: true, value: undefined },
      { done: true, value: undefined },
    ])
  })
})
