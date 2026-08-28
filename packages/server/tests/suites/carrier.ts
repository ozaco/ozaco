// oxlint-disable import/exports-last
import { action, createServer, Server, ServerErrors, service, stream } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt, createQueue, ensure, fork, run, scoped, sleep } from 'std:effect'
import { fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { NetworkCarrier } from 'server:impl/carrier/network'
import { z } from 'zod'

import { storage } from '../helpers'

export interface CarrierTarget {
  readonly label: string
  readonly enabled: boolean
  /** install the transport into the current scope (every call joins the same broker). */
  readonly transport: () => Operation<unknown>
}

/** The remote side: a `math` service another node calls. */
const math = service('math', {
  add: action.query(
    { input: z.object({ a: z.number(), b: z.number() }), output: z.number() },
    function* ({ input }) {
      return input.a + input.b
    },
  ),
  fail: action.query({ input: z.object({ tag: z.string() }) }, function* ({ input }) {
    return yield* fail(input.tag, `remote ${input.tag}`, 'from:math')
  }),
  slow: action.query(
    { input: z.object({ ms: z.number() }), output: z.string() },
    function* ({ input, ctx }) {
      seen.push('started')
      yield* ensure(() => {
        seen.push(ctx.signal.aborted ? 'aborted' : 'ended')
      })
      yield* sleep(input.ms)
      return 'late'
    },
  ),
  count: action.stream(
    { input: z.object({ n: z.number() }), output: stream.ndjson(z.number()) },
    function* ({ input }) {
      return {
        *[Symbol.iterator]() {
          let at = 0
          return {
            *next() {
              if (at >= input.n) {
                return { done: true as const, value: undefined }
              }
              yield* sleep(1)
              return { done: false as const, value: at++ }
            },
          }
        },
      }
    },
  ),
  size: action.mutation(
    { input: stream.bytes('application/octet-stream'), output: z.number() },
    function* ({ input }) {
      let total = 0
      const body = yield* stream.flow(input)
      for (;;) {
        const step = yield* body.next()
        if (step.done) {
          return total
        }
        total += step.value.length
      }
    },
  ),
  announce: action.mutation({ input: z.object({ what: z.string() }) }, function* ({ input, ctx }) {
    yield* ctx.emit('math.announced', input.what)
  }),
})
const seen: string[] = []

/** A service NOBODY registers — calls to it must fail fast, not hang. */
const ghost = service('ghost', { x: action.query({}, function* () {}) })

/** The local side: a `front` service that calls `math` over the carrier. */
const front = service('front', {
  sum: action.query(
    { input: z.object({ a: z.number(), b: z.number() }), output: z.number() },
    function* ({ input, ctx }) {
      return yield* ctx.call(math, 'add', input)
    },
  ),
})

export const runCarrierSuite = (target: CarrierTarget): void => {
  describe.skipIf(!target.enabled)(`carrier — ${target.label}`, () => {
    it('dispatches across nodes with failure fidelity, streams both ways, events, cancel, timeouts', async () => {
      seen.length = 0
      unwrap(
        await run(function* () {
          const ready = createQueue<void, void>()
          // node B hosts `math`
          const remote = yield* fork(() =>
            scoped(function* () {
              yield* storage()
              yield* target.transport()
              yield* createServer({
                services: [math],
                carrier: NetworkCarrier,
                name: 'app',
                instance: 'b',
              })
              ready.add(undefined)
              yield* sleep(60_000)
            }),
          )
          yield* ready.next()
          // node A hosts `front` and reaches `math` through the carrier
          yield* scoped(function* () {
            yield* storage()
            yield* target.transport()
            const server = yield* createServer({
              services: [front],
              carrier: NetworkCarrier,
              name: 'app',
              instance: 'a',
              timeoutMs: 2000,
            })
            yield* sleep(100)
            // rpc — directly and through a local action
            expect(yield* server.call(math, 'add', { a: 2, b: 3 })).toBe(5)
            expect(yield* server.call(front, 'sum', { a: 10, b: 5 })).toBe(15)

            // a remote failure keeps its tag, message and causes
            const failed = yield* attempt(server.call(math, 'fail', { tag: 'math.custom' }))
            expect((failed as AnyType).error).toBe('math.custom')
            expect((failed as AnyType).message).toBe('remote math.custom')
            expect((failed as AnyType).causes).toContain('from:math')
            // validation happens on the owner side too
            const invalid = yield* attempt(server.call(math, 'add', { a: 'x' } as AnyType))
            expect((invalid as AnyType).error).toBe(ServerErrors.Validation)
            // nobody serves it
            const nobody = yield* attempt(server.call(ghost, 'x', undefined, { timeoutMs: 500 }))
            expect([ServerErrors.Unavailable, ServerErrors.TimeoutPending]).toContain(
              (nobody as AnyType).error,
            )

            // output stream across the wire
            const out = yield* server.call(math, 'count', { n: 4 })
            const values: number[] = []
            const flow = yield* stream.flow(out as AnyType)
            for (;;) {
              const step = yield* flow.next()
              if (step.done) {
                break
              }
              values.push(step.value as number)
            }
            expect(values).toEqual([0, 1, 2, 3])

            // input stream across the wire
            const bytes = new Uint8Array(70_000)
            const size = yield* server.call(
              math,
              'size',
              stream.from(new Blob([bytes]).stream(), 'bytes:application/octet-stream') as AnyType,
            )
            expect(size).toBe(70_000)

            // events travel to every node (the emitter included)
            const events = yield* server.events('math.announced')
            yield* server.call(math, 'announce', { what: 'hello' })
            const event = yield* events.next()
            expect((event.value as AnyType).payload).toBe('hello')
            expect((event.value as AnyType).origin).toContain('#b')

            // a caller that stops waiting cancels the remote handler
            const pending = yield* fork(() => server.call(math, 'slow', { ms: 5000 }))
            yield* sleep(150)
            yield* pending.halt()
            yield* sleep(300)
            expect(seen).toEqual(['started', 'aborted'])

            // a deadline that passes is timeout-pending (the work may still be running)
            seen.length = 0
            const late = yield* attempt(server.call(math, 'slow', { ms: 1500 }, { timeoutMs: 200 }))
            expect((late as AnyType).error).toBe(ServerErrors.TimeoutPending)
            yield* sleep(1600)
            // the owner finished on its own: the caller's timeout does not cancel it
            expect(seen).toEqual(['started', 'ended'])

            // observability: the remote hop is a carrier span under the local request
            const kernel = yield* Server.actions.describe()
            expect(kernel.carrier).not.toBeNull()
          })
          yield* remote.halt()
        }),
      )
    })

    it('presence: unavailable at once, members appear, a leaving node drains then vanishes', async () => {
      seen.length = 0
      const presence = { heartbeatMs: 100, ttlMs: 300, waitMs: 300 }
      unwrap(
        await run(function* () {
          const ready = createQueue<void, void>()
          const stopB = createQueue<void, void>()
          const bDone = createQueue<void, void>()
          // node A comes up ALONE
          yield* scoped(function* () {
            yield* storage()
            yield* target.transport()
            const server = yield* createServer({
              services: [front, math],
              carrier: NetworkCarrier.use({ presence }),
              name: 'app',
              instance: 'a',
              hosted: ['front'],
              timeoutMs: 5000,
            })
            yield* sleep(150)
            // nobody hosts math: the answer is immediate, not a timeout
            const started = Date.now()
            const nobody = yield* attempt(server.call(math, 'add', { a: 1, b: 1 }))
            expect((nobody as AnyType).error).toBe(ServerErrors.Unavailable)
            expect(Date.now() - started).toBeLessThan(1000)
            expect(yield* server.members('math')).toEqual([])
            expect((yield* server.members('front')).map(member => member.instance)).toEqual(['a'])

            // node B arrives: A learns it within a heartbeat
            const remote = yield* fork(() =>
              scoped(function* () {
                yield* storage()
                yield* target.transport()
                const b = yield* createServer({
                  services: [math],
                  carrier: NetworkCarrier.use({ presence }),
                  name: 'app',
                  instance: 'b',
                })
                ready.add(undefined)
                yield* stopB.next()
                yield* b.stop()
                bDone.add(undefined)
              }),
            )
            yield* ready.next()
            for (let tries = 0; tries < 50; tries += 1) {
              if ((yield* server.members('math')).length > 0) {
                break
              }
              yield* sleep(20)
            }
            const members = yield* server.members('math')
            expect(members.map(member => member.instance)).toEqual(['b'])
            expect(members[0]!.version).toBe(math.version)
            expect(members[0]!.draining).toBe(false)
            expect(yield* server.call(math, 'add', { a: 2, b: 3 })).toBe(5)

            // B leaves while a call is in flight: the call finishes, B shows as draining,
            // then disappears and calls fail fast again
            const slow = yield* fork(() => server.call(math, 'slow', { ms: 400 }))
            yield* sleep(50)
            stopB.add(undefined)
            yield* sleep(50)
            expect((yield* server.members('math')).map(member => member.draining)).toEqual([true])
            expect(yield* slow).toBe('late')
            expect(seen).toEqual(['started', 'ended'])
            yield* bDone.next()
            yield* remote.halt()
            yield* sleep(presence.ttlMs + presence.heartbeatMs * 2)
            expect(yield* server.members('math')).toEqual([])
            const gone = yield* attempt(server.call(math, 'add', { a: 1, b: 1 }))
            expect((gone as AnyType).error).toBe(ServerErrors.Unavailable)
            yield* server.stop()
          })
        }),
      )
    })

    it('topology: a gateway-role node with no services serves the edge and forwards every call', async () => {
      unwrap(
        await run(function* () {
          const ready = createQueue<void, void>()
          const owner = yield* fork(() =>
            scoped(function* () {
              yield* storage()
              yield* target.transport()
              yield* createServer({
                services: [math],
                carrier: NetworkCarrier,
                name: 'app',
                instance: 'svc',
              })
              ready.add(undefined)
              yield* sleep(60_000)
            }),
          )
          yield* ready.next()
          yield* scoped(function* () {
            yield* storage()
            yield* target.transport()
            // the gateway knows the service DEFINITIONS (for routes, validation, docs) but hosts none
            const gateway = yield* createServer({
              services: [math],
              carrier: NetworkCarrier,
              name: 'app',
              instance: 'gw',
              role: 'gateway',
            })
            yield* sleep(100)
            expect(yield* gateway.call(math, 'add', { a: 1, b: 1 })).toBe(2)
            yield* gateway.stop()
          })
          yield* owner.halt()
        }),
      )
    })
  })
}
