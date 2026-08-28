import { createServer, Observe } from 'server:core'
import { ObservePlugin } from 'server:plugins'
import { createQueue, fork, run, scoped, sleep } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { NetworkCarrier } from 'server:impl/carrier/network'
import { createLink, MemoryTransport } from 'transport:impl/memory'

import { storage, todos } from '../helpers'

const presence = { heartbeatMs: 100, ttlMs: 300, waitMs: 100 }

describe('observe — cluster', () => {
  it('forwarded rows land in the collector: one request tree across two nodes, per-instance stats', async () => {
    const link = createLink()
    unwrap(
      await run(function* () {
        const ready = createQueue<void, void>()
        // the service node forwards everything it observes
        const worker = yield* fork(() =>
          scoped(function* () {
            yield* storage()
            yield* install(MemoryTransport, { prefix: 'obs', link })
            const svc = yield* createServer({
              services: [todos],
              carrier: NetworkCarrier.use({ presence }),
              plugins: [
                ObservePlugin.use({
                  batch: { ms: 10 },
                  forward: true,
                  collectorHeartbeatMs: 50,
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
          yield* install(MemoryTransport, { prefix: 'obs', link })
          const gateway = yield* createServer({
            services: [todos],
            carrier: NetworkCarrier.use({ presence }),
            plugins: [
              ObservePlugin.use({
                batch: { ms: 10 },
                collect: true,
                collectorHeartbeatMs: 50,
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

          const page = yield* Observe.actions.query({ service: 'todos', action: 'create' })
          expect(page.requests.length).toBeGreaterThan(0)
          const view = yield* Observe.actions.request(page.requests[0]!.request_id)
          expect(view).not.toBeNull()
          const instances = new Set(view!.spans.map(span => span.instance))
          // the gateway's dispatch/carrier spans AND the service node's dispatch span, one tree
          expect(instances.has('gw')).toBe(true)
          expect(instances.has('svc')).toBe(true)
          const remote = view!.spans.find(
            span => span.instance === 'svc' && span.kind === 'dispatch',
          )
          expect(remote?.name).toBe('todos.create')
          // the service node's log line travelled too
          expect(view!.logs.some(log => log.msg === 'creating')).toBe(true)

          const cluster = yield* Observe.actions.cluster()
          expect(cluster.members.todos!.map(member => member.instance)).toEqual(['svc'])
          expect(cluster.instances.map(entry => entry.instance).toSorted()).toEqual(['gw', 'svc'])
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
        yield* install(MemoryTransport, { prefix: 'lonely', link })
        const server = yield* createServer({
          services: [todos],
          carrier: NetworkCarrier.use({ presence }),
          plugins: [ObservePlugin.use({ batch: { ms: 10 }, forward: true })],
          name: 'app',
          instance: 'alone',
        })
        yield* server.start()
        yield* server.call(todos, 'create', { title: 'kept' })
        yield* sleep(50)
        const page = yield* Observe.actions.query({ action: 'create' })
        expect(page.requests).toHaveLength(1)
        expect(page.requests[0]!.instance).toBe('alone')
        yield* server.stop()
      }),
    )
    unwrap(
      await run(function* () {
        yield* storage()
        yield* install(MemoryTransport, { prefix: 'lonely2', link })
        const server = yield* createServer({
          services: [todos],
          carrier: NetworkCarrier.use({ presence }),
          plugins: [ObservePlugin.use({ batch: { ms: 10 }, forward: true, fallback: 'drop' })],
          name: 'app',
          instance: 'alone',
        })
        yield* server.start()
        yield* server.call(todos, 'create', { title: 'dropped' })
        yield* sleep(50)
        expect((yield* Observe.actions.query({ action: 'create' })).requests).toHaveLength(0)
        yield* server.stop()
      }),
    )
  })
})
