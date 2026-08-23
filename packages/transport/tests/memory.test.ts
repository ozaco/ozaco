import { attempt, fork, race, run, sleep } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'
import { Transport, TransportErrors } from 'transport:core'
import { createLink, MemoryTransport, setStatus } from 'transport:impl/memory'

import { runTransportSuite } from './suite'

// one link per file: every install (any scope) joins the same in-process "broker"
const link = createLink()

runTransportSuite({
  label: 'memory',
  enabled: true,
  // a small payload limit so the suite exercises chunking (data plane and lane frames)
  install: (prefix = 'suite') =>
    install(MemoryTransport, { prefix, link, maxPayloadBytes: 64 * 1024 }),
  expect: { receipts: true, requestReply: false, groups: true, durable: true },
})

describe('transport — memory: outage simulation', () => {
  it('publishes during a reconnect are buffered and land once connected; status reports it', async () => {
    const outage = createLink()
    unwrap(
      await run(function* () {
        yield* install(BunIO)
        yield* install(MemoryTransport, { prefix: 'app', link: outage })
        const status = yield* Transport.actions.status()
        expect((yield* status.next() as AnyType).value).toBe('connected')
        const sub = yield* Transport.actions.subscribe<string>('ping')

        setStatus(outage, 'reconnecting')
        expect((yield* status.next() as AnyType).value).toBe('reconnecting')
        yield* Transport.actions.publish('ping', 'while away')
        // nothing moves while the link is down…
        const early = yield* race([
          sub.next(),
          (function* () {
            yield* sleep(30)
            return { done: true as const, value: undefined }
          })(),
        ])
        expect((early as AnyType).done).toBe(true)

        // …and everything buffered lands on recovery
        setStatus(outage, 'connected')
        expect((yield* status.next() as AnyType).value).toBe('connected')
        expect((yield* sub.next() as AnyType).value.value).toBe('while away')
      }),
    )
  })
})

describe('transport — memory: chaos link', () => {
  it('a chaos link drops, duplicates and delays deliveries deterministically per seed', async () => {
    const tally = (seed: number) =>
      run(function* () {
        const unreliable = createLink({
          chaos: { seed, dropRate: 0.3, duplicateRate: 0.3 },
        })
        yield* install(BunIO)
        yield* install(MemoryTransport, { prefix: 'app', link: unreliable })
        const sub = yield* Transport.actions.subscribe<number>('n')
        for (let n = 0; n < 40; n += 1) {
          yield* Transport.actions.publish('n', n)
        }
        yield* sleep(120)
        const got: number[] = []
        for (;;) {
          const step = yield* race([
            sub.next(),
            (function* () {
              yield* sleep(10)
              return { done: true as const, value: undefined }
            })(),
          ])
          if ((step as AnyType).done) {
            break
          }
          got.push((step as AnyType).value.value)
        }
        return { got, counters: { ...unreliable.chaos!.counters } }
      })
    const first = unwrap(await tally(7))
    const again = unwrap(await tally(7))
    expect(first.counters.dropped).toBeGreaterThan(0)
    expect(first.counters.duplicated).toBeGreaterThan(0)
    expect(first.got.length).toBe(first.counters.delivered)
    // same seed → same fate for every delivery
    expect(again.counters).toEqual(first.counters)
    expect(new Set(again.got)).toEqual(new Set(first.got))
  })
})

describe('transport — memory: chaos link and lanes', () => {
  it('a dropped lane frame ends the consumer with transport.encoding (sequence gap)', async () => {
    unwrap(
      await run(function* () {
        const unreliable = createLink({
          chaos: { seed: 3, dropRate: 0.5, duplicateRate: 0, maxDelayMs: 1 },
        })
        yield* install(BunIO)
        yield* install(MemoryTransport, { prefix: 'app', link: unreliable })
        const values: number[] = Array.from({ length: 40 }, (_, index) => index)
        const source = {
          *[Symbol.iterator]() {
            let at = 0
            return {
              *next() {
                return at < values.length
                  ? { done: false as const, value: values[at++]! }
                  : { done: true as const, value: 'end' }
              },
            }
          },
        }
        const consumer = yield* fork(function* () {
          const sub = yield* Transport.actions.flow<number, string>('lane', { timeoutMs: 500 })
          const got: number[] = []
          for (;;) {
            const step = yield* sub.next()
            if (step.done) {
              return { got, close: step.value }
            }
            got.push(step.value)
          }
        })
        yield* attempt(Transport.actions.pipe('lane', source, { timeoutMs: 500 }))
        const result = yield* consumer
        // frames went missing: the lane refuses to pretend — it closes with the gap as a failure
        expect(isFailure(result.close)).toBe(true)
        expect((result.close as AnyType).error).toBe(TransportErrors.Encoding)
        expect(result.got.length).toBeLessThan(values.length)
      }),
    )
  })
})
