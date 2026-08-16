import {
  Broker,
  CoreErrors,
  DataType,
  Transport,
  createMultistreamAssembler,
  flowOf,
  rootTrace,
} from 'server:core'
import type { Reply, Wire } from 'server:core'
import { collectFlow } from 'server:utils'
import {
  attempt,
  box,
  createQueue,
  each,
  operation,
  sleep,
  spawn,
  until,
  withResolvers,
} from 'std:effect'
import type { Flow } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure, isJust } from 'std:result'
import type { Result } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { LANE_CREDIT_STEP, LANE_WINDOW, WorkerTransport } from 'server:transport/worker'

import { laneDiagnostics } from '../../src/transport/worker/internal/shared'
import { bootstrap, cidOf } from '../core/helpers'
import { runScoped } from '../helpers'

const childScript = new URL('../fixtures/worker-child.ts', import.meta.url)

/** Core test bed + the worker carrier in HOST role over the child fixture. */
const bootWorkers = operation(function* (count: number) {
  yield* bootstrap()
  yield* install(WorkerTransport, { script: childScript, count })
})

const valueOf = (reply: Reply): unknown => (reply.kind === 'value' ? reply.value : undefined)

describe('worker transport', () => {
  it('dispatches to spawned workers and round-robins across the pool', async () => {
    const result = await runScoped(function* () {
      yield* bootWorkers(2)

      const sum = yield* Broker.actions.call('math', 'add', { a: 2, b: 3 })
      const ids: unknown[] = []

      for (let call = 0; call < 4; call += 1) {
        ids.push(yield* Broker.actions.call('math', 'whoami'))
      }

      return { sum, ids }
    })

    expect(result.sum).toBe(5)
    expect(new Set(result.ids).size).toBe(2)
  })

  it('carries failures with full fidelity: tag, message, breadcrumbs, exchange status', async () => {
    const result = await runScoped(function* () {
      yield* bootWorkers(1)

      const failure = yield* attempt(() => Broker.actions.call('math', 'boom', {}))

      if (!isFailure(failure)) {
        throw new Error('expected math.boom to fail')
      }

      const reply: Reply = yield* Broker.actions.exchange('math', 'boom', {})

      return { failure, reply }
    })

    expect(String(result.failure.error)).toBe('math.boom')
    expect(result.failure.message).toBe('math exploded on purpose')
    expect(
      result.failure.causes.some(
        cause => cause.includes('action:boom') && cause.includes('svc:math@'),
      ),
    ).toBe(true)
    expect(result.reply.kind).toBe('failure')
    expect(result.reply.kind === 'failure' ? result.reply.status : 0).toBe(422)
  })

  it('streams replies over lane envelopes in order', async () => {
    const values = await runScoped(function* () {
      yield* bootWorkers(1)

      const result = yield* Broker.actions.call('math', 'countTo')

      return yield* collectFlow(result as Flow<number, unknown>)
    })

    expect(values).toEqual([1, 2, 3])
  })

  it('splits the timeout taxonomy: acked but slow → TimeoutPending, outcome cancelled', async () => {
    const result = await runScoped(function* () {
      yield* bootWorkers(1)

      const failure = yield* attempt(() =>
        Broker.actions.call('math', 'slowDetach', undefined, {
          ackTimeoutMs: 10_000,
          timeoutMs: 20,
        }),
      )

      if (!isFailure(failure)) {
        throw new Error('expected TimeoutPending')
      }

      const stored = yield* Broker.actions.outcome(cidOf(failure))

      return { failure, stored }
    })

    expect(result.failure.error).toBe(CoreErrors.TimeoutPending)
    expect(result.failure.message).toContain('outcome unknown')
    expect(isJust(result.stored)).toBe(true)
    if (isJust(result.stored)) {
      expect(result.stored.value.state).toBe('cancelled')
    }
  })

  it('raises Unavailable for pending dispatches when the worker dies mid-flight', async () => {
    const result = await runScoped(function* () {
      yield* bootWorkers(1)

      const task = yield* spawn(() => box(() => Broker.actions.call('math', 'slowDetach')))

      yield* sleep(20)
      yield* WorkerTransport.actions.terminate(0)

      // settleTask fold: the boxed task's promise resolves the boxed Result (halt rejects).
      const outer = yield* attempt(() =>
        until(Promise.resolve(task) as unknown as Promise<Result<unknown>>),
      )
      const settled = isFailure(outer) ? outer : outer.value

      return { settled }
    })

    expect(isFailure(result.settled)).toBe(true)
    if (isFailure(result.settled)) {
      expect(result.settled.error).toBe(CoreErrors.Unavailable)
    }
  })

  it('round-trips events: host broadcast reaches the child, its echo reaches the host', async () => {
    const payload = await runScoped(function* () {
      yield* bootWorkers(1)

      const resolvers = withResolvers<unknown>()

      yield* Broker.actions.on('pong', value => resolvers.resolve(value))
      yield* Broker.actions.broadcast('ping', { n: 7 })

      return yield* resolvers.operation
    })

    expect(payload).toEqual({ n: 7 })
  })

  it('dedupes idempotencyKey on the child across the wire (cached reply, rewritten cid)', async () => {
    const result = await runScoped(function* () {
      yield* bootWorkers(1)

      const entries = yield* Transport.actions.getTransports()
      const worker = entries.find(entry => entry.name === 'worker')

      if (!worker) {
        throw new Error('the worker carrier is not registered')
      }

      const trace = yield* rootTrace({ origin: 'internal', serviceId: 'suite#worker' })
      const send = (cid: string, key: string) =>
        worker.actions.dispatch({
          request: {
            cid,
            service: 'math',
            action: 'count',
            params: undefined,
            meta: {},
            trace,
            idempotencyKey: key,
          },
          acked: () => {},
        })

      const first = yield* send('c_dup_1', 'op-1')
      const second = yield* send('c_dup_2', 'op-1')
      const third = yield* send('c_dup_3', 'op-2')

      return { first, second, third }
    })

    expect(result.first.kind).toBe('value')
    expect(valueOf(result.first)).toBe(1)
    expect(valueOf(result.second)).toBe(1)
    expect(result.second.cid).toBe('c_dup_2')
    expect(valueOf(result.third)).toBe(2)
  })

  it('moves an input multistream over the port in order', async () => {
    const result = await runScoped(function* () {
      yield* bootWorkers(1)

      const assembler = createMultistreamAssembler()
      const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill)
      const frames: readonly Wire.PartFrame[] = [
        { p: 'field', name: 'tag', value: 'demo' },
        { p: 'file', name: 'file', filename: 'a.bin', contentType: 'application/octet-stream' },
        { p: 'chunk', data: bytes(100, 1) },
        { p: 'chunk', data: bytes(50, 2) },
        { p: 'file-end' },
        { p: 'file', name: 'file', filename: 'b.txt', contentType: 'text/plain' },
        { p: 'chunk', data: bytes(7, 3) },
        { p: 'file-end' },
      ]

      for (const frame of frames) {
        assembler.push(frame)
      }

      assembler.end()

      return yield* Broker.actions.call(
        'lanes',
        'uploadCount',
        { note: 'hello' },
        { sources: new Map([[DataType.multistream, assembler.multistream]]) },
      )
    })

    expect(result).toEqual({
      note: 'hello',
      fields: { tag: 'demo' },
      files: [
        { name: 'a.bin', size: 150 },
        { name: 'b.txt', size: 7 },
      ],
    })
  })

  it('moves an input stream plane consumed via useSource', async () => {
    const total = await runScoped(function* () {
      yield* bootWorkers(1)

      const queue = createQueue<unknown, unknown>()

      for (let index = 1; index <= 10; index += 1) {
        queue.add(index)
      }

      queue.close(true)

      return yield* Broker.actions.call('lanes', 'sumStream', undefined, {
        sources: new Map([[DataType.stream, flowOf(queue)]]),
      })
    })

    expect(total).toBe(55)
  })

  it('meters lane traffic with the credit window (500 items, slow consumer)', async () => {
    laneDiagnostics.reset()

    const values = await runScoped(function* () {
      yield* bootWorkers(1)

      const result = yield* Broker.actions.call('lanes', 'countMany', { n: 500 })
      const collected: number[] = []

      for (const item of yield* each(result as Flow<number, unknown>)) {
        collected.push(item)
        yield* sleep(1)
        yield* each.next()
      }

      return collected
    })

    expect(values).toHaveLength(500)
    expect(values.every((item, index) => item === index + 1)).toBe(true)
    // WHITE-BOX (laneDiagnostics): the consumer-side backlog (received − consumed) bounds the
    // producer's in-flight window — credits must keep it within LANE_WINDOW + one credit step.
    expect(laneDiagnostics.maxBuffered).toBeGreaterThan(0)
    expect(laneDiagnostics.maxBuffered).toBeLessThanOrEqual(LANE_WINDOW + LANE_CREDIT_STEP)
  })

  it('fires the abandon signal on remote detach handlers without halting them', async () => {
    const result = await runScoped(function* () {
      yield* bootWorkers(1)

      const probe = withResolvers<unknown>()

      yield* Broker.actions.on('probe.done', payload => probe.resolve(payload))

      const failure = yield* attempt(() =>
        Broker.actions.call('lanes', 'detachProbe', undefined, {
          ackTimeoutMs: 10_000,
          timeoutMs: 20,
        }),
      )

      if (!isFailure(failure)) {
        throw new Error('expected TimeoutPending')
      }

      const payload = yield* probe.operation

      // Give the trailing reply/outcome envelopes a beat to land in the host stores.
      yield* sleep(30)

      const stored = yield* Broker.actions.outcome(cidOf(failure))

      return { failure, payload, stored }
    })

    expect(result.failure.error).toBe(CoreErrors.TimeoutPending)
    expect(result.payload).toEqual({ sawAbort: true })
    expect(isJust(result.stored)).toBe(true)
    if (isJust(result.stored)) {
      expect(result.stored.value.state).toBe('fulfilled')
    }
  })
})
