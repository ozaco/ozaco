// oxlint-disable import/exports-last
import type { CarrierDef, ObserveDef, ServerDef, WireDef } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt, fork, sleep } from 'std:effect'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import { utf8Length } from 'std:shared'
import { Trace } from 'std:trace'

import type { Helpers } from '../types/helpers'
import type { ObservePluginDef } from '../types/observe'

import { MAX_FORWARD_BYTES } from './context'
import { writeLocal } from './store'

/**
 * Event names on the carrier's event plane. `_`-prefixed: plumbing, never user events — the
 * kernel never traces them, the carrier publishes them TRANSIENT, `Server.actions.events()`
 * hides them.
 */
const BATCH_EVENT = '_observe.batch'
const COLLECTOR_EVENT = '_observe.collector'

/** Whether a collector announced itself recently enough to be trusted with records. */
export const collectorAlive = (state: ObservePluginDef.State, now = Date.now()): boolean =>
  now - state.collectorSeenAt < state.collectorHeartbeatMs * 3

/** A cluster envelope: no `trace` — plumbing is never part of anyone's trace. */
const eventOf = (kernel: ServerDef.Context, name: string, payload: unknown): WireDef.Event => ({
  k: 'event',
  name,
  payload,
  origin: kernel.serviceId,
})

/**
 * A batch as it crosses the wire, cut into MESSAGES of at most `maxBytes` serialized (JSON) each —
 * NATS refuses a payload over its `max_payload` (1 MB by default), so a busy node's batch must
 * never be one message. Each message stands on its own: every record once, each resource once
 * per message (records point at theirs by index). A single record bigger than `maxBytes` travels
 * alone. Every message keeps the events it carries (a refused one falls back locally).
 */
export const packBatch = (
  instance: string,
  batch: readonly ObserveDef.Event[],
  maxBytes: number = MAX_FORWARD_BYTES,
): readonly Helpers.ForwardedChunk[] => {
  // `{"v":2,"instance":"…","resources":[],"records":[]}`: what every message costs empty
  const empty = utf8Length(JSON.stringify({ v: 2, instance, resources: [], records: [] }))
  const sizes = new Map<ObserveDef.Resource, number>()
  const chunks: Helpers.PackingChunk[] = []

  const open = (): Helpers.PackingChunk => {
    const chunk: Helpers.PackingChunk = {
      resources: [],
      index: new Map(),
      records: [],
      events: [],
      bytes: empty,
    }

    chunks.push(chunk)

    return chunk
  }

  /** What adding `event` (its data `dataBytes` long) costs `chunk`, and the index it would use. */
  const costOf = (chunk: Helpers.PackingChunk, event: ObserveDef.Event, dataBytes: number) => {
    const known = chunk.index.get(event.resource)
    const at = known ?? chunk.resources.length
    let resourceBytes = 0

    if (known === undefined) {
      const size = sizes.get(event.resource) ?? utf8Length(JSON.stringify(event.resource) ?? 'null')

      sizes.set(event.resource, size)
      resourceBytes = size + (chunk.resources.length > 0 ? 1 : 0)
    }

    // `[at,"t",<data>]` and the comma before it
    const recordBytes =
      utf8Length(JSON.stringify([at, event.t])) + dataBytes + 1 + (chunk.records.length > 0 ? 1 : 0)

    return { at, known, bytes: resourceBytes + recordBytes }
  }

  let chunk = open()

  for (const event of batch) {
    const data = event.t === 'span' ? event.span : event.log
    const dataBytes = utf8Length(JSON.stringify(data) ?? 'null')
    let cost = costOf(chunk, event, dataBytes)

    // full: this record opens the next message (a lone oversized record still travels)
    if (chunk.records.length > 0 && chunk.bytes + cost.bytes > maxBytes) {
      chunk = open()
      cost = costOf(chunk, event, dataBytes)
    }

    if (cost.known === undefined) {
      chunk.index.set(event.resource, cost.at)
      chunk.resources.push(event.resource)
    }

    chunk.records.push([cost.at, event.t, data])
    chunk.events.push(event)
    chunk.bytes += cost.bytes
  }

  return chunks
    .filter(entry => entry.records.length > 0)
    .map(entry => ({
      payload: { v: 2, instance, resources: entry.resources, records: entry.records },
      events: entry.events,
      bytes: entry.bytes,
    }))
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** The events a forwarded batch carries — anything malformed (another version's payload) is
 * skipped, never raised. */
export const unpackBatch = (payload: unknown): readonly ObserveDef.Event[] => {
  if (!isRecord(payload) || payload['v'] !== 2) {
    return []
  }

  const resources: unknown[] = Array.isArray(payload['resources']) ? payload['resources'] : []
  const records = Array.isArray(payload['records']) ? payload['records'] : []
  const out: ObserveDef.Event[] = []

  for (const record of records) {
    if (!Array.isArray(record)) {
      continue
    }

    const [at, t, data] = record as unknown[]
    const resource = typeof at === 'number' ? resources[at] : undefined

    if (!isRecord(resource) || !isRecord(data)) {
      continue
    }

    if (t === 'span') {
      out.push({ t, span: data as AnyType, resource: resource as ObserveDef.Resource })
    } else if (t === 'log') {
      out.push({ t, log: data as AnyType, resource: resource as ObserveDef.Resource })
    }
  }

  return out
}

/** Forward one batch to the collector(s), as messages of at most {@link MAX_FORWARD_BYTES} each
 * ({@link packBatch}). Best-effort, message by message: resolves the events of every message the
 * carrier refused (the caller falls back with those — none twice). */
export function* forwardBatch(
  kernel: ServerDef.Context,
  state: ObservePluginDef.State,
  batch: readonly ObserveDef.Event[],
): Operation<readonly ObserveDef.Event[]> {
  const carrier = kernel.carrier

  if (!carrier) {
    return batch
  }

  const unsent: ObserveDef.Event[] = []

  for (const chunk of packBatch(kernel.instance, batch)) {
    const event = eventOf(kernel, BATCH_EVENT, chunk.payload)
    const sent = yield* attempt(() => Trace.actions.suppressed(() => carrier.actions.emit(event)))

    if (isFailure(sent)) {
      unsent.push(...chunk.events)

      continue
    }

    state.cluster.forwarded += chunk.events.length
  }

  return unsent
}

/**
 * The cluster loop of this node: listen to the carrier's events — a collector writes every
 * forwarded batch from a peer into its store and heartbeats its presence; a forwarder only
 * tracks collector heartbeats (so `flush` knows where records should go). All of it SUPPRESSED:
 * plumbing, never telemetry.
 */
export function* runCluster(
  kernel: ServerDef.Context,
  state: ObservePluginDef.State,
): Operation<void> {
  yield* Trace.actions.suppressed(() => clusterLoop(kernel, state))
}

function* clusterLoop(kernel: ServerDef.Context, state: ObservePluginDef.State): Operation<void> {
  const carrier = kernel.carrier

  if (!carrier) {
    return
  }

  if (state.collect) {
    // the heartbeat is a child task: it lives exactly as long as this loop does
    yield* fork(function* () {
      for (;;) {
        const beat = eventOf(kernel, COLLECTOR_EVENT, { instance: kernel.instance })

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
    } else if (event.name === BATCH_EVENT && state.collect) {
      const batch = unpackBatch(event.payload)

      state.cluster.received += batch.length
      yield* writeLocal(state, batch)
    }
  }
}

/**
 * Per-instance stats over a window, grouped by `service.instance.id`: how many measured spans
 * (server / client spans and local roots), how many failed (status error), their p95, when the
 * instance was last seen and which `service.name`s it reported.
 */
export const instanceStats = (
  spans: readonly ObserveDef.SpanRow[],
): readonly ObserveDef.InstanceStats[] => {
  const grouped = new Map<
    string,
    { services: Set<string>; durations: number[]; failed: number; last: number }
  >()

  for (const span of spans) {
    const entry = grouped.get(span.service_instance_id) ?? {
      services: new Set<string>(),
      durations: [],
      failed: 0,
      last: 0,
    }

    entry.services.add(span.service_name)
    entry.durations.push(span.duration_ms)

    if (span.status_code === 'error') {
      entry.failed += 1
    }

    entry.last = Math.max(entry.last, span.end)
    grouped.set(span.service_instance_id, entry)
  }

  return [...grouped.entries()]
    .map(([instance, entry]) => {
      const sorted = entry.durations.toSorted((left, right) => left - right)
      const at = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))

      return {
        instance,
        services: [...entry.services].toSorted(),
        spans: sorted.length,
        failed: entry.failed,
        p95_ms: sorted.length > 0 ? Math.round(sorted[at]! * 1000) / 1000 : null,
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
