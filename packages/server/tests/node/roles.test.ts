import { action, createServer, ServerErrors, service } from 'server:core'
import { attempt, createQueue, fork, run, scoped, sleep, until } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { NetworkCarrier } from 'server:impl/carrier/network'
import { BunEdge } from 'server:impl/edge/bun'
import { createLink, MemoryTransport } from 'transport:impl/memory'

import { storage, todos } from '../helpers'

describe('server — roles', () => {
  it('a gateway node serves the edge; a service node does the work; health tells who is who', async () => {
    const link = createLink()
    unwrap(
      await run(function* () {
        const ready = createQueue<void, void>()
        const worker = yield* fork(() =>
          scoped(function* () {
            yield* storage()
            yield* install(MemoryTransport, { prefix: 'app', link })
            const app = yield* createServer({
              services: [todos],
              carrier: NetworkCarrier,
              role: 'service',
              name: 'app',
              instance: 'svc',
            })
            const info = yield* app.start()
            expect(info).toMatchObject({ role: 'service', hosted: ['todos'], url: null })
            ready.add(undefined)
            yield* sleep(60_000)
          }),
        )
        yield* ready.next()
        yield* scoped(function* () {
          yield* storage()
          yield* install(MemoryTransport, { prefix: 'app', link })
          const gateway = yield* createServer({
            services: [todos],
            edge: BunEdge,
            carrier: NetworkCarrier,
            role: 'gateway',
            name: 'app',
            instance: 'gw',
            listen: { port: 0 },
          })
          const info = yield* gateway.start()
          expect(info.hosted).toEqual([])
          const health = yield* until(fetch(`${info.url}/_health`))
          const body = (yield* until(health.json())) as AnyType
          expect(body).toMatchObject({ ok: true, ready: true, role: 'gateway', hosted: [] })
          expect(body.members.todos.map((member: AnyType) => member.instance)).toEqual(['svc'])
          // an HTTP request at the gateway is served by the service node over the carrier
          const created = yield* until(
            fetch(`${info.url}/todos/create`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ title: 'via gateway' }),
            }),
          )
          expect(created.status).toBe(200)
          expect(((yield* until(created.json())) as AnyType).title).toBe('via gateway')
          yield* gateway.stop()
          expect((yield* gateway.info()).started).toBe(false)
        })
        yield* worker.halt()
      }),
    )
  })

  it('readiness: start waits for dependsOn; health is 503 until then; a missing dependency fails start', async () => {
    const link = createLink()
    const presence = { heartbeatMs: 100, ttlMs: 300, waitMs: 100 }
    unwrap(
      await run(function* () {
        // nobody hosts todos: a gateway that depends on it cannot become ready
        yield* scoped(function* () {
          yield* storage()
          yield* install(MemoryTransport, { prefix: 'ready', link })
          const lonely = yield* createServer({
            services: [todos],
            edge: BunEdge,
            carrier: NetworkCarrier.use({ presence }),
            role: 'gateway',
            name: 'app',
            instance: 'gw0',
            listen: { port: 0 },
            readyTimeoutMs: 300,
          })
          const outcome = yield* attempt(lonely.start())
          expect((outcome as AnyType).error).toBe(ServerErrors.Unavailable)
          const health = yield* lonely.health()
          expect(health.ready).toBe(false)
          expect(health.members.todos).toEqual([])
          yield* lonely.stop()
        })

        // the service comes up late: the gateway's start resolves once it is there
        const ready = createQueue<void, void>()
        const worker = yield* fork(() =>
          scoped(function* () {
            yield* sleep(200)
            yield* storage()
            yield* install(MemoryTransport, { prefix: 'ready', link })
            const app = yield* createServer({
              services: [todos],
              carrier: NetworkCarrier.use({ presence }),
              role: 'service',
              name: 'app',
              instance: 'svc',
            })
            yield* app.start()
            ready.add(undefined)
            yield* sleep(60_000)
          }),
        )
        yield* scoped(function* () {
          yield* storage()
          yield* install(MemoryTransport, { prefix: 'ready', link })
          const gateway = yield* createServer({
            services: [todos],
            edge: BunEdge,
            carrier: NetworkCarrier.use({ presence }),
            role: 'gateway',
            name: 'app',
            instance: 'gw1',
            listen: { port: 0 },
            readyTimeoutMs: 5000,
          })
          const startedAt = Date.now()
          const info = yield* gateway.start()
          expect(info.ready).toBe(true)
          expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150)
          const health = yield* until(fetch(`${info.url}/_health`))
          expect(health.status).toBe(200)
          yield* gateway.stop()
        })
        yield* ready.next()
        yield* worker.halt()
      }),
    )
  })

  it('hosted: [] is refused off-gateway; a service node starts without waiting for anyone', async () => {
    const link = createLink()
    unwrap(
      await run(function* () {
        // the silent trap, refused loudly: hosting nothing while not being a gateway
        yield* scoped(function* () {
          yield* storage()
          yield* install(MemoryTransport, { prefix: 'trap', link })
          const outcome = yield* attempt(
            createServer({
              services: [todos],
              carrier: NetworkCarrier,
              role: 'monolith',
              hosted: [],
              name: 'app',
            }),
          )
          expect((outcome as AnyType).error).toBe(ServerErrors.Configuration)
        })

        // a service node's readiness is ITS OWN services: `other` is declared, NOBODY hosts
        // it, and start still resolves at once (the old default waited for it and died)
        const other = service('other', {
          ping: action.query({}, function* () {}),
        })
        yield* scoped(function* () {
          yield* storage()
          yield* install(MemoryTransport, { prefix: 'trap', link })
          const app = yield* createServer({
            services: [todos, other],
            carrier: NetworkCarrier,
            role: 'service',
            hosted: ['todos'],
            name: 'app',
            instance: 'first-pod',
            readyTimeoutMs: 10_000,
          })
          const startedAt = Date.now()
          const info = yield* app.start()
          expect(info.ready).toBe(true)
          expect(Date.now() - startedAt).toBeLessThan(1000)
          yield* app.stop()
        })
      }),
    )
  })
})
