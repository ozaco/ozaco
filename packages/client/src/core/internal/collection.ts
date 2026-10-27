import type { Future, Operation, Scope, Task } from 'std:effect'
import { createFutureFlow, createQueue, toFuture } from 'std:effect'

import type { ClientDef } from '../types/client'

import { watch } from './realtime'

const DEFAULT_LIMIT = 100
const DEFAULT_ORDER = { field: '_created_at', direction: 'desc' } as const

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/u

/** A value as it sorts: a timestamp — a number, a `Date`, an ISO string (a `list` page carries
 * `_created_at` as the ISO text its JSON wire gives, a live frame as the number the socket
 * codec keeps; both must meet as one key) — else its text. */
const sortKey = (value: unknown): number | string => {
  if (typeof value === 'number') {
    return value
  }

  if (value instanceof Date) {
    return value.getTime()
  }

  if (typeof value === 'string' && ISO_DATE.test(value)) {
    const parsed = Date.parse(value)

    return Number.isNaN(parsed) ? value : parsed
  }

  return String(value ?? '')
}

/** The keyset order of `order`, `_id` breaking ties the way the server's does. */
const comparatorOf = <TDoc extends { readonly _id: string }>(
  order: NonNullable<ClientDef.CollectionOptions['order']>,
): ((left: TDoc, right: TDoc) => number) => {
  const sign = order.direction === 'asc' ? 1 : -1

  return (left, right) => {
    const a = sortKey((left as Record<string, unknown>)[order.field])
    const b = sortKey((right as Record<string, unknown>)[order.field])
    const byField =
      typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))

    return sign * (byField || left._id.localeCompare(right._id))
  }
}

/** See `ClientDef.Collection`. */
export const createCollection = <TDoc extends { readonly _id: string }>(
  client: {
    readonly ctx: ClientDef.Context
    readonly scope: Scope
    readonly call: ClientDef.Statics['$call']
  },
  resource: string,
  options: ClientDef.CollectionOptions | undefined,
): ClientDef.Collection<TDoc> => {
  const { ctx, scope, call } = client
  const order = options?.order ?? DEFAULT_ORDER
  const limit = options?.limit ?? DEFAULT_LIMIT
  const compare = comparatorOf<TDoc>(order)
  const byId = new Map<string, TDoc>()
  // the rows the live WINDOW holds right now (the first page's worth, kept by the server)
  const window = new Map<string, TDoc>()
  const queue = createQueue<readonly TDoc[]>()
  let current: readonly TDoc[] = []
  let cursor: string | null = null
  let watching: Task<void> | null = null
  // drops the watch's socket from `$realtime` the moment `stop` is called
  let detach: (() => void) | null = null

  const publish = (): void => {
    current = [...byId.values()].toSorted(compare)
    queue.add(current)
  }

  const merge = (rows: readonly TDoc[], removed: readonly string[] = []): void => {
    for (const row of rows) {
      byId.set(row._id, row)
    }

    for (const id of removed) {
      byId.delete(id)
    }

    publish()
  }

  /**
   * A frame's `removed` names rows that LEFT THE WINDOW — a deleted row, but also one a newer
   * row pushed off its end, which the list still holds. The window tells them apart: with the
   * window full, a row that would still sort inside it (at or before its last row) is gone from
   * the set; one that sorts after merely fell off. A window short of `limit` lost nothing to
   * sliding — every removal there is a deletion.
   */
  const frame = (rows: readonly TDoc[], removed: readonly string[]): void => {
    for (const id of removed) {
      window.delete(id)
    }

    for (const row of rows) {
      window.set(row._id, row)
    }

    const kept = [...window.values()].toSorted(compare)
    const tail = kept.at(-1)
    const deleted = removed.filter(id => {
      const row = byId.get(id)

      return row !== undefined && (kept.length < limit || !tail || compare(row, tail) <= 0)
    })

    merge(rows, deleted)
  }

  function* page(from: string | null): Operation<void> {
    const result = (yield* call(`${resource}.${options?.action ?? 'list'}`, {
      filter: options?.filter,
      order: order.field,
      direction: order.direction ?? 'desc',
      limit,
      cursor: from ?? undefined,
    })) as ClientDef.Page<TDoc>

    cursor = result.nextCursor
    merge(result.data)
  }

  // the live window: the first page's worth of the set, its frames merged in — a new row lands
  // in it (newest first), a change or removal of a row it holds reaches the list
  const follow = (): Task<void> =>
    scope.run(
      function* () {
        const feed = yield* watch<TDoc>(
          ctx,
          resource,
          { filter: options?.filter, order, limit, path: options?.path },
          {
            detach: fn => {
              detach = fn
            },
          },
        )

        for (;;) {
          const step = yield* feed.next()

          if (step.done) {
            return
          }

          if (step.value.t === 'sync') {
            // a resync replaces the window wholesale: what it no longer holds within its range
            // is gone
            const synced = step.value.rows
            const gone = [...window.keys()].filter(id => !synced.some(row => row._id === id))

            window.clear()
            frame(synced, gone)
          } else if (step.value.t === 'delta') {
            frame([...step.value.added, ...step.value.changed], step.value.removed)
          }
        }
      },
      { detached: true },
    )

  const load = (): Future<readonly TDoc[]> =>
    toFuture(scope, function* () {
      byId.clear()
      yield* page(null)
      watching ??= follow()

      return current
    })

  const more = (): Future<boolean> =>
    toFuture(scope, function* () {
      if (cursor === null) {
        return false
      }

      yield* page(cursor)

      return true
    })

  return {
    rows: () => current,
    load,
    more,
    hasMore: () => cursor !== null,
    changes: createFutureFlow(scope, {
      *[Symbol.iterator]() {
        return queue
      },
    }),
    stop: () => {
      detach?.()
      detach = null
      void watching?.halt()
      watching = null
      queue.close()
    },
  }
}
