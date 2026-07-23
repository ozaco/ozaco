import type { AnyType } from 'std:shared'

import type { WatchSpec } from '../types'

export interface WatchTarget {
  readonly subId: string | undefined
  readonly name: string
  readonly args: AnyType
  /** The client's last-seen `resourceVersion` on (re)subscribe — used to detect a stale/gone cursor
   * (server restart → version regressed) and emit a `reset` frame so the client refetches. */
  readonly resourceVersion: string | undefined
}

/** Normalize a websocket frame or SSE query into a resource-local watch target. */
export const resolveWatchTarget = (raw: AnyType, subId?: string): WatchTarget | undefined => {
  if (typeof raw?.fn !== 'string') {
    return undefined
  }
  const resourceVersion = raw.resourceVersion
  return {
    subId,
    name: raw.fn,
    args: raw.args ?? {},
    resourceVersion: typeof resourceVersion === 'string' ? resourceVersion : undefined,
  }
}

/** Whether a changed table invalidates a query's watch specification. */
export const matchesWatch = (spec: WatchSpec | undefined, table: string): boolean =>
  spec === undefined || spec === '*' || spec.includes(table)
