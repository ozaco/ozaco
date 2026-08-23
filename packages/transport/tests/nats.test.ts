import { attempt, fork, race, run, scoped, sleep, until } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'
import { Transport, TransportErrors } from 'transport:core'
import { NatsTransport } from 'transport:impl/nats'

import { runTransportSuite } from './suite'

/** Set TRANSPORT_TEST_NATS_URL (e.g. nats://127.0.0.1:4222) to run these against a live server —
 * `moon run transport:test-nats` spins a disposable container. */
const url = process.env.TRANSPORT_TEST_NATS_URL

runTransportSuite({
  label: 'nats',
  enabled: Boolean(url),
  install: (prefix = 'suite') =>
    install(NatsTransport, { prefix, servers: url!, ackWaitMs: 1000, storage: 'memory' }),
  expect: { receipts: false, requestReply: true, groups: true, durable: true },
  ackWaitMs: 1000,
})

describe.skipIf(!url)('transport — nats: stream provisioning', () => {
  it('a second install under the same prefix with different stream options updates the stream', async () => {
    const prefix = `drift.${crypto.randomUUID().slice(0, 8)}`
    unwrap(
      await run(function* () {
        yield* scoped(function* () {
          yield* install(BunIO)
          yield* install(NatsTransport, {
            prefix,
            servers: url!,
            storage: 'memory',
            maxAgeMs: 60_000,
          })
        })
        // same stream name, new max age: create-or-update must not fail on the drift
        yield* scoped(function* () {
          yield* install(BunIO)
          yield* install(NatsTransport, {
            prefix,
            servers: url!,
            storage: 'memory',
            maxAgeMs: 120_000,
          })
          const sub = yield* Transport.actions.subscribe<string>('after.update')
          yield* Transport.actions.publish('after.update', 'still works')
          expect(((yield* sub.next()) as AnyType).value.value).toBe('still works')
        })
      }),
    )
  })
})

/** `docker restart` of the test server (only when the script owns the container). */
const container = process.env.TRANSPORT_TEST_NATS_CONTAINER
const restartServer = async (): Promise<void> => {
  const proc = Bun.spawn(['docker', 'restart', container!], { stdout: 'ignore', stderr: 'ignore' })
  await proc.exited
}

const timeout = function* (ms: number) {
  yield* sleep(ms)
  return { done: true as const, value: undefined }
}

describe.skipIf(!url)('transport — nats: in-flight cancellation', () => {
  it('halting a pending request frees the caller at once; the connection stays usable', async () => {
    const prefix = `cancel.${crypto.randomUUID().slice(0, 8)}`
    unwrap(
      await run(function* () {
        yield* install(BunIO)
        yield* install(NatsTransport, { prefix, servers: url!, storage: 'memory' })
        let served = 0
        yield* Transport.actions.serve<number, string>('slow', function* (ms) {
          served += 1
          yield* sleep(ms)
          return `slept ${ms}`
        })
        const pending = yield* fork(() => Transport.actions.request<string>('slow', 5000))
        yield* sleep(100)
        const started = Date.now()
        yield* pending.halt()
        expect(Date.now() - started).toBeLessThan(500)
        expect(served).toBe(1)
        // the same connection answers the next request normally
        expect(yield* Transport.actions.request<string>('slow', 10)).toBe('slept 10')
      }),
    )
  })

  it('stopping a server mid-handler: the caller times out, later requests get no-responders', async () => {
    const prefix = `stop.${crypto.randomUUID().slice(0, 8)}`
    unwrap(
      await run(function* () {
        yield* install(BunIO)
        yield* install(NatsTransport, { prefix, servers: url!, storage: 'memory' })
        const stop = yield* Transport.actions.serve<number, string>('work', function* (ms) {
          yield* sleep(ms)
          return 'late'
        })
        const caller = yield* fork(() =>
          attempt(Transport.actions.request<string>('work', 2000, { timeoutMs: 400 })),
        )
        yield* sleep(50)
        yield* stop()
        const outcome = yield* caller
        // the handler was halted with the server: no reply ever comes
        expect(isFailure(outcome)).toBe(true)
        expect((outcome as AnyType).error).toBe(TransportErrors.Timeout)
        const nobody = yield* attempt(Transport.actions.request<string>('work', 1))
        expect((nobody as AnyType).error).toBe(TransportErrors.NoResponders)
      }),
    )
  })

  it('a scope closing over live consumers (plain, durable, lane) tears down promptly', async () => {
    const prefix = `teardown.${crypto.randomUUID().slice(0, 8)}`
    const started = Date.now()
    unwrap(
      await run(() =>
        scoped(function* () {
          yield* install(BunIO)
          yield* install(NatsTransport, { prefix, servers: url!, storage: 'memory' })
          const plain = yield* Transport.actions.subscribe<string>('t.plain')
          const durable = yield* Transport.actions.subscribe<string>('t.durable', { durable: 'd' })
          yield* fork(function* () {
            yield* plain.next()
          })
          yield* fork(function* () {
            yield* durable.next()
          })
          yield* fork(function* () {
            const lane = yield* Transport.actions.flow<number, void>('t.lane')
            yield* lane.next()
          })
          yield* sleep(200)
          // three parked consumers: the scope must still close without waiting on any of them
        }),
      ),
    )
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

describe.skipIf(!(url && container))('transport — nats: server interruption', () => {
  it('a server restart is reported on status(); subscriptions and durables resume after it', async () => {
    const prefix = `restart.${crypto.randomUUID().slice(0, 8)}`
    unwrap(
      await run(function* () {
        // file storage: the stream outlives the restart (memory streams would not)
        yield* install(BunIO)
        yield* install(NatsTransport, { prefix, servers: url!, storage: 'file', ackWaitMs: 1000 })
        const status = yield* Transport.actions.status()
        expect(((yield* status.next()) as AnyType).value).toBe('connected')
        const plain = yield* Transport.actions.subscribe<string>('r.plain')
        const durable = yield* Transport.actions.subscribe<string>('r.durable', { durable: 'd' })
        yield* sleep(100)

        yield* until(restartServer())
        const seen: string[] = []
        while (seen.at(-1) !== 'connected') {
          const step = yield* race([status.next(), timeout(15_000)])
          expect((step as AnyType).done).toBe(false)
          seen.push((step as AnyType).value)
        }
        expect(seen).toContain('reconnecting')

        // the same install, the same consumers, after the server came back
        yield* Transport.actions.publish('r.plain', 'after')
        yield* Transport.actions.publish('r.durable', 'kept')
        const gotPlain = yield* race([plain.next(), timeout(10_000)])
        expect((gotPlain as AnyType).value.value).toBe('after')
        const gotDurable = yield* race([durable.next(), timeout(10_000)])
        expect((gotDurable as AnyType).value.value).toBe('kept')
        yield* (gotDurable as AnyType).value.ack()
      }),
    )
  }, 40_000)
})
