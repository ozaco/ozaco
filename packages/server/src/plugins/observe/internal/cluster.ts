// oxlint-disable import/exports-last
import type { CarrierDef, ObserveDef, ServerDef, TraceDef, WireDef } from 'server:core'
import { rootTrace, toWire } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt, fork, sleep } from 'std:effect'
import { isFailure } from 'std:result'

import type { ObservePluginDef } from '../types'

import { exec, writeBatch } from './store'

/** Event names on the carrier's event plane (never user events: the `_` prefix). */
const ROWS_EVENT = '_observe.rows'
const COLLECTOR_EVENT = '_observe.collector'

/** Whether a collector announced itself recently enough to be trusted with rows. */
export const collectorAlive = (state: ObservePluginDef.State, now = Date.now()): boolean =>
  now - state.collectorSeenAt < state.collectorHeartbeatMs * 3

function* eventOf(
  kernel: ServerDef.Context,
  name: string,
  payload: unknown,
): Operation<WireDef.Event> {
  return {
    k: 'event',
    name,
    payload,
    origin: kernel.serviceId,
    trace: toWire(yield* rootTrace(kernel.serviceId, 'internal')),
  }
}

/** Forward one batch to the collector(s). Best-effort: a carrier failure is reported as a
 * fallback write by the caller. */
export function* forwardBatch(
  kernel: ServerDef.Context,
  state: ObservePluginDef.State,
  batch: readonly ObserveDef.Event[],
): Operation<boolean> {
  const carrier = kernel.carrier

  if (!carrier) {
    return false
  }

  const event = yield* eventOf(kernel, ROWS_EVENT, { instance: kernel.instance, batch })
  const sent = yield* attempt(() => carrier.actions.emit(event))

  if (isFailure(sent)) {
    return false
  }

  state.cluster.forwarded += batch.length

  return true
}

/**
 * The cluster loop of this node: listen to the carrier's events — a collector writes every
 * forwarded batch from a peer into its store and heartbeats its presence; a forwarder only
 * tracks collector heartbeats (so `flush` knows where rows should go).
 */
export function* runCluster(
  kernel: ServerDef.Context,
  state: ObservePluginDef.State,
): Operation<void> {
  const carrier = kernel.carrier

  if (!carrier) {
    return
  }

  if (state.collect) {
    // the heartbeat is a child task: it lives exactly as long as this loop does
    yield* fork(function* () {
      for (;;) {
        const beat = yield* eventOf(kernel, COLLECTOR_EVENT, { instance: kernel.instance })
        yield* attempt(() => carrier.actions.emit(beat))
        yield* sleep(state.collectorHeartbeatMs)
      }
    })
  }

  const events = yield* carrier.actions.events()

  for (;;) {
    const step = yield* events.next()

    if (step.done) {
      return
    }

    const event = step.value

    if (event.origin === kernel.serviceId) {
      continue
    }

    if (event.name === COLLECTOR_EVENT) {
      state.collectorSeenAt = Date.now()
    } else if (event.name === ROWS_EVENT && state.collect) {
      const payload = event.payload as { batch?: readonly ObserveDef.Event[] } | null
      const batch = payload?.batch ?? []
      state.cluster.received += batch.length
      yield* attempt(() => exec(state, db => writeBatch(db, batch)))
    }
  }
}

/** Per-instance stats over a window, from the work spans (edge / dispatch / carrier). */
export const instanceStats = (
  spans: readonly TraceDef.Span[],
): readonly ObserveDef.InstanceStats[] => {
  const grouped = new Map<
    string,
    { serviceId: string; durations: number[]; failed: number; last: number }
  >()

  for (const span of spans) {
    const entry = grouped.get(span.instance) ?? {
      serviceId: span.service_id,
      durations: [],
      failed: 0,
      last: 0,
    }
    entry.durations.push(span.ended_at - span.started_at)

    if (span.status === 'failed') {
      entry.failed += 1
    }

    entry.last = Math.max(entry.last, span.ended_at)
    grouped.set(span.instance, entry)
  }

  return [...grouped.entries()]
    .map(([instance, entry]) => {
      const sorted = entry.durations.toSorted((left, right) => left - right)
      const at = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
      return {
        instance,
        service_id: entry.serviceId,
        spans: sorted.length,
        failed: entry.failed,
        p95_ms: sorted.length > 0 ? sorted[at]! : null,
        last_seen: entry.last,
      }
    })
    .toSorted((left, right) => left.instance.localeCompare(right.instance))
}

/** Presence members of every declared service. */
export function* membersView(
  kernel: ServerDef.Context,
): Operation<Record<string, readonly CarrierDef.Member[]>> {
  const out: Record<string, readonly CarrierDef.Member[]> = {}

  for (const name of kernel.registry.services.keys()) {
    const members = yield* attempt(() => kernel.carrier!.actions.members(name))
    out[name] = isFailure(members) ? [] : members.value
  }

  return out
}
