import { attempt, ensure, fork, race, sleep, useContext, withResolvers } from 'std:effect'
import { createEvent } from 'std:event'
import { fail, isFailure } from 'std:result'

import { DEFAULT_DRAIN_TIMEOUT_MS, DEFAULT_MAX_PENDING } from '../const'
import { DbBus } from '../definition/bus'
import { DbErrors } from '../errors'
import type { Bus } from '../types/bus'
import type { Change } from '../types/change'
import type { Database } from '../types/database'
import type { Helpers } from '../types/helpers'
import { isSystemField } from '../utils/is'

import { StateRef } from './context'
import { attachTransport } from './hub'

export function* specOf(table: string) {
  const state = yield* useContext(StateRef)
  const spec = state.specs.get(table)

  if (!spec) {
    return yield* fail(DbErrors.Validation, `unknown table "${table}"`)
  }

  return spec
}

export function* logOf(table: string) {
  const state = yield* useContext(StateRef)
  const log = state.logs.get(table)

  if (!log) {
    return yield* fail(
      DbErrors.Validation,
      state.specs.has(table) ? `table "${table}" keeps no change log` : `unknown table "${table}"`,
    )
  }

  return log
}

/** Forward the installed `DbBus` (if any, and not bridged yet) onto the local bus. */
export function* bridgeTransports(state: Database.State) {
  const endpoint = yield* DbBus.context.get()

  if (!endpoint || state.bridged.has(endpoint)) {
    return 0
  }

  state.bridged.add(endpoint)
  yield* attachTransport(state.bus, endpoint)

  return 1
}

/** Validate announced writes against the declared schema and feed them to the hub as ONE batch
 * (one flush = one bus envelope; inside a transaction they join its buffer). */
export function* publishWrites(writes: readonly Change.Write[]) {
  const state = yield* useContext(StateRef)

  for (const write of writes) {
    const spec = yield* specOf(write.table)

    if (write.fields !== undefined) {
      if (write.op !== 'update') {
        return yield* fail(DbErrors.Validation, `"fields" is only valid on update events`)
      }

      const known = new Set(spec.columns.map(column => column.name))
      const unknown = write.fields.find(field => !known.has(field) && !isSystemField(field))

      if (unknown !== undefined) {
        return yield* fail(DbErrors.Validation, `unknown column "${unknown}" in "${write.table}"`)
      }
    }
  }

  // log-first (outside a transaction), then fan out — one batch, one bus envelope
  const recorded: Helpers.Tokened[] = []

  for (const write of writes) {
    recorded.push(yield* state.hub.record(write))
  }

  for (const write of recorded) {
    yield* state.hub.announce(write)
  }
}

/**
 * The node's local bus with its OUTBOX: `publish` only queues an envelope and returns — a forked
 * pump ships the queue through the `DbBus` plugin (a no-op without one), so a slow or failing
 * transport can never slow down or fail a write. An overflowing outbox drops its oldest envelopes
 * (peers notice the sequence gap and replay the change log). On scope close the pump gets
 * `drainTimeoutMs` to finish.
 */
export function* createBus(origin: string, options: Bus.OutboxOptions | undefined) {
  const maxPending = Math.max(1, options?.maxPending ?? DEFAULT_MAX_PENDING)
  const drainTimeoutMs = options?.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
  const pending: Bus.Envelope[] = []
  const counters = { published: 0, failed: 0, coalesced: 0 }
  let wake = withResolvers<void>('outbox wake')
  let closing = false

  const pump = function* () {
    for (;;) {
      const envelope = pending.shift()

      if (!envelope) {
        if (closing) {
          return
        }

        yield* wake.operation
        wake = withResolvers<void>('outbox wake')
        continue
      }

      // no bus installed (single node): the envelope has nowhere to go
      if (!(yield* DbBus.context.get())) {
        continue
      }

      const outcome = yield* attempt(() => DbBus.actions.publish(envelope))

      if (isFailure(outcome)) {
        counters.failed += 1
      } else {
        counters.published += 1
      }
    }
  }
  const task = yield* fork(pump)

  yield* ensure(function* () {
    closing = true
    wake.resolve(undefined)
    // give the pump a bounded chance to ship what is still queued
    yield* race([
      task,
      (function* () {
        yield* sleep(drainTimeoutMs)
      })(),
    ])
    counters.failed += pending.length
    pending.length = 0
  })

  const bus: Change.Bus = {
    origin,
    events: createEvent<Bus.Events>(),
    *publish(envelope) {
      if (pending.length >= maxPending) {
        pending.shift()
        counters.coalesced += 1
      }

      pending.push(envelope)
      wake.resolve(undefined)
    },
  }

  return { bus, counters }
}
