import { run, sleep } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'
import { Transport } from 'transport:core'
import { WorkerTransport } from 'transport:impl/worker'

import { runTransportSuite } from './suite'

// the suite runs both ends in this thread over a MessageChannel: every install attaches to the
// same port (local delivery covers the cross-scope cases; the far end just echoes nothing back)
const channel = new MessageChannel()
channel.port1.start()

runTransportSuite({
  label: 'worker',
  enabled: true,
  install: (prefix = 'suite') =>
    install(WorkerTransport, { prefix, port: channel.port1 as AnyType }),
  expect: { receipts: false, requestReply: false, groups: false, durable: false },
})

describe('transport — worker: a real worker thread on the far end', () => {
  it('request/reply, pub/sub and a lane cross the thread boundary', async () => {
    const worker = new Worker(new URL('fixtures/echo-worker.ts', import.meta.url).href)
    try {
      unwrap(
        await run(function* () {
          yield* install(BunIO)
          yield* install(WorkerTransport, { prefix: 'w', port: worker as AnyType })
          // the worker needs a moment to boot and subscribe
          yield* sleep(300)
          const echoed = yield* Transport.actions.request<{ n: number; from: string }>('echo', {
            n: 21,
          })
          expect(echoed).toEqual({ n: 42, from: 'worker' })

          const pongs = yield* Transport.actions.subscribe<string>('pong')
          yield* Transport.actions.publish('ping', 'hello')
          expect(((yield* pongs.next()) as AnyType).value.value).toBe('hello!')

          const lane = yield* Transport.actions.flow<number, string>('lane')
          yield* Transport.actions.publish('ping', 'stream')
          yield* Transport.actions.publish('lane.start', 5)
          const got: number[] = []
          for (;;) {
            const step = yield* lane.next()
            if (step.done) {
              expect(step.value).toBe('streamed')
              break
            }
            got.push(step.value)
          }
          expect(got).toEqual([0, 1, 2, 3, 4])
        }),
      )
    } finally {
      worker.terminate()
    }
  })
})
