/**
 * The worker side of the worker-transport test: installs the transport on `self`, serves
 * `echo`, answers `ping` with `pong`, and streams a lane on request.
 */
import { run, sleep } from 'std:effect'
import { install } from 'std:plugin'

import { BunIO } from 'std:io/impl/bun'
import { Transport } from 'transport:core'
import type { Worker } from 'transport:impl/worker'
import { WorkerTransport } from 'transport:impl/worker'

declare const self: Worker.PortLike

void run(function* () {
  yield* install(BunIO)
  yield* install(WorkerTransport, { prefix: 'w', port: self })
  yield* Transport.actions.serve<{ n: number }, { n: number; from: string }>(
    'echo',
    function* (args) {
      return { n: args.n * 2, from: 'worker' }
    },
  )
  const pings = yield* Transport.actions.subscribe<string>('ping')
  const pumps = yield* Transport.actions.subscribe<number>('lane.start')
  for (;;) {
    // answer pings and stream lanes until the main thread ends the worker
    const next = yield* pings.next()
    if (next.done) {
      return
    }
    yield* Transport.actions.publish('pong', `${next.value.value}!`)
    if (next.value.value === 'stream') {
      const count = ((yield* pumps.next()) as { value: { value: number } }).value.value
      const source = {
        *[Symbol.iterator]() {
          let at = 0
          return {
            *next() {
              if (at >= count) {
                return { done: true as const, value: 'streamed' }
              }
              yield* sleep(1)
              return { done: false as const, value: at++ }
            },
          }
        },
      }
      yield* Transport.actions.pipe('lane', source)
    }
  }
})
