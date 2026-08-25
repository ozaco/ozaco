// oxlint-disable import/exports-last
import type { Database, Schema, Spec } from 'db:core'
import { and, DbClient, eq, gt, gte, isNull, lt, notNull } from 'db:core'
import type { ObserveDef, ServerDef } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt, fork, scoped, withResolvers } from 'std:effect'
import { install, isUse } from 'std:plugin'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { ObservePluginDef } from '../types'
import { events, failures, logs, observeTables, requests, spans } from '../utils/tables'

/** rows as plain documents: the handle is untyped on purpose (five tables, one helper). */
type Db = Database.Handle<Record<string, Schema.Types<Spec.Doc, Spec.Doc>>>

/**
 * The store lives in ITS OWN scope: a private `DbClient` over the app's adapter (or the given
 * one), so its contexts never shadow the app's `ctx.db`. Work reaches it through a job queue;
 * the scope ends with the plugin's.
 */
export function* openStore(
  jobs: ObservePluginDef.State['jobs'],
  adapter: ServerDef.PluginLike | undefined,
): Operation<void> {
  const ready = withResolvers<void>('observe store')

  yield* fork(() =>
    scoped(function* () {
      if (adapter) {
        yield* isUse(adapter) ? adapter : install(adapter as AnyType)
      }
      // `safe`: this client shares the adapter with the app's — it must never drop what it does
      // not declare (the app's tables are "leftovers" from its point of view)
      const opened = yield* attempt(() =>
        install(DbClient, { tables: [...observeTables], safe: true }),
      )
      if (isFailure(opened)) {
        ready.reject(opened)
        return
      }
      ready.resolve(undefined)
      for (;;) {
        const job = yield* jobs.next()
        if (job.done) {
          return
        }
        const outcome = yield* attempt(() => job.value.body(opened.value as Db))
        if (isFailure(outcome)) {
          job.value.reject(outcome)
        } else {
          job.value.resolve(outcome.value)
        }
      }
    }),
  )
  yield* ready.operation
}

/** Run one job in the store scope. */
export function* exec<T>(
  state: ObservePluginDef.State,
  body: (db: Db) => Operation<T>,
): Operation<T> {
  const settled = withResolvers<T>('observe job')

  state.jobs.add({
    body,
    resolve: value => settled.resolve(value as T),
    reject: error => settled.reject(error),
  })

  return yield* settled.operation
}

const rowOf = (
  event: Exclude<ObserveDef.Event, { t: 'request-update' }>,
): { table: string; row: Record<string, unknown> } => {
  switch (event.t) {
    case 'request': {
      return { table: requests.name, row: { ...event.row } }
    }

    case 'span': {
      return { table: spans.name, row: { ...event.row } }
    }

    case 'log': {
      return { table: logs.name, row: { ...event.row } }
    }

    case 'failure': {
      return { table: failures.name, row: { ...event.row } }
    }

    default: {
      return { table: events.name, row: { ...event.row } }
    }
  }
}

/** null → undefined: optional columns take absence, not null, on insert. */
const clean = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value ?? undefined]))

/** Write a batch of events grouped per table in one insert each; updates patch after. */
export function* writeBatch(db: Db, batch: readonly ObserveDef.Event[]): Operation<void> {
  const grouped = new Map<string, Record<string, unknown>[]>()
  const updates: ObserveDef.RequestUpdate[] = []

  for (const event of batch) {
    if (event.t === 'request-update') {
      updates.push(event.update)
      continue
    }

    const { table, row } = rowOf(event)
    const rows = grouped.get(table) ?? []
    rows.push(clean(row))
    grouped.set(table, rows)
  }

  for (const [table, rows] of grouped) {
    // a failing batch must never take the server down: drop it, count it
    yield* attempt(() => db.insertMany(table, rows as AnyType))
  }

  // a streamed body finished after its row: patch in the final size + duration
  for (const update of updates) {
    yield* attempt(function* () {
      const row = yield* db.query(requests.name).filter(eq('request_id', update.request_id)).first()

      if (row) {
        yield* db.patch(requests.name, String((row as AnyType)._id), clean(update.patch) as AnyType)
      }
    })
  }
}

export function* requestView(db: Db, requestId: string): Operation<ObserveDef.RequestView | null> {
  const request = yield* db.query(requests.name).filter(eq('request_id', requestId)).first()

  if (!request) {
    return null
  }

  const by = (table: string, order: string) =>
    db.query(table).filter(eq('request_id', requestId)).order(order, 'asc').collect()

  // start order; same millisecond → parents before children (depth in the span tree)
  const raw = (yield* by(spans.name, 'started_at')) as AnyType[]
  const parents = new Map(raw.map(span => [span.span_id, span.parent_span_id ?? null]))

  const depthOf = (id: string): number => {
    let depth = 0
    let at = parents.get(id) ?? null

    while (at !== null && parents.has(at) && depth < 64) {
      depth += 1
      at = parents.get(at) ?? null
    }

    return depth
  }

  const ordered = raw.toSorted(
    (left, right) =>
      Number(left.started_at) - Number(right.started_at) ||
      depthOf(left.span_id) - depthOf(right.span_id),
  )

  return {
    request: request as AnyType,
    spans: ordered as AnyType,
    logs: (yield* by(logs.name, 'ts')) as AnyType,
    failures: (yield* by(failures.name, 'ts')) as AnyType,
    events: (yield* by(events.name, 'ts')) as AnyType,
  }
}

const filtersOf = (query: ObserveDef.Query) => {
  const filters = []

  if (query.service !== undefined) {
    filters.push(eq('service', query.service))
  }

  if (query.action !== undefined) {
    filters.push(eq('action', query.action))
  }

  if (query.status === 'ok') {
    filters.push(isNull('error'))
  }

  if (query.status === 'failed') {
    filters.push(notNull('error'))
  }

  if (query.tag !== undefined) {
    filters.push(eq('error', query.tag))
  }

  if (query.slowerThan !== undefined) {
    filters.push(gt('duration_ms', query.slowerThan))
  }

  if (query.since !== undefined) {
    filters.push(gte('started_at', query.since))
  }

  return filters
}

export function* queryRequests(db: Db, query: ObserveDef.Query): Operation<ObserveDef.Page> {
  const filters = filtersOf(query)
  const base = db.query(requests.name)
  const page = yield* (filters.length > 0 ? base.filter(and(...filters)) : base)
    .order('started_at', 'desc')
    .paginate({ limit: Math.max(1, Math.min(500, query.limit ?? 50)), cursor: query.cursor })

  return { requests: page.data as AnyType, cursor: page.pageInfo.nextCursor }
}

export const matchesQuery = (row: ObserveDef.RequestRow, query: ObserveDef.Query): boolean =>
  (query.service === undefined || row.service === query.service) &&
  (query.action === undefined || row.action === query.action) &&
  (query.status !== 'ok' || row.error === null) &&
  (query.status !== 'failed' || row.error !== null) &&
  (query.tag === undefined || row.error === query.tag) &&
  (query.slowerThan === undefined || (row.duration_ms ?? 0) > query.slowerThan) &&
  (query.since === undefined || row.started_at >= query.since)

/** Delete rows older than a floor across the tables; resolves how many went. */
export function* pruneBefore(
  db: Db,
  floors: { requests: number; logs: number },
): Operation<number> {
  const plan: readonly [string, string, number][] = [
    [requests.name, 'started_at', floors.requests],
    [spans.name, 'started_at', floors.requests],
    [failures.name, 'ts', floors.requests],
    [logs.name, 'ts', floors.logs],
    [events.name, 'ts', floors.logs],
  ]
  let removed = 0

  for (const [table, column, floor] of plan) {
    const stale = yield* db.query(table).filter(lt(column, floor)).collect()

    for (const row of stale) {
      if (yield* db.delete(table, String((row as AnyType)._id))) {
        removed += 1
      }
    }
  }

  return removed
}
