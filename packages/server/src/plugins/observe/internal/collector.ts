// oxlint-disable import/exports-last
import type { ObserveDef } from 'server:core'
import { Server } from 'server:core'
import type { Operation } from 'std:effect'
import { ensure, fork, race, sleep, withResolvers } from 'std:effect'
import { Trace } from 'std:trace'

import type { ObservePluginDef } from '../types/observe'

import { collectorAlive, forwardBatch } from './cluster'
import { writeLocal } from './store'

/** Queue one observed record — EVERY one the kernel reports (the store holds exactly what every
 * exporter receives); drop the oldest when the buffer overflows (never block the server). */
export const enqueue = (state: ObservePluginDef.State, event: ObserveDef.Event): void => {
  if (state.pending.length >= state.batch.maxPending) {
    state.pending.shift()
    state.stats.dropped += 1
  }

  state.pending.push(event)
  state.stats.recorded += 1

  if (state.pending.length >= state.batch.size) {
    state.wake?.()
  }
}

/** Write everything pending now: locally, to the cluster's collector, or both — and locally
 * as the fallback what forwarding could not deliver (no collector alive, a message the carrier
 * refused) unless `fallback: 'drop'`. */
export function* flush(state: ObservePluginDef.State): Operation<void> {
  if (state.pending.length === 0) {
    return
  }

  // writing / forwarding telemetry is never telemetry itself (flush also runs inside the
  // observe service's own handlers)
  yield* Trace.actions.suppressed(() => flushNow(state))
}

function* flushNow(state: ObservePluginDef.State): Operation<void> {
  if (state.pending.length === 0) {
    return
  }

  const batch = state.pending.splice(0)

  if (state.forward === false) {
    yield* writeLocal(state, batch)

    return
  }

  const kernel = yield* Server.context.expect()
  // what did NOT reach a collector: all of it without one, else the messages the carrier refused
  const unsent = collectorAlive(state) ? yield* forwardBatch(kernel, state, batch) : batch

  if (state.forward === 'both') {
    yield* writeLocal(state, batch)

    return
  }

  if (unsent.length > 0 && state.fallback === 'local') {
    state.cluster.fellBack += unsent.length
    yield* writeLocal(state, unsent)
  }
}

/** The forked pump: flushes every `batch.waitMs` or as soon as a batch fills; drains on close. */
export function* startFlusher(state: ObservePluginDef.State): Operation<void> {
  const gate = { closing: false, wake: withResolvers<void>('observe flush') }

  const rearm = (): void => {
    gate.wake = withResolvers<void>('observe flush')
    state.wake = () => gate.wake.resolve(undefined)
  }

  rearm()

  const tick = function* (): Operation<void> {
    yield* race([
      (function* () {
        yield* sleep(state.batch.waitMs)
      })(),
      gate.wake.operation,
    ])
    rearm()
    yield* flush(state)
  }

  const task = yield* fork(() =>
    Trace.actions.suppressed(function* () {
      for (;;) {
        yield* tick()

        if (gate.closing && state.pending.length === 0) {
          return
        }
      }
    }),
  )

  state.flusher = task

  yield* ensure(function* () {
    gate.closing = true
    state.wake?.()
    yield* race([
      task,
      (function* () {
        yield* sleep(1000)
      })(),
    ])
    yield* flush(state)
  })
}
