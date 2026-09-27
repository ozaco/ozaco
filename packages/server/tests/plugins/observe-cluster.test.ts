import type { ObserveDef } from 'server:core'
import { action, createServer, Observe, Server, service } from 'server:core'
import { ObservePlugin } from 'server:plugins'
import { createQueue, fork, run, scoped, sleep } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { NetworkCarrier } from 'server:impl/carrier/network'
import { createLink, MemoryTransport } from 'transport:impl/memory'

import { storage, todos } from '../helpers'

const presence = { heartbeatMs: 100, ttlMs: 300, waitMs: 100 }

describe('observe — cluster', () => {
  it('forwarded records land in the collector: one trace across two nodes, per-instance stats', async () => {
    const link = createLink()
    unwrap(
      await run(function* () {
        const ready = createQueue<void, void>()
        // the service node forwards everything it observes
        const worker = yield* fork(() =>
          scoped(function* () {
            yield* storage()
            yield* MemoryTransport.use({ prefix: 'obs', link })
            const svc = yield* createServer({
              services: [todos],
              carrier: NetworkCarrier.use({ presence }),
              plugins: [
                ObservePlugin.use({
                  batch: { waitMs: 10 },
                  cluster: { sendToCollector: true, heartbeatMs: 50 },
                }),
              ],
              name: 'app',
              instance: 'svc',
            })
            yield* svc.start()
            ready.add(undefined)
            yield* sleep(60_000)
          }),
        )
        yield* ready.next()
        // the gateway collects
        yield* scoped(function* () {
          yield* storage()
          yield* MemoryTransport.use({ prefix: 'obs', link })
          const gateway = yield* createServer({
            services: [todos],
            carrier: NetworkCarrier.use({ presence }),
            plugins: [
              ObservePlugin.use({
                batch: { waitMs: 10 },
                cluster: { isCollector: true, heartbeatMs: 50 },
              }),
            ],
            name: 'app',
            instance: 'gw',
            role: 'gateway',
          })
          yield* gateway.start()
          // let presence + the collector heartbeat settle on both sides
          yield* sleep(250)
          const created = yield* gateway.call(todos, 'create', { title: 'across' })
          expect(created.title).toBe('across')
          yield* sleep(150)

          // one trace across two nodes, listed ONCE — by its outermost root (the gateway's)
          const page = yield* Observe.actions.traces({ name: 'todos.create' })
          expect(page.traces).toHaveLength(1)
          const root = page.traces[0]!
          expect(root.service_instance_id).toBe('gw')
          const view = yield* Observe.actions.trace(root.trace_id)
          expect(view).not.toBeNull()
          const instances = new Set(view!.spans.map(span => span.service_instance_id))
          // the gateway's dispatch + carrier spans AND the service node's server span, one tree
          expect(instances).toEqual(new Set(['gw', 'svc']))
          const client = view!.spans.find(
            span => span.service_instance_id === 'gw' && span.kind === 'client',
          )!
          const remote = view!.spans.find(
            span => span.service_instance_id === 'svc' && span.kind === 'server',
          )!
          expect(remote).toMatchObject({ name: 'todos.create', service_name: 'todos', root: true })
          // the forwarded row kept its place in the tree and its resource
          expect(remote.parent_span_id).toBe(client.span_id)
          expect(remote.resource['service.namespace']).toBe('app')
          // the service node's log line travelled too, under its span
          const creating = view!.logs.find(log => log.body === 'creating')!
          expect(creating).toMatchObject({ service_instance_id: 'svc', span_id: remote.span_id })

          const cluster = yield* Observe.actions.cluster()
          expect(cluster.members.todos!.map(member => member.instance)).toEqual(['svc'])
          expect(cluster.instances.map(entry => entry.instance)).toEqual(['gw', 'svc'])
          const svc = cluster.instances.find(entry => entry.instance === 'svc')!
          expect(svc.services).toContain('todos')
          expect(svc.spans).toBeGreaterThan(0)
          expect(svc.failed).toBe(0)

          const stats = yield* Observe.actions.stats()
          expect(stats.received).toBeGreaterThan(0)

          // the forwarding itself is never telemetry: no span of the `_observe.*` plumbing, no
          // span of the collector writing it, on either node
          const everything = (yield* Observe.actions.traces({ limit: 500 })).traces
          expect(everything.map(row => row.name)).toEqual(['todos.create'])
          for (const span of view!.spans) {
            expect(span.name).not.toContain('_observe')
            expect(String(span.attributes['db.collection.name'] ?? '')).not.toMatch(/^_ob/u)
          }
          yield* gateway.stop()
        })
        yield* worker.halt()
      }),
    )
  })

  it('forwarding with no collector falls back to the local store (or drops, when asked)', async () => {
    const link = createLink()
    unwrap(
      await run(function* () {
        yield* storage()
        yield* MemoryTransport.use({ prefix: 'lonely', link })
        const server = yield* createServer({
          services: [todos],
          carrier: NetworkCarrier.use({ presence }),
          plugins: [
            ObservePlugin.use({ batch: { waitMs: 10 }, cluster: { sendToCollector: true } }),
          ],
          name: 'app',
          instance: 'alone',
        })
        yield* server.start()
        yield* server.call(todos, 'create', { title: 'kept' })
        yield* sleep(50)
        const page = yield* Observe.actions.traces({ name: 'todos.create' })
        expect(page.traces).toHaveLength(1)
        expect(page.traces[0]!.service_instance_id).toBe('alone')
        expect((yield* Observe.actions.stats()).fellBack).toBeGreaterThan(0)
        yield* server.stop()
      }),
    )
    unwrap(
      await run(function* () {
        yield* storage()
        yield* MemoryTransport.use({ prefix: 'lonely2', link })
        const server = yield* createServer({
          services: [todos],
          carrier: NetworkCarrier.use({ presence }),
          plugins: [
            ObservePlugin.use({
              batch: { waitMs: 10 },
              cluster: { sendToCollector: true, whenCollectorDown: 'drop' },
            }),
          ],
          name: 'app',
          instance: 'alone',
        })
        yield* server.start()
        yield* server.call(todos, 'create', { title: 'dropped' })
        yield* sleep(50)
        expect((yield* Observe.actions.traces({ name: 'todos.create' })).traces).toHaveLength(0)
        yield* server.stop()
      }),
    )
  })

  it('a forwarded record keeps its non-finite numbers (the strings std spells them as) across the JSON wire', async () => {
    const link = createLink()
    const odd = service('odd', {
      ratio: action.query({}, function* ({ ctx }) {
        yield* ctx.log.info('ratio', { ratio: 0 / 0, max: -Infinity })
        return 'ok'
      }),
    })

    unwrap(
      await run(function* () {
        const ready = createQueue<void, void>()
        const worker = yield* fork(() =>
          scoped(function* () {
            yield* storage()
            yield* MemoryTransport.use({ prefix: 'odd', link })
            const svc = yield* createServer({
              services: [odd],
              carrier: NetworkCarrier.use({ presence }),
              plugins: [
                ObservePlugin.use({
                  batch: { waitMs: 10 },
                  cluster: { sendToCollector: true, heartbeatMs: 50 },
                }),
              ],
              name: 'app',
              instance: 'svc',
            })
            yield* svc.start()
            ready.add(undefined)
            yield* sleep(60_000)
          }),
        )
        yield* ready.next()
        yield* scoped(function* () {
          yield* storage()
          yield* MemoryTransport.use({ prefix: 'odd', link })
          const gateway = yield* createServer({
            services: [odd],
            carrier: NetworkCarrier.use({ presence }),
            plugins: [
              ObservePlugin.use({
                batch: { waitMs: 10 },
                cluster: { isCollector: true, heartbeatMs: 50 },
              }),
            ],
            name: 'app',
            instance: 'gw',
            role: 'gateway',
          })
          yield* gateway.start()
          yield* sleep(250)
          yield* gateway.call(odd, 'ratio', {})
          yield* sleep(150)

          const [root] = (yield* Observe.actions.traces({ name: 'odd.ratio' })).traces
          const view = (yield* Observe.actions.trace(root!.trace_id))!
          const line = view.logs.find(log => log.body === 'ratio')!
          // written by the service node, forwarded as JSON, stored by the collector — as every
          // sink holds them (std normalizes non-finite numbers once, before the fan-out)
          expect(line.service_instance_id).toBe('svc')
          expect(line.attributes).toEqual({ ratio: 'NaN', max: '-Infinity' })
          yield* gateway.stop()
        })
        yield* worker.halt()
      }),
    )
  })

  it('a big batch crosses the carrier as messages of at most 512 KiB, each standing on its own', async () => {
    const link = createLink()
    // ~1.5 MB of records in ONE flush: 120 log records of ~12 KiB each
    const records = 120
    const filler = 'x'.repeat(12 * 1024)
    const logAt = (at: number): ObserveDef.Event => ({
      t: 'log',
      resource: { 'service.name': 'bulk', 'service.instance.id': 'svc' },
      log: {
        time: 1_700_000_000_000 + at,
        observedTime: 1_700_000_000_000 + at,
        severityNumber: 9,
        body: `bulk ${at} ${filler}`,
        attributes: { 'ozaco.bulk.at': at },
        droppedAttributes: 0,
        context: { traceId: 'b'.repeat(32), spanId: 'c'.repeat(16), flags: 1 },
        service: 'bulk',
        scope: { name: 'test' },
      },
    })

    unwrap(
      await run(function* () {
        const ready = createQueue<void, void>()
        const go = createQueue<void, void>()
        const sent = createQueue<void, void>()
        const counts = { forwarded: 0, fellBack: 0 }
        // the serialized size of every `_observe.batch` message the collector's carrier delivers
        const messages: number[] = []
        const worker = yield* fork(() =>
          scoped(function* () {
            yield* storage()
            // NATS' default `max_payload` (1 MB)
            yield* MemoryTransport.use({ prefix: 'bulk', link, maxPayloadBytes: 1024 * 1024 })
            yield* createServer({
              services: [todos],
              carrier: NetworkCarrier.use({ presence }),
              plugins: [
                ObservePlugin.use({
                  batch: { waitMs: 60_000, size: 10_000 },
                  cluster: { sendToCollector: true, heartbeatMs: 50 },
                }),
              ],
              name: 'app',
              instance: 'svc',
            })
            ready.add(undefined)
            // wait for the collector's heartbeat, then ONE flush carries every record
            yield* go.next()
            for (let at = 0; at < records; at += 1) {
              yield* Observe.actions.record(logAt(at))
            }
            yield* Observe.actions.flush()
            const stats = yield* Observe.actions.stats()
            counts.forwarded = stats.forwarded
            counts.fellBack = stats.fellBack
            sent.add(undefined)
            yield* sleep(60_000)
          }),
        )
        yield* ready.next()
        yield* scoped(function* () {
          yield* storage()
          yield* MemoryTransport.use({ prefix: 'bulk', link })
          const gateway = yield* createServer({
            services: [todos],
            carrier: NetworkCarrier.use({ presence }),
            plugins: [
              ObservePlugin.use({
                batch: { waitMs: 10 },
                cluster: { isCollector: true, heartbeatMs: 50 },
              }),
            ],
            name: 'app',
            instance: 'gw',
            role: 'gateway',
          })
          yield* gateway.start()
          // a tap next to the collector's own loop: every forwarded message as it arrives
          const carrier = (yield* Server.context.expect()).carrier!
          const events = yield* carrier.actions.events()
          yield* fork(function* () {
            for (;;) {
              const step = yield* events.next()
              if (step.done) {
                return
              }
              if (step.value.name === '_observe.batch') {
                messages.push(new TextEncoder().encode(JSON.stringify(step.value.payload)).length)
              }
            }
          })
          yield* sleep(250)
          go.add(undefined)
          yield* sent.next()
          yield* sleep(200)

          // ~1.5 MB in ONE flush went out as several messages, none over 512 KiB serialized
          expect(messages.length).toBeGreaterThanOrEqual(3)
          for (const bytes of messages) {
            expect(bytes).toBeLessThanOrEqual(512 * 1024)
          }

          // everything went over the wire — nothing fell back to the forwarder's own store
          expect(counts.fellBack).toBe(0)
          expect(counts.forwarded).toBeGreaterThanOrEqual(records)
          const stats = yield* Observe.actions.stats()
          expect(stats.received).toBeGreaterThanOrEqual(records)
          const view = (yield* Observe.actions.trace('b'.repeat(32)))!
          expect(view.logs.map(log => log.attributes['ozaco.bulk.at'])).toEqual(
            Array.from({ length: records }, (_, at) => at),
          )
          expect(view.logs[0]!.body).toBe(`bulk 0 ${filler}`)
          yield* gateway.stop()
        })
        yield* worker.halt()
      }),
    )
  })
})
