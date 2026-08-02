import { describe, expect, it } from 'bun:test'

import {
  Broker,
  DataType,
  DefaultBroker,
  chunks,
  defineAction,
  defineService,
} from '@ozaco/server/core'
import type { Response, Source } from '@ozaco/server/core'
import type { Operation, Stream, Subscription } from '@ozaco/std/effect'
import { createQueue, createStreamQueue, operation, run } from '@ozaco/std/effect'
import { BunIO } from '@ozaco/std/io/impl/bun'
import { DefaultLogger, LogLevel } from '@ozaco/std/logger'
import { install } from '@ozaco/std/plugin'
import { isSuccess } from '@ozaco/std/result'

// S6: the reply lane of an `output: chunks()` action must survive an IN-PROCESS exchange. It used
// to arrive as `{ type: 'stream', stream: undefined }` whenever the handler answered with an
// operation-built Stream (a thenable), because `attempt`'s `succeed` mistook the value for a
// promise. `exchange` is the lane's only carrier — `call` answers with the normal value alone.
const drainLane = (response: Response) =>
  run(function* () {
    const source = response.sources.find(entry => entry.type === DataType.stream) as
      | Source.Lane
      | undefined

    if (!source || source.stream === undefined) {
      return null
    }

    const sub = (yield* source.stream as Stream<Uint8Array, unknown>) as Subscription<
      Uint8Array,
      unknown
    >
    let bytes = 0
    for (;;) {
      const step = yield* sub.next()
      if (step.done) {
        return bytes
      }
      bytes += step.value.byteLength
    }
  })

const withBroker = function* <T>(service: unknown, body: () => Operation<T>): Operation<T> {
  yield* install(BunIO)
  yield* install(DefaultLogger, { level: LogLevel.silent })
  yield* install(DefaultBroker)
  yield* (service as { actions: { install(): Operation<unknown> } }).actions.install()
  yield* Broker.actions.register(service as never)
  yield* Broker.actions.start()
  return yield* body()
}

describe('in-process exchange reply lane', () => {
  it('delivers an operation-built Stream value intact (the S6 shape)', async () => {
    const queue = createQueue<Uint8Array, undefined>()
    queue.add(new Uint8Array([1, 2, 3]))
    queue.add(new Uint8Array([4, 5]))
    queue.close(undefined)

    const lane = operation(function* () {
      return queue
    })

    const service = defineService({
      name: 'lane-op',
      version: '0.0.0',
      actions: {
        attach: defineAction({ output: chunks() }, function* () {
          return lane() as never
        }),
      },
      *setup() {},
    })

    const response = await run(() =>
      withBroker(service, () => Broker.actions.exchange(service, 'attach' as never, [])),
    )

    expect(isSuccess(response)).toBe(true)
    if (isSuccess(response)) {
      const drained = await drainLane(response.value as Response)
      expect(isSuccess(drained)).toBe(true)
      if (isSuccess(drained)) {
        expect(drained.value).toBe(5)
      }
    }
  })

  it('delivers a StreamQueue value intact', async () => {
    const service = defineService({
      name: 'lane-queue',
      version: '0.0.0',
      actions: {
        attach: defineAction({ output: chunks() }, function* () {
          const out = createStreamQueue<Uint8Array, void>()
          out.add(new Uint8Array([7, 8, 9]))
          out.close()
          return out as never
        }),
      },
      *setup() {},
    })

    const response = await run(() =>
      withBroker(service, () => Broker.actions.exchange(service, 'attach' as never, [])),
    )

    expect(isSuccess(response)).toBe(true)
    if (isSuccess(response)) {
      const drained = await drainLane(response.value as Response)
      expect(isSuccess(drained)).toBe(true)
      if (isSuccess(drained)) {
        expect(drained.value).toBe(3)
      }
    }
  })
})
