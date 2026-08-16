/**
 * Worker child entry — loaded by `new Worker(...)` in the worker transport suite. Boots a full
 * broker node inside the worker: IO + silent logger + broker + the shared math fixture + the
 * worker-only lane fixture + the worker carrier in CHILD role (attaches to the parent port),
 * then suspends until terminated.
 */
import type { Multistream } from 'server:core'
import {
  Broker,
  DataType,
  DefaultBroker,
  defineAction,
  defineService,
  parts,
  stream,
  useSignal,
  useSource,
  value,
} from 'server:core'
import type { Flow } from 'std:effect'
import { each, flow, run, sleep, suspend } from 'std:effect'
import { DefaultLogger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'

import { WorkerTransport } from 'server:transport/worker'
import { BunIO } from 'std:io/impl/bun'
import { z } from 'zod'

import { mathService } from '../transport/helpers'

/**
 * Worker-only lane fixture (registered ONLY inside the child — the host calls it by name), so the
 * shared cross-transport `mathService` stays untouched:
 *
 * - `uploadCount` — drains an input multistream plane, reporting fields and file sizes in order.
 * - `sumStream` — drains an input value-stream plane, returning the sum.
 * - `countMany` — streams `n` numbers (big enough to exercise the lane credit window).
 * - `detachProbe` — `onDisconnect: 'detach'`: sleeps 60ms, then broadcasts `probe.done` carrying
 *   whether it observed the abandon signal, and returns the same flag.
 */
const laneService = defineService({
  name: 'lanes',
  version: '1.0.0',
  actions: {
    uploadCount: defineAction(
      { input: [value(z.object({ note: z.string() })), parts()] },
      function* (params) {
        const source = (yield* useSource(DataType.multistream)) as Multistream
        const fields: Record<string, string> = {}
        const files: { name: string; size: number }[] = []

        for (const part of yield* each(source.parts)) {
          if (part.kind === 'field') {
            fields[part.name] = part.value
          } else {
            let size = 0

            for (const chunk of yield* each(part.data)) {
              size += chunk.byteLength
              yield* each.next()
            }

            files.push({ name: part.filename, size })
          }

          yield* each.next()
        }

        return { note: params.note, fields, files }
      },
    ),

    sumStream: defineAction({ input: [stream()] }, function* () {
      const source = (yield* useSource(DataType.stream)) as Flow<number, unknown>
      let total = 0

      for (const item of yield* each(source)) {
        total += item
        yield* each.next()
      }

      return total
    }),

    countMany: defineAction({ output: stream() }, function* (params) {
      const total = (params as { readonly n?: number } | undefined)?.n ?? 500

      return flow<number, unknown>(
        (async function* generate() {
          for (let index = 1; index <= total; index += 1) {
            yield index
          }
        })(),
      ) as never
    }),

    detachProbe: defineAction({ onDisconnect: 'detach' }, function* () {
      const signal = yield* useSignal()

      yield* sleep(60)

      const sawAbort = signal.aborted()

      yield* Broker.actions.broadcast('probe.done', { sawAbort })

      return { sawAbort }
    }),
  },
})

// NOT top-level awaited: a worker only starts DELIVERING inbound messages once its module
// evaluation settles — an `await run(...)` that suspends forever would queue them eternally.
void run(function* () {
  yield* install(BunIO)
  yield* install(DefaultLogger, { level: LogLevel.silent })
  yield* install(DefaultBroker)
  yield* Broker.actions.register(mathService())
  yield* Broker.actions.register(laneService)
  yield* install(WorkerTransport)
  yield* Broker.actions.start()
  yield* suspend()
})
