// oxlint-disable import/exports-last
import { Broker, defineAction, defineService, stream, useBroker, useSignal } from 'server:core'
import { runSafe } from 'server:utils'
import { flow, operation, sleep, useScope } from 'std:effect'
import { fail } from 'std:result'

export const MathErrors = { Boom: 'math.boom' } as const

const counting = () =>
  flow<number, unknown>(
    (async function* generate() {
      yield 1
      yield 2
      yield 3
    })(),
  )

/**
 * The shared cross-transport fixture service (every transport suite exercises the SAME behaviors):
 *
 * - `add` — plain value in/out.
 * - `boom` — fails `math.boom` (mapped to 422) for failure-fidelity assertions.
 * - `slowDetach` — `onDisconnect: 'detach'`, sleeps 80ms, reports whether it saw the abort.
 * - `countTo` — a 3-item output stream.
 * - `whoami` — the hosting broker's nodeId (distinguishes instances behind a carrier).
 * - `count` — a per-instance execution counter (idempotency dedupe assertions).
 *
 * `setup` echoes every `ping` bus event back as a `pong` broadcast (event round trips).
 */
export const mathService = () => {
  let executions = 0

  return defineService({
    name: 'math',
    version: '1.0.0',
    actions: {
      add: defineAction<{ readonly a: number; readonly b: number }, number>(function* (params) {
        return params.a + params.b
      }),

      boom: defineAction({ errors: { [MathErrors.Boom]: 422 } }, function* () {
        return yield* fail(MathErrors.Boom, 'math exploded on purpose')
      }),

      slowDetach: defineAction({ onDisconnect: 'detach' }, function* () {
        const signal = yield* useSignal()

        yield* sleep(80)

        return { finished: true, aborted: signal.aborted() }
      }),

      countTo: defineAction({ output: stream() }, function* () {
        return counting() as never
      }),

      whoami: defineAction(function* () {
        const broker = yield* useBroker()

        return broker.nodeId
      }),

      count: defineAction(function* () {
        executions += 1

        return executions
      }),
    },

    setup: operation(function* () {
      const scope = yield* useScope()

      yield* Broker.actions.on('ping', payload => {
        void runSafe(scope, () => Broker.actions.broadcast('pong', payload)).catch(() => {})
      })
    }),
  })
}
