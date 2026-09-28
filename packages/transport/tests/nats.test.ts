import { attempt, fork, race, run, scoped, sleep, until } from 'std:effect'
import { DefaultLogger, LogLevel } from 'std:logger'
import type { Result } from 'std:result'
import { isFailure, ResultErrors, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { NoRespondersError, RequestError, TimeoutError } from '@nats-io/nats-core'
import { BunIO } from 'std:io/impl/bun'
import { Transport, TransportErrors } from 'transport:core'
import { NatsTransport, natsImpl } from 'transport:impl/nats'

import { capture, linesOf, settled } from './capture'
import { runTransportSuite } from './suite'

/** Set TRANSPORT_TEST_NATS_URL (e.g. nats://127.0.0.1:4222) to run these against a live server —
 * `moon run transport:test-nats` spins a disposable container. */
const url = process.env.TRANSPORT_TEST_NATS_URL

runTransportSuite({
  label: 'nats',
  enabled: Boolean(url),
  use: (prefix = 'suite') =>
    NatsTransport.use({ prefix, servers: url!, ackWaitMs: 1000, storage: 'memory' }),
  expect: { receipts: false, requestReply: true, groups: true, durable: true },
  ackWaitMs: 1000,
})

/**
 * A fake `nc` for `natsImpl.connect`: JetStream API requests (`$JS.API.…`) answer with an empty
 * info, `_rpc.…` requests reject with what `rpc` throws. `closed` tells whether it was closed.
 */
const fakeNats = (rpc: (subject: string) => Error) => {
  const encoder = new TextEncoder()
  const state = { closed: false }
  const reply = (body: unknown) => ({ data: encoder.encode(JSON.stringify(body)) })
  const nc = {
    options: {},
    info: undefined,
    features: { get: () => ({ ok: true, min: '0.0.0' }) },
    request: (subject: string) =>
      subject.startsWith('$JS.API.')
        ? Promise.resolve(reply({ config: { name: 'FAKE' }, state: {}, created: '' }))
        : Promise.reject(rpc(subject)),
    status: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }),
    isClosed: () => state.closed,
    drain: () => {
      state.closed = true

      return Promise.resolve()
    },
    close: () => {
      state.closed = true

      return Promise.resolve()
    },
  }

  return { nc, state }
}

/** `outcome` as the failure it must be. */
const failureOf = (outcome: unknown): Result.Failure<unknown> => {
  expect(isFailure(outcome)).toBe(true)

  return outcome as Result.Failure<unknown>
}

/** The failures `failure` nests, in order. */
const nestedOf = (failure: Result.Failure<unknown>): Result.Failure<unknown>[] =>
  failure.causes.filter(cause => typeof cause !== 'string')

describe('transport — nats: client errors (fake connection)', () => {
  it('a refused dial is transport.connection over the fold of the client error', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4222'), {
      code: 'ECONNREFUSED',
    })

    const { outcome } = unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* natsImpl.set({ connect: () => Promise.reject(refused) })

        return {
          outcome: yield* attempt(NatsTransport.use({ prefix: 'dial', servers: 'nats://x:1' })),
        }
      }),
    )
    const failure = failureOf(outcome)

    expect(failure.error).toBe(TransportErrors.Connection)
    expect(failure.message).toBe('cannot connect to nats')
    // one level under it: the fold of the client error, the Error itself its `raw`
    expect(nestedOf(failure)).toHaveLength(1)

    const [fold] = nestedOf(failure)

    expect(fold?.error).toBe(ResultErrors.Unknown)
    expect(fold?.message).toBe('Error: connect ECONNREFUSED 127.0.0.1:4222 (ECONNREFUSED)')
    expect(fold?.raw).toBe(refused)
  })

  it('a server without JetStream is transport.configuration naming why; the connection closes', async () => {
    const { nc, state } = fakeNats(() => new Error('unused'))

    nc.request = (subject: string) =>
      Promise.reject(new RequestError('no responders', { cause: new NoRespondersError(subject) }))

    const { outcome } = unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* natsImpl.set({ connect: () => Promise.resolve(nc as AnyType) })

        return {
          outcome: yield* attempt(NatsTransport.use({ prefix: 'nojs', servers: 'nats://x:1' })),
        }
      }),
    )
    const failure = failureOf(outcome)

    expect(failure.error).toBe(TransportErrors.Configuration)
    expect(failure.message).toBe('jetstream is not available on this server')

    // why, one level under it: the client error folded (no transport tag stands for it)
    const [nested] = nestedOf(failure)

    expect(nested?.error).toBe(ResultErrors.Unknown)
    expect(nested?.message).toBe('JetStreamNotEnabled: jetstream is not enabled')
    expect(nested?.raw).toBeInstanceOf(Error)
    expect(state.closed).toBe(true)
  })

  it('request errors are classified by the client Error: no-responders, timeout, else connection', async () => {
    const broken = new Error('connection lost mid-flight')
    const errors: Record<string, (subject: string) => Error> = {
      nobody: subject =>
        new RequestError('no responders', { cause: new NoRespondersError(subject) }),
      slow: () => new TimeoutError(),
      broken: () => broken,
    }
    const { nc } = fakeNats(subject => errors[subject.split('.').at(-1)!]!(subject))

    const got = unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* natsImpl.set({ connect: () => Promise.resolve(nc as AnyType) })
        yield* NatsTransport.use({ prefix: 'rpc', servers: 'nats://x:1' })

        const ask = (topic: string) =>
          attempt(Transport.actions.request(topic, {}, { timeoutMs: 1000 }))

        return {
          nobody: failureOf(yield* ask('nobody')),
          slow: failureOf(yield* ask('slow')),
          broken: failureOf(yield* ask('broken')),
        }
      }),
    )

    // a recognized client error IS the failure (`TransportErrors`' matchers), kept as its `raw`
    expect(got.nobody.error).toBe(TransportErrors.NoResponders)
    expect(got.nobody.message).toBe('no responders on "_rpc.rpc.nobody"')
    expect(got.nobody.raw).toBeInstanceOf(RequestError)
    expect(nestedOf(got.nobody)).toEqual([])
    expect(got.slow.error).toBe(TransportErrors.Timeout)
    expect(got.slow.message).toBe('request timed out')
    expect(got.slow.raw).toBeInstanceOf(TimeoutError)
    // …any other fails the request as transport.connection over its fold
    expect(got.broken.error).toBe(TransportErrors.Connection)
    expect(got.broken.message).toBe('cannot request "broken"')

    const [fold] = nestedOf(got.broken)

    expect(fold?.error).toBe(ResultErrors.Unknown)
    expect(fold?.message).toBe('Error: connection lost mid-flight')
    expect(fold?.raw).toBe(broken)
  })
})

describe.skipIf(!url)('transport — nats: stream provisioning', () => {
  it('a second install under the same prefix with different stream options updates the stream', async () => {
    const prefix = `drift.${crypto.randomUUID().slice(0, 8)}`

    unwrap(
      await run(function* () {
        yield* scoped(function* () {
          yield* BunIO.use()
          yield* NatsTransport.use({
            prefix,
            servers: url!,
            storage: 'memory',
            maxAgeMs: 60_000,
          })
        })
        // same stream name, new max age: create-or-update must not fail on the drift
        yield* scoped(function* () {
          yield* BunIO.use()
          yield* NatsTransport.use({
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
        yield* BunIO.use()
        yield* NatsTransport.use({ prefix, servers: url!, storage: 'memory' })

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
        yield* BunIO.use()
        yield* NatsTransport.use({ prefix, servers: url!, storage: 'memory' })

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
          yield* BunIO.use()
          yield* NatsTransport.use({ prefix, servers: url!, storage: 'memory' })

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
  it('a server restart is reported on status() and logged; subscriptions and durables resume after it', async () => {
    const prefix = `restart.${crypto.randomUUID().slice(0, 8)}`
    const sink = capture()

    unwrap(
      await run(function* () {
        // file storage: the stream outlives the restart (memory streams would not)
        yield* BunIO.use()
        yield* DefaultLogger.use({ level: LogLevel.trace })
        yield* sink.plugin.use()
        yield* NatsTransport.use({ prefix, servers: url!, storage: 'file', ackWaitMs: 1000 })

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
        // …and the Logger heard it: lost at WARN, back at INFO
        yield* settled(sink.entries, 2)
        expect(linesOf(sink.entries)).toEqual([
          'WARN transport connection lost',
          'INFO transport reconnected',
        ])
        expect(sink.entries[0]?.data).toMatchObject({ 'messaging.system': 'nats' })

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
