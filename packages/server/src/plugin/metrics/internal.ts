// oxlint-disable import/exports-last
import { MetricsStore } from 'server:core'
import type { MetricsStoreDef } from 'server:core'
import { attempt, createContext, operation } from 'std:effect'
import type { Context, Operation } from 'std:effect'
import { isFailure } from 'std:result'
import type { Result } from 'std:result'

import type { CallEvent } from 'server:policy/metrics'
import { JsonCodec } from 'std:codec/impl/json'

import { METRICS_BUFFER_CAP, METRICS_TABLES } from './const'
import type { MetricsTableName } from './const'
import type { MetricsDef } from './types'

/**
 * The scope context carrying the collector state — planted by the `Metrics` setup so the log
 * transport (and the plugin actions) can reach the buffers without any module-global state.
 */
export const MetricsCollectorContext: Context<MetricsDef.State> = createContext<MetricsDef.State>(
  'server:metrics:collector',
)

/** Push onto a bounded buffer, dropping the OLDEST item when full. Sync, never throws. */
export const pushCapped = <T>(buffer: T[], item: T): void => {
  if (buffer.length >= METRICS_BUFFER_CAP) {
    buffer.shift()
  }

  buffer.push(item)
}

/** Pinned-JSON stringify that degrades to `undefined` instead of failing the flush. */
export function* tryStringify(value: unknown): Operation<string | undefined> {
  const text = yield* attempt(() => JsonCodec.actions.stringify(value))

  return isFailure(text) ? undefined : text.value
}

/**
 * `CallEvent` → `MetricsStoreDef.CallRecord` row: the raw cause chain is serialized here (pinned JSON codec —
 * the broker guarantees a codec baseline, we pin JSON explicitly), `meta` comes from the
 * `options.fields` derivation (guarded — a throwing derivation never breaks the flush).
 */
export function* toCallRecord(
  event: CallEvent,
  fields: ((event: CallEvent) => Record<string, string> | undefined) | undefined,
): Operation<MetricsStoreDef.CallRecord> {
  const causes =
    event.causes && event.causes.length > 0 ? yield* tryStringify(event.causes) : undefined

  let extra: Record<string, string> | undefined

  try {
    extra = fields?.(event)
  } catch {
    extra = undefined
  }

  const meta = extra === undefined ? undefined : yield* tryStringify(extra)

  return {
    ts: event.ts,
    service: event.service,
    action: event.action,
    status: event.status,
    durationMs: event.durationMs,
    requestId: event.requestId,
    serviceId: event.serviceId,
    laneId: event.laneId,
    actionId: event.actionId,
    parentActionId: event.parentActionId,
    outcome: event.outcome,
    delivered: event.delivered,
    origin: event.origin,
    transport: event.transport,
    error: event.error,
    causes,
    meta,
  }
}

/** Re-buffer a failed batch at the front, trimming the OLDEST rows above the cap. */
const requeue = <T>(buffer: T[], items: T[]): void => {
  buffer.unshift(...items)

  if (buffer.length > METRICS_BUFFER_CAP) {
    buffer.splice(0, buffer.length - METRICS_BUFFER_CAP)
  }
}

function* reportInsertFailure(
  state: MetricsDef.State,
  table: MetricsTableName,
  failure: Result.Failure<unknown>,
): Operation<void> {
  const data = { table, error: String(failure.error), causes: [...failure.causes] }

  // one error per failure streak — later attempts drop to debug until an insert succeeds again
  yield* state.insertFailures[table] === 0
    ? state.log.error('metrics insert failed — rows re-buffered (oldest drop past cap)', data)
    : state.log.debug('metrics insert still failing', data)

  state.insertFailures[table] += 1
}

function* flushCalls(state: MetricsDef.State): Operation<void> {
  const drained = state.buffers.calls.splice(0)

  if (drained.length === 0) {
    return
  }

  const rows: MetricsStoreDef.Row[] = []

  for (const event of drained) {
    const record = yield* toCallRecord(event, state.options.fields)

    rows.push({ ...record })
  }

  const outcome = yield* attempt(() => MetricsStore.actions.insert(METRICS_TABLES.calls, rows))

  if (isFailure(outcome)) {
    yield* reportInsertFailure(state, METRICS_TABLES.calls, outcome)
    requeue(state.buffers.calls, drained)

    return
  }

  state.insertFailures[METRICS_TABLES.calls] = 0
}

function* flushRecords<T extends MetricsStoreDef.LogRecord | MetricsStoreDef.EventRecord>(
  state: MetricsDef.State,
  table: MetricsTableName,
  buffer: T[],
): Operation<void> {
  const drained = buffer.splice(0)

  if (drained.length === 0) {
    return
  }

  const rows: MetricsStoreDef.Row[] = drained.map(record => ({ ...record }) as MetricsStoreDef.Row)
  const outcome = yield* attempt(() => MetricsStore.actions.insert(table, rows))

  if (isFailure(outcome)) {
    yield* reportInsertFailure(state, table, outcome)
    requeue(buffer, drained)

    return
  }

  state.insertFailures[table] = 0
}

/**
 * Drain every buffer into the store. Loss semantics are AT-MOST-ONCE: a failed insert re-buffers
 * its batch (bounded by the cap, oldest rows dropped first) and is retried on the next flush — a
 * row is never inserted twice, but sustained store outages shed the oldest data.
 */
export const flushAll = operation(function* (state: MetricsDef.State) {
  yield* flushCalls(state)
  yield* flushRecords(state, METRICS_TABLES.logs, state.buffers.logs)
  yield* flushRecords(state, METRICS_TABLES.events, state.buffers.events)
})
