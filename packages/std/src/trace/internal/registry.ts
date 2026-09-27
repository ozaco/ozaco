import type { Result } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Helpers } from '../types/helpers'

import { MAX_RECORDED_TRACES, RECORDED_KEY, REMOTE_KEY } from './const'

// on `globalThis` under a registered symbol: every std copy in the process (a second install of
// the same release, a hot-reload bundle) shares ONE record of what was recorded where
const registry = (key: symbol): Helpers.Registry => ((globalThis as AnyType)[key] ??= new WeakMap())

/** Add `traceId` under `failure` in `recorded`, the newest last. */
const add = (
  recorded: Helpers.Registry,
  failure: Result.Failure<unknown>,
  traceId: string,
): void => {
  const traces = recorded.get(failure)
  if (!traces) {
    recorded.set(failure, new Set([traceId]))
    return
  }

  // re-adding moves a trace id to the newest end
  traces.delete(traceId)
  traces.add(traceId)

  if (traces.size > MAX_RECORDED_TRACES) {
    const [oldest] = traces
    traces.delete(oldest as string)
  }
}

const has = (
  recorded: Helpers.Registry,
  failure: Result.Failure<unknown>,
  traceId: string,
): boolean => recorded.get(failure)?.has(traceId) === true

/**
 * Remember `failure` as recorded in `traceId` — `remote` when the other side of a wire recorded it
 * (the spans it escapes here say so: `ozaco.failure.remote`). A failure object that lives on (a
 * memoized failed init, a cached negative result) is shared into trace after trace: each failure keeps
 * the LATEST {@link MAX_RECORDED_TRACES} trace ids, the oldest giving way, so the registry stays
 * bounded.
 */
export const markRecordedIn = (
  failure: Result.Failure<unknown>,
  traceId: string,
  remote = false,
): void => {
  add(registry(RECORDED_KEY), failure, traceId)

  if (remote) {
    add(registry(REMOTE_KEY), failure, traceId)
  }
}

export const isRecordedIn = (failure: Result.Failure<unknown>, traceId: string): boolean =>
  has(registry(RECORDED_KEY), failure, traceId)

/** Whether the other side of a wire recorded `failure` in `traceId`. */
export const isRemoteIn = (failure: Result.Failure<unknown>, traceId: string): boolean =>
  has(registry(REMOTE_KEY), failure, traceId)
