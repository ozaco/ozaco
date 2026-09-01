// oxlint-disable import/exports-last
import type { Flow, Operation } from 'std:effect'
import {
  attempt,
  createQueue,
  ensure,
  fork,
  race,
  run,
  scoped,
  sleep,
  until,
  useContext,
} from 'std:effect'
import { install } from 'std:plugin'
import { fail, isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'
import { Transport, TransportErrors } from 'transport:core'

/** One backend under end-to-end test. */
export interface TransportTarget {
  /** Must equal the impl's `info.transport`. */
  readonly label: string
  /** false → the whole suite is skipped (e.g. no live server configured). */
  readonly enabled: boolean
  /** Install a transport into the current scope under an application prefix (default
   * `'suite'`). Every call must join the SAME broker (so two scopes can talk) — a shared memory
   * link, one NATS server, one Redis. */
  readonly install: (prefix?: string) => Operation<unknown>
  readonly expect: {
    readonly receipts: boolean
    readonly requestReply: boolean
    readonly groups: boolean
    readonly durable: boolean
  }
  /** How long the backend waits before it redelivers an unacked durable message (the suite
   * waits a little longer than this). Default 1000. */
  readonly ackWaitMs?: number | undefined
}

const unique = (prefix: string): string => `${prefix}.${crypto.randomUUID().slice(0, 8)}`

/** A Flow over a plain array, closing with `close`. */
const arrayFlow = <T, C>(items: readonly T[], close: C): Flow<T, C> => ({
  *[Symbol.iterator]() {
    let index = 0
    return {
      *next() {
        if (index < items.length) {
          return { done: false as const, value: items[index++]! }
        }
        return { done: true as const, value: close }
      },
    }
  },
})

const bytes = (size: number): Uint8Array => {
  const out = new Uint8Array(size)
  crypto.getRandomValues(out)
  return out
}

const checksum = async (data: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The full-surface suite every transport must pass: the five planes, groups, failure fidelity,
 * lanes with backpressure, byte integrity, lifecycle — and the cross-scope case (two installs
 * talking through the backend).
 */

/** Transports mint ids through the installed IO: the suite provides one per scope. */
function* installIo(): Operation<void> {
  yield* install(BunIO)
}

export const runTransportSuite = (target: TransportTarget): void => {
  describe.skipIf(!target.enabled)(`transport — ${target.label}`, () => {
    it('reports identity and capabilities', async () => {
      unwrap(
        await run(function* () {
          yield* installIo()
          yield* target.install()
          const info = yield* useContext(Transport)
          expect(info.transport).toBe(target.label)
          expect(info.capabilities.receipts).toBe(target.expect.receipts)
          expect(info.capabilities.requestReply).toBe(target.expect.requestReply)
          expect(info.capabilities.groups).toBe(target.expect.groups)
          expect(info.capabilities.durable).toBe(target.expect.durable)
          expect(info.prefix).toBe('suite')
        }),
      )
    })

    it('prefix: installs under different application prefixes never hear each other', async () => {
      unwrap(
        await run(function* () {
          const topic = unique('iso')
          const ready = createQueue<void, void>()
          const other = yield* fork(() =>
            scoped(function* () {
              yield* installIo()
              yield* target.install('other')
              const sub = yield* Transport.actions.subscribe<string>(topic)
              ready.add(undefined)
              const step = yield* sub.next()
              return (step as AnyType).value.value as string
            }),
          )
          yield* ready.next()
          yield* installIo()
          yield* target.install()
          const mine = yield* Transport.actions.subscribe<string>(topic)
          yield* sleep(50)
          yield* Transport.actions.publish(topic, 'for suite only')
          const step = yield* mine.next()
          expect((step as AnyType).value.value).toBe('for suite only')
          expect((step as AnyType).value.topic).toBe(topic)
          // the other application sees nothing of it — only its own traffic
          yield* scoped(function* () {
            yield* installIo()
            yield* target.install('other')
            yield* Transport.actions.publish(topic, 'for other only')
          })
          expect(yield* other).toBe('for other only')
        }),
      )
    })

    it('data: publishes codec values with headers and raw bytes, matches wildcards', async () => {
      unwrap(
        await run(function* () {
          yield* installIo()
          yield* target.install()
          const root = unique('data')
          const exact = yield* Transport.actions.subscribe<{ n: number }>(`${root}.a.b`)
          const star = yield* Transport.actions.subscribe(`${root}.*.b`)
          const tail = yield* Transport.actions.subscribe(`${root}.>`)

          yield* Transport.actions.publish(
            `${root}.a.b`,
            { n: 1 },
            { headers: { 'x-trace': 't1' } },
          )
          const first = yield* exact.next()
          expect(first.done).toBe(false)
          expect((first as AnyType).value.value).toEqual({ n: 1 })
          expect((first as AnyType).value.topic).toBe(`${root}.a.b`)
          expect((first as AnyType).value.headers['x-trace']).toBe('t1')
          expect(((yield* star.next()) as AnyType).value.value).toEqual({ n: 1 })
          expect(((yield* tail.next()) as AnyType).value.value).toEqual({ n: 1 })

          // `*` is exactly one segment: a.b.c does not match *.b but does match >
          yield* Transport.actions.publish(`${root}.a.b.c`, { n: 2 })
          expect(((yield* tail.next()) as AnyType).value.value).toEqual({ n: 2 })

          const raw = yield* Transport.actions.subscribe<Uint8Array>(`${root}.raw`)
          yield* Transport.actions.publish(`${root}.raw`, new Uint8Array([1, 2, 3]))
          const got = ((yield* raw.next()) as AnyType).value.value as Uint8Array
          expect(got).toBeInstanceOf(Uint8Array)
          expect([...got]).toEqual([1, 2, 3])
        }),
      )
    })

    it('transient: a transient publish reaches live transient subscribers only, never a durable', async () => {
      unwrap(
        await run(function* () {
          yield* installIo()
          yield* target.install()
          const topic = unique('transient')
          const live = yield* Transport.actions.subscribe<{ beat: number }>(`${topic}.>`, {
            transient: true,
          })
          yield* sleep(50)
          yield* Transport.actions.publish(`${topic}.a`, { beat: 1 }, { transient: true })
          const first = yield* live.next()
          expect((first as AnyType).value.value).toEqual({ beat: 1 })
          expect((first as AnyType).value.topic).toBe(`${topic}.a`)
          // a transient subscription may not be durable
          const bad = yield* attempt(() =>
            Transport.actions.subscribe(topic, { transient: true, durable: 'x' }),
          )
          expect(isFailure(bad)).toBe(true)
        }),
      )
    })

    it.skipIf(!target.expect.groups)(
      'groups: each message reaches exactly one member',
      async () => {
        unwrap(
          await run(function* () {
            yield* installIo()
            yield* target.install()
            const topic = unique('group')
            const received: number[][] = [[], []]
            const a = yield* Transport.actions.subscribe<number>(topic, { group: 'workers' })
            const b = yield* Transport.actions.subscribe<number>(topic, { group: 'workers' })
            const drain = (sub: typeof a, into: number[]) =>
              fork(function* () {
                for (;;) {
                  const step = yield* sub.next()
                  if (step.done) {
                    return
                  }
                  into.push(step.value.value)
                }
              })
            yield* drain(a, received[0]!)
            yield* drain(b, received[1]!)
            for (let i = 0; i < 10; i++) {
              yield* Transport.actions.publish(topic, i)
            }
            yield* sleep(200)
            const all = [...received[0]!, ...received[1]!].toSorted((x, y) => x - y)
            expect(all).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
            expect(received[0]!.length).toBeGreaterThan(0)
            expect(received[1]!.length).toBeGreaterThan(0)
          }),
        )
      },
    )

    it('event: an emitter receives messages until stopped', async () => {
      unwrap(
        await run(function* () {
          yield* installIo()
          yield* target.install()
          const topic = unique('event')
          const seen: string[] = []
          const { emitter, stop } = yield* Transport.actions.events<string>(topic)
          emitter.on('message', message => {
            seen.push(message.value)
          })
          yield* Transport.actions.emit(topic, 'one')
          yield* Transport.actions.emit(topic, 'two')
          yield* sleep(100)
          expect(seen).toEqual(['one', 'two'])
          yield* stop()
          yield* Transport.actions.emit(topic, 'three')
          yield* sleep(100)
          expect(seen).toEqual(['one', 'two'])
        }),
      )
    })

    it('package: request/reply carries values and failures with fidelity', async () => {
      unwrap(
        await run(function* () {
          yield* installIo()
          yield* target.install()
          const topic = unique('rpc')
          yield* Transport.actions.serve<{ a: number; b: number }, number>(topic, function* (args) {
            if (args.b === 0) {
              return yield* fail('math.divide-by-zero', 'b must not be 0', `a=${args.a}`)
            }
            return args.a / args.b
          })
          expect(yield* Transport.actions.request<number>(topic, { a: 6, b: 3 })).toBe(2)

          const failed = yield* attempt(Transport.actions.request<number>(topic, { a: 1, b: 0 }))
          expect(isFailure(failed)).toBe(true)
          expect((failed as AnyType).error).toBe('math.divide-by-zero')
          expect((failed as AnyType).message).toBe('b must not be 0')
          // the responder's causes come first; the dispatch breadcrumbs std appends follow
          expect((failed as AnyType).causes[0]).toBe('a=1')
        }),
      )
    })

    it('package: timeouts and no-responders are transport failures', async () => {
      unwrap(
        await run(function* () {
          yield* installIo()
          yield* target.install()
          const slow = unique('slow')
          yield* Transport.actions.serve(slow, function* () {
            yield* sleep(500)
            return 'late'
          })
          const timedOut = yield* attempt(Transport.actions.request(slow, {}, { timeoutMs: 50 }))
          expect((timedOut as AnyType).error).toBe(TransportErrors.Timeout)

          const nobody = yield* attempt(
            Transport.actions.request(unique('nobody'), {}, { timeoutMs: 300 }),
          )
          expect(isFailure(nobody)).toBe(true)
          const tag = (nobody as AnyType).error
          expect(
            target.expect.receipts || target.expect.requestReply
              ? tag === TransportErrors.NoResponders
              : tag === TransportErrors.Timeout,
          ).toBe(true)
        }),
      )
    })

    it('package: abandoning a request cancels the handler on the serving side', async () => {
      unwrap(
        await run(function* () {
          yield* installIo()
          yield* target.install()
          const topic = unique('cancel')
          const seen: string[] = []
          yield* Transport.actions.serve<number, string>(topic, function* (ms) {
            seen.push('started')
            yield* ensure(() => {
              seen.push('halted')
            })
            yield* sleep(ms)
            seen.push('finished')
            return 'done'
          })
          const pending = yield* fork(() => Transport.actions.request<string>(topic, 5000))
          yield* sleep(150)
          expect(seen).toEqual(['started'])
          yield* pending.halt()
          // the cancel travels the wire: the handler is halted, never finishes
          yield* sleep(200)
          expect(seen).toEqual(['started', 'halted'])
          // the server keeps serving afterwards
          expect(yield* Transport.actions.request<string>(topic, 5)).toBe('done')
          // a request that merely timed out does NOT cancel: the handler runs to completion
          seen.length = 0
          const late = yield* attempt(
            Transport.actions.request<string>(topic, 300, { timeoutMs: 50 }),
          )
          expect((late as AnyType).error).toBe(TransportErrors.Timeout)
          yield* sleep(400)
          expect(seen).toContain('finished')
        }),
      )
    })

    it.skipIf(!target.expect.groups)('package: a served group balances requests', async () => {
      unwrap(
        await run(function* () {
          yield* installIo()
          yield* target.install()
          const topic = unique('balance')
          const hits = { a: 0, b: 0 }
          yield* Transport.actions.serve(
            topic,
            function* () {
              hits.a += 1
              return 'a'
            },
            { group: 'g' },
          )
          yield* Transport.actions.serve(
            topic,
            function* () {
              hits.b += 1
              return 'b'
            },
            { group: 'g' },
          )
          const answers: string[] = []
          for (let i = 0; i < 8; i++) {
            answers.push(yield* Transport.actions.request<string>(topic, i))
          }
          expect(answers).toHaveLength(8)
          expect(hits.a + hits.b).toBe(8)
          expect(hits.a).toBeGreaterThan(0)
          expect(hits.b).toBeGreaterThan(0)
        }),
      )
    })

    it('flow: pipes values in order and closes with the close value', async () => {
      unwrap(
        await run(function* () {
          yield* installIo()
          yield* target.install()
          const topic = unique('flow')
          const items = Array.from({ length: 100 }, (_, i) => ({ i }))
          const consumer = yield* fork(function* () {
            const sub = yield* Transport.actions.flow<{ i: number }, string>(topic, { credit: 8 })
            const got: number[] = []
            for (;;) {
              const step = yield* sub.next()
              if (step.done) {
                return { got, close: step.value }
              }
              got.push(step.value.i)
            }
          })
          const close = yield* Transport.actions.pipe(topic, arrayFlow(items, 'all-sent'), {
            credit: 8,
          })
          expect(close).toBe('all-sent')
          const result = yield* consumer
          expect(result.got).toEqual(items.map(item => item.i))
          expect(result.close).toBe('all-sent')
        }),
      )
    })

    it('flow: a failing source ends the consumer with the failure; no consumer → timeout', async () => {
      unwrap(
        await run(function* () {
          yield* installIo()
          yield* target.install()
          const topic = unique('flow-fail')
          const failing: Flow<number, void> = {
            *[Symbol.iterator]() {
              let n = 0
              return {
                *next() {
                  n += 1
                  if (n > 2) {
                    return yield* fail('source.broken', 'upstream died')
                  }
                  return { done: false as const, value: n }
                },
              }
            },
          }
          const consumer = yield* fork(function* () {
            const sub = yield* Transport.actions.flow<number, void>(topic)
            const got: number[] = []
            for (;;) {
              const step = yield* sub.next()
              if (step.done) {
                return { got, close: step.value }
              }
              got.push(step.value)
            }
          })
          const outcome = yield* attempt(Transport.actions.pipe(topic, failing))
          expect((outcome as AnyType).error).toBe('source.broken')
          const result = yield* consumer
          expect(result.got).toEqual([1, 2])
          expect(isFailure(result.close)).toBe(true)
          expect((result.close as AnyType).error).toBe('source.broken')

          const lonely = yield* attempt(
            Transport.actions.pipe(unique('lonely'), arrayFlow([1], 'x'), { timeoutMs: 100 }),
          )
          expect((lonely as AnyType).error).toBe(TransportErrors.Timeout)
        }),
      )
    })

    it('flow: a consumer that leaves mid-lane starves the producer into transport.lane-full', async () => {
      unwrap(
        await run(function* () {
          yield* installIo()
          yield* target.install()
          const topic = unique('leave')
          const consumer = yield* fork(() =>
            scoped(function* () {
              const sub = yield* Transport.actions.flow<number, void>(topic, { credit: 2 })
              const first = yield* sub.next()
              return (first as AnyType).value as number
            }),
          )
          // the consumer takes one value and its scope closes: no more credit ever comes
          const outcome = yield* attempt(
            Transport.actions.pipe(topic, arrayFlow([1, 2, 3, 4, 5, 6], 'done'), {
              credit: 2,
              timeoutMs: 300,
            }),
          )
          expect(yield* consumer).toBe(1)
          expect((outcome as AnyType).error).toBe(TransportErrors.LaneFull)
        }),
      )
    })

    it('flow: a producer halted mid-lane closes the consumer with transport.closed', async () => {
      unwrap(
        await run(function* () {
          yield* installIo()
          yield* target.install()
          const topic = unique('halt')
          const slow: Flow<number, string> = {
            *[Symbol.iterator]() {
              let n = 0
              return {
                *next() {
                  n += 1
                  if (n > 2) {
                    // the third value never comes: the producer is cancelled while waiting
                    yield* sleep(10_000)
                  }
                  return { done: false as const, value: n }
                },
              }
            },
          }
          const consumer = yield* fork(function* () {
            const sub = yield* Transport.actions.flow<number, string>(topic)
            const got: number[] = []
            for (;;) {
              const step = yield* sub.next()
              if (step.done) {
                return { got, close: step.value }
              }
              got.push(step.value)
            }
          })
          const producer = yield* fork(() => Transport.actions.pipe(topic, slow))
          yield* sleep(300)
          yield* producer.halt()
          const result = yield* consumer
          expect(result.got).toEqual([1, 2])
          expect((result.close as AnyType).error).toBe(TransportErrors.Closed)
        }),
      )
    })

    it('flow: credit bounds how far the producer runs ahead of a slow consumer', async () => {
      unwrap(
        await run(function* () {
          yield* installIo()
          yield* target.install()
          const topic = unique('credit')
          let sent = 0
          const counted: Flow<number, void> = {
            *[Symbol.iterator]() {
              return {
                *next() {
                  if (sent >= 50) {
                    return { done: true as const, value: undefined }
                  }
                  sent += 1
                  return { done: false as const, value: sent }
                },
              }
            },
          }
          const gate = createQueue<void, void>()
          const consumer = yield* fork(function* () {
            const sub = yield* Transport.actions.flow<number, void>(topic, { credit: 4 })
            // take two, then block until released
            yield* sub.next()
            yield* sub.next()
            yield* gate.next()
            for (;;) {
              const step = yield* sub.next()
              if (step.done) {
                return
              }
            }
          })
          const producer = yield* fork(() =>
            Transport.actions.pipe(topic, counted, { credit: 4, timeoutMs: 2000 }),
          )
          yield* sleep(300)
          // 4 credits + the half-window top-up after 2 consumed + one value pulled ahead — never
          // the whole source
          expect(sent).toBeLessThanOrEqual(7)
          gate.add(undefined)
          yield* producer
          yield* consumer
          expect(sent).toBe(50)
        }),
      )
    })

    it('stream: bytes written to a writable arrive intact on the readable', async () => {
      const payload = bytes(512 * 1024)
      const expected = await checksum(payload)
      const received = unwrap(
        await run(function* () {
          yield* installIo()
          yield* target.install()
          const topic = unique('stream')
          const reader = yield* fork(function* () {
            const readable = yield* Transport.actions.readable(topic, { credit: 8 })
            return yield* until(new Response(readable).arrayBuffer())
          })
          const writable = yield* Transport.actions.writable(topic, { credit: 8 })
          yield* until(
            (async () => {
              const writer = writable.getWriter()
              // sequential on purpose: each write resolves once its chunk is on the wire
              for (let offset = 0; offset < payload.length; offset += 16 * 1024) {
                // oxlint-disable-next-line no-await-in-loop
                await writer.write(payload.subarray(offset, offset + 16 * 1024))
              }
              await writer.close()
            })(),
          )
          return new Uint8Array(yield* reader)
        }),
      )
      expect(received.length).toBe(payload.length)
      expect(await checksum(received)).toBe(expected)
    })

    it('stream: one huge write is framed to the budget, whatever the backend accepts', async () => {
      // the caller writes 4 MB in ONE go; what travels is `frameBytes` at a time, so a source
      // of any size (100 MB, 1 GB, 10 GB) rides the same bounded frames
      const frameBytes = 64 * 1024
      const payload = bytes(4 * 1024 * 1024)
      const expected = await checksum(payload)
      const seen = unwrap(
        await run(function* () {
          yield* installIo()
          yield* target.install()
          const topic = unique('huge')

          const reader = yield* fork(function* () {
            const readable = yield* Transport.actions.readable(topic, { credit: 8, frameBytes })

            return yield* until(
              (async () => {
                const stream = readable.getReader()
                const parts: Uint8Array[] = []
                let largest = 0

                for (;;) {
                  // oxlint-disable-next-line no-await-in-loop
                  const step = await stream.read()

                  if (step.done) {
                    break
                  }

                  largest = Math.max(largest, step.value.length)
                  parts.push(step.value)
                }

                return { parts, largest }
              })(),
            )
          })

          const writable = yield* Transport.actions.writable(topic, { credit: 8, frameBytes })
          yield* until(
            (async () => {
              const writer = writable.getWriter()
              await writer.write(payload)
              await writer.close()
            })(),
          )

          return yield* reader
        }),
      )
      const joined = new Uint8Array(seen.parts.reduce((sum, part) => sum + part.length, 0))
      let offset = 0

      for (const part of seen.parts) {
        joined.set(part, offset)
        offset += part.length
      }

      expect(joined.length).toBe(payload.length)
      expect(await checksum(joined)).toBe(expected)
      // one write, many frames — none of them the whole thing (a backend with a tighter
      // payload limit clamps the budget further, so the count is a floor, not an equality)
      expect(seen.largest).toBeLessThanOrEqual(frameBytes)
      expect(seen.parts.length).toBeGreaterThanOrEqual(payload.length / frameBytes)
    })

    it.skipIf(!target.expect.groups)(
      'group: the same group name under two subscription prefixes is two groups',
      async () => {
        const topic = unique('gp')
        unwrap(
          await run(function* () {
            yield* installIo()
            yield* target.install()
            const billing = yield* Transport.actions.subscribe<number>(topic, {
              group: 'workers',
              prefix: 'billing',
            })
            const audit = yield* Transport.actions.subscribe<number>(topic, {
              group: 'workers',
              prefix: 'audit',
            })
            yield* sleep(50)
            yield* Transport.actions.publish(topic, 7)
            // one message, one member per group — both groups see it
            expect(((yield* billing.next()) as AnyType).value.value).toBe(7)
            expect(((yield* audit.next()) as AnyType).value.value).toBe(7)
          }),
        )
      },
    )

    it('around: middleware wraps the data plane once for every backend', async () => {
      unwrap(
        await run(function* () {
          yield* installIo()
          yield* target.install()
          const topic = unique('mw')
          const seen: string[] = []
          yield* Transport.around({
            publish: ([where, value, options]: AnyType[], next: AnyType) =>
              (function* () {
                seen.push(`${where}:${String(value)}`)
                return yield* next(where, value, options)
              })(),
          })
          const sub = yield* Transport.actions.subscribe<string>(topic)
          yield* sleep(50)
          yield* Transport.actions.publish(topic, 'wrapped')
          expect(((yield* sub.next()) as AnyType).value.value).toBe('wrapped')
          expect(seen).toEqual([`${topic}:wrapped`])
        }),
      )
    })

    it.skipIf(!target.expect.durable)(
      'durable: messages published while no member pulls wait for the next one; ack settles them',
      async () => {
        const topic = unique('durable')
        const durable = unique('d')
        const ackWaitMs = target.ackWaitMs ?? 1000
        unwrap(
          await run(function* () {
            yield* installIo()
            yield* target.install()
            // the consumer is born now: what came before it is not its business
            yield* Transport.actions.publish(topic, 'before')
            yield* scoped(function* () {
              const sub = yield* Transport.actions.subscribe<string>(topic, { durable })
              yield* sleep(50)
              yield* Transport.actions.publish(topic, 'one')
              const first = yield* sub.next()
              expect((first as AnyType).value.value).toBe('one')
              yield* (first as AnyType).value.ack()
            })
            // nobody pulls: the backend holds these
            yield* Transport.actions.publish(topic, 'two')
            yield* Transport.actions.publish(topic, 'three')
            const got: string[] = []
            yield* scoped(function* () {
              const sub = yield* Transport.actions.subscribe<string>(topic, { durable })
              let naked = false
              // `nak` hands a message back: it is delivered again (order is the backend's)
              while (got.length < 3) {
                const step = yield* sub.next()
                const message = (step as AnyType).value
                got.push(message.value)
                if (message.value === 'two' && !naked) {
                  naked = true
                  yield* message.nak()
                } else {
                  yield* message.ack()
                }
              }
            })
            expect(got.toSorted()).toEqual(['three', 'two', 'two'])
            // a member that dies holding a message: the message is redelivered to the next one
            yield* scoped(function* () {
              const sub = yield* Transport.actions.subscribe<string>(topic, { durable })
              yield* sleep(50)
              yield* Transport.actions.publish(topic, 'four')
              const step = yield* sub.next()
              expect((step as AnyType).value.value).toBe('four')
            })
            const redelivered = yield* scoped(function* () {
              const sub = yield* Transport.actions.subscribe<string>(topic, { durable })
              const step = yield* race([
                sub.next(),
                (function* () {
                  yield* sleep(ackWaitMs * 3 + 500)
                  return { done: true as const, value: undefined }
                })(),
              ])
              if (!(step as AnyType).done) {
                yield* (step as AnyType).value.ack()
              }
              return (step as AnyType).done ? null : ((step as AnyType).value.value as string)
            })
            expect(redelivered).toBe('four')
          }),
        )
      },
    )

    it.skipIf(!target.expect.durable)(
      'durable: a consumer created on one node keeps what another node publishes right away',
      async () => {
        const topic = unique('born')
        const durable = unique('d')
        unwrap(
          await run(function* () {
            const ready = createQueue<void, void>()
            const consumer = yield* fork(() =>
              scoped(function* () {
                yield* installIo()
                yield* target.install()
                const sub = yield* Transport.actions.subscribe<string>(topic, { durable })
                ready.add(undefined)
                const step = yield* sub.next()
                yield* (step as AnyType).value.ack()
                return (step as AnyType).value.value as string
              }),
            )
            yield* ready.next()
            yield* scoped(function* () {
              yield* installIo()
              yield* target.install()
              // no grace period: the consumer exists, so the broker must keep this
              yield* Transport.actions.publish(topic, 'immediately')
            })
            expect(yield* consumer).toBe('immediately')
          }),
        )
      },
    )

    it.skipIf(!target.expect.durable)(
      'durable: members sharing a name share the work; a subscription prefix makes it another consumer',
      async () => {
        const topic = unique('shared')
        const durable = unique('d')
        unwrap(
          await run(function* () {
            yield* installIo()
            yield* target.install()
            const left = yield* Transport.actions.subscribe<number>(topic, { durable })
            const right = yield* Transport.actions.subscribe<number>(topic, { durable })
            const audit = yield* Transport.actions.subscribe<number>(topic, {
              durable,
              prefix: 'audit',
            })
            yield* sleep(50)
            for (let n = 0; n < 6; n += 1) {
              yield* Transport.actions.publish(topic, n)
            }
            // the two members see every message exactly once between them
            const seen: number[] = []
            const take = function* (sub: typeof left) {
              const step = yield* sub.next()
              seen.push((step as AnyType).value.value)
              yield* (step as AnyType).value.ack()
            }
            const pulls = yield* fork(function* () {
              yield* take(left)
              yield* take(right)
              yield* take(left)
              yield* take(right)
              yield* take(left)
              yield* take(right)
            })
            yield* pulls
            expect(seen.toSorted()).toEqual([0, 1, 2, 3, 4, 5])
            // the audit consumer is a separate name: it gets all six too
            const audited: number[] = []
            for (let n = 0; n < 6; n += 1) {
              const step = yield* audit.next()
              audited.push((step as AnyType).value.value)
              yield* (step as AnyType).value.ack()
            }
            expect(audited).toEqual([0, 1, 2, 3, 4, 5])
          }),
        )
      },
    )

    it('chunking: a payload over the backend limit arrives whole (data plane and lanes)', async () => {
      unwrap(
        await run(function* () {
          yield* installIo()
          yield* target.install()
          const info = yield* useContext(Transport)
          const limit = info.capabilities.maxPayloadBytes
          if (limit === null) {
            return
          }
          const topic = unique('big')
          const sub = yield* Transport.actions.subscribe<Uint8Array>(topic)
          const value = yield* Transport.actions.subscribe<{ blob: string }>(`${topic}.value`)
          yield* sleep(50)
          const payload = bytes(limit * 2 + 12_345)
          yield* Transport.actions.publish(topic, payload, { headers: { kept: 'yes' } })
          const step = yield* sub.next()
          const message = (step as AnyType).value
          expect(message.value.length).toBe(payload.length)
          expect(yield* until(checksum(message.value))).toBe(yield* until(checksum(payload)))
          expect(message.headers.kept).toBe('yes')
          // codec values chunk too
          const blob = 'x'.repeat(limit + 100)
          yield* Transport.actions.publish(`${topic}.value`, { blob })
          expect((yield* value.next() as AnyType).value.value.blob.length).toBe(blob.length)
        }),
      )
    })

    it('lifecycle: status starts connected; drain closes publishing', async () => {
      unwrap(
        await run(function* () {
          yield* installIo()
          yield* target.install()
          const status = yield* Transport.actions.status()
          expect(((yield* status.next()) as AnyType).value).toBe('connected')
          yield* Transport.actions.drain()
          const after = yield* attempt(Transport.actions.publish(unique('closed'), 1))
          expect((after as AnyType).error).toBe(TransportErrors.Closed)
        }),
      )
    })

    it('two installs in separate scopes talk through the backend', async () => {
      unwrap(
        await run(function* () {
          const topic = unique('cross')
          const ready = createQueue<void, void>()
          const listener = yield* fork(() =>
            scoped(function* () {
              yield* installIo()
              yield* target.install()
              const sub = yield* Transport.actions.subscribe<string>(topic)
              ready.add(undefined)
              const step = yield* sub.next()
              return (step as AnyType).value.value as string
            }),
          )
          yield* ready.next()
          yield* scoped(function* () {
            yield* installIo()
            yield* target.install()
            // pub/sub keeps nothing for late subscribers: give the other scope a moment
            yield* sleep(50)
            yield* Transport.actions.publish(topic, 'hello across')
          })
          expect(yield* listener).toBe('hello across')
        }),
      )
    })
  })
}
