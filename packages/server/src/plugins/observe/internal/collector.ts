import type { ObserveDef } from 'server:core'
import { Server } from 'server:core'
import type { Operation } from 'std:effect'
import { ensure, fork, race, sleep, withResolvers } from 'std:effect'

import type { ObservePluginDef } from '../types'

import { collectorAlive, forwardBatch } from './cluster'
import { exec, writeBatch } from './store'

/** The store table each event kind lands in — `domain` rows are exporter-only and pass
 * through untouched (the store skips them at write time anyway). */
const STORE_KIND: Record<ObserveDef.Event['t'], keyof ObservePluginDef.ResolvedStore | null> = {
  request: 'requests',
  'request-update': 'requests',
  span: 'spans',
  log: 'logs',
  failure: 'failures',
  event: 'events',
  domain: null,
}

/** Queue one event the store keeps; drop the oldest when the buffer overflows (never block
 * the server). A kind turned off in `store` is skipped before it ever queues. */
export const enqueue = (state: ObservePluginDef.State, event: ObserveDef.Event): void => {
  const kind = STORE_KIND[event.t]

  if (kind !== null && !state.store[kind]) {
    return
  }

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
 * as the fallback when forwarding finds no collector (unless `fallback: 'drop'`). */
export function* flush(state: ObservePluginDef.State): Operation<void> {
  if (state.pending.length === 0) {
    return
  }

  const batch = state.pending.splice(0)

  if (state.forward === false) {
    yield* exec(state, db => writeBatch(db, batch))
    return
  }

  const kernel = yield* Server.context.expect()
  const forwarded = collectorAlive(state) && (yield* forwardBatch(kernel, state, batch))

  if (state.forward === 'both') {
    yield* exec(state, db => writeBatch(db, batch))
    return
  }

  if (!forwarded && state.fallback === 'local') {
    state.cluster.fellBack += batch.length
    yield* exec(state, db => writeBatch(db, batch))
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

  const task = yield* fork(function* () {
    for (;;) {
      yield* tick()
      if (gate.closing && state.pending.length === 0) {
        return
      }
    }
  })
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
