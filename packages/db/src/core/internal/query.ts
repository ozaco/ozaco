import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { DEFAULT_ORDER, FIELDS } from '../const'
import { DbErrors } from '../errors'
import type { Database } from '../types/database'
import type { Helpers } from '../types/helpers'
import type { Spec } from '../types/spec'
import { filterFields, where } from '../utils/filter'

import { decodeCursor, encodeCursor } from './cursor'
import { resolveSince } from './log'
import { watchQuery } from './watch'

const EMPTY: Helpers.QueryState = {
  match: {},
  filters: [],
  order: [],
  fields: null,
  groupBy: null,
}

/** A bare row id used as a cursor (opaque cursors are base64 of JSON — far longer, with
 * punctuation). The page then STARTS at that row (inclusive) instead of after a boundary. */
const BARE_ID = /^[0-9A-Za-z]{8,64}$/u

const SYSTEM_FIELDS: readonly string[] = [FIELDS.id, FIELDS.created, FIELDS.updated, FIELDS.version]

const predicatesOf = (query: Helpers.QueryState): Spec.Filter[] => [
  ...Object.entries(query.match).map(([field, value]) => where.eq(field, value)),
  ...query.filters,
]

const combine = (predicates: readonly Spec.Filter[]): Spec.Filter | null => {
  if (predicates.length === 0) {
    return null
  }

  return predicates.length === 1 ? predicates[0]! : where.and(...predicates)
}

/** The projection an adapter reads: the asked-for columns plus the system fields, so a projected
 * query still paginates, versions and watches. */
const fieldsOf = (query: Helpers.QueryState): readonly string[] | null =>
  query.fields === null ? null : [...new Set([...query.fields, ...SYSTEM_FIELDS])]

/** Fail `db.validation` when the query references a field that is not a column of the table. */
function* guard(target: Helpers.QueryTarget, query: Helpers.QueryState, extra: readonly string[]) {
  const known = new Set(target.spec.columns.map(column => column.name))

  const referenced = [
    ...Object.keys(query.match),
    ...query.filters.flatMap(filter => filterFields(filter)),
    ...query.order.map(entry => entry.field),
    ...(query.fields ?? []),
    ...(query.groupBy ?? []),
    ...extra,
  ]
  const unknown = referenced.find(field => !known.has(field))

  if (unknown !== undefined) {
    return yield* fail(
      DbErrors.Validation,
      `unknown column "${unknown}" in query on "${target.spec.name}"`,
    )
  }
}

/** The effective sort: the declared keys plus `_id` as a deterministic tiebreak. */
const orderOf = (query: Helpers.QueryState): readonly Spec.OrderBy[] =>
  query.order.length === 0
    ? []
    : [...query.order, { field: FIELDS.id, direction: query.order.at(-1)!.direction }]

function* find(target: Helpers.QueryTarget, query: Helpers.QueryState, limit: number | null) {
  yield* guard(target, query, [])

  return yield* target.state.adapter.find({
    table: target.spec,
    filter: combine(predicatesOf(query)),
    order: orderOf(query),
    fields: fieldsOf(query),
    limit,
    offset: null,
  })
}

function* count(target: Helpers.QueryTarget, query: Helpers.QueryState) {
  yield* guard(target, query, [])

  return yield* target.state.adapter.count({
    table: target.spec,
    filter: combine(predicatesOf(query)),
  })
}

/** One aggregate round trip: `groupBy` decides whether the answer is one row or one per group. */
function* aggregate(
  target: Helpers.QueryTarget,
  query: Helpers.QueryState,
  ops: readonly Spec.AggregateOp[],
) {
  const fields = ops.flatMap(op => (op.field === null ? [] : [op.field]))
  yield* guard(target, query, fields)

  return yield* target.state.adapter.aggregate({
    table: target.spec,
    filter: combine(predicatesOf(query)),
    groupBy: query.groupBy ?? [],
    ops,
  })
}

const opOf = (kind: Spec.AggregateOp['kind'], field: string | null): Spec.AggregateOp => ({
  kind,
  field,
  as: kind,
})

/** One aggregate over the whole set — the answer is the single value under its own name. */
const scalar = (target: Helpers.QueryTarget, query: Helpers.QueryState, op: Spec.AggregateOp) =>
  function* () {
    const rows = yield* aggregate(target, { ...query, groupBy: null }, [op])
    return rows[0]?.[op.as] ?? null
  }

/** The same aggregate, one answer row per group. */
const grouped = (target: Helpers.QueryTarget, query: Helpers.QueryState, op: Spec.AggregateOp) =>
  function* () {
    return yield* aggregate(target, query, [op])
  }

/** The sort keys a page travels along: the query's own, or `_created_at` when it declared none,
 * always closed with the unique `_id` tiebreak. */
const pageKeys = (query: Helpers.QueryState): readonly Spec.OrderBy[] => {
  const declared =
    query.order.length === 0
      ? [{ field: DEFAULT_ORDER as string, direction: 'asc' as const }]
      : query.order

  return [...declared, { field: FIELDS.id as string, direction: declared.at(-1)!.direction }]
}

/**
 * "Strictly after this row" along a multi-key sort, as one portable predicate:
 *
 *   k1 > v1  OR  (k1 = v1 AND (k2 > v2 OR (k2 = v2 AND … )))
 *
 * `inclusive` relaxes the LAST comparison to `>=`, so a cursor naming a row starts the window AT
 * it instead of after it.
 */
const seekFrom = (
  seek: { readonly keys: Spec.Cursor['keys']; readonly flip: boolean; readonly inclusive: boolean },
  at = 0,
): Spec.Filter => {
  const { keys, flip, inclusive } = seek
  const key = keys[at]!
  const ascending = flip ? key.direction === 'desc' : key.direction === 'asc'
  const beyond = ascending ? where.gt : where.lt
  const value = key.value as Spec.FilterValue
  const last = at === keys.length - 1

  const step =
    last && inclusive
      ? where.or(beyond(key.field, value), where.eq(key.field, value))
      : beyond(key.field, value)

  if (last) {
    return step
  }

  return where.or(step, where.and(where.eq(key.field, value), seekFrom(seek, at + 1)))
}

/** Keyset pagination over every sort key plus `_id`: the cursor names the boundary row and the
 * page is fetched with one extra row to learn whether more follow. Backward travel flips the
 * query direction and restores the display order afterwards. */
function* paginate(
  target: Helpers.QueryTarget,
  query: Helpers.QueryState,
  options: Spec.PaginateOptions,
) {
  const keys = pageKeys(query)
  yield* guard(
    target,
    query,
    keys.map(key => key.field),
  )
  const limit = Math.max(1, Math.trunc(options.limit))
  const backward = options.direction === 'backward'

  let cursor: Spec.Cursor | null = null
  // a bare row id names an INCLUSIVE boundary — "the window starts at this row"
  let inclusive = false

  if (options.cursor && BARE_ID.test(options.cursor)) {
    inclusive = true

    if (keys.length === 1) {
      // ordering by `_id` alone: the boundary value IS the id (a vanished row degrades gracefully)
      cursor = {
        keys: [{ field: keys[0]!.field, direction: keys[0]!.direction, value: options.cursor }],
      }
    } else {
      // the lookup carries the query's own predicates: a row outside this query's set (another
      // tenant's, under a scope filter) must answer EXACTLY like a missing one — no existence oracle
      const boundary = yield* target.state.adapter.find({
        table: target.spec,
        filter: combine([...predicatesOf(query), where.eq(FIELDS.id, options.cursor)]),
        order: [{ field: FIELDS.id, direction: 'asc' }],
        fields: null,
        limit: 1,
        offset: null,
      })

      if (boundary.length === 0) {
        return yield* fail(
          DbErrors.Cursor,
          `cursor names no row in this query's set: ${options.cursor}`,
        )
      }

      cursor = {
        keys: keys.map(key => ({
          field: key.field,
          direction: key.direction,
          value: boundary[0]![key.field],
        })),
      }
    }
  } else if (options.cursor) {
    const decoded = yield* decodeCursor(options.cursor)

    // a cursor minted for another sort is ignored rather than producing a nonsensical window
    const sameSort =
      decoded.keys.length === keys.length &&
      decoded.keys.every(
        (key, at) => key.field === keys[at]!.field && key.direction === keys[at]!.direction,
      )
    cursor = sameSort ? decoded : null
  }

  const predicates = predicatesOf(query)

  if (cursor) {
    predicates.push(seekFrom({ keys: cursor.keys, flip: backward, inclusive }))
  }

  const found = yield* target.state.adapter.find({
    table: target.spec,
    filter: combine(predicates),
    fields: fieldsOf(query),

    order: keys.map(key => ({
      field: key.field,
      direction: backward
        ? key.direction === 'asc'
          ? ('desc' as const)
          : ('asc' as const)
        : key.direction,
    })),
    limit: limit + 1,
    offset: null,
  })

  const hasMore = found.length > limit
  const window = hasMore ? found.slice(0, limit) : [...found]
  const rows = backward ? window.toReversed() : window

  const edge = (row: Spec.Doc) =>
    encodeCursor({
      keys: keys.map(key => ({
        field: key.field,
        direction: key.direction,
        value: row[key.field],
      })),
    })
  const first = rows[0]
  const last = rows.at(-1)
  const hasNext = backward ? cursor !== null : hasMore
  const hasPrev = backward ? hasMore : cursor !== null
  const nextCursor = hasNext && last ? yield* edge(last) : null
  const prevCursor = hasPrev && first ? yield* edge(first) : null

  const total = options.count ? yield* count(target, query) : undefined

  return {
    data: rows,
    pageInfo: { nextCursor, prevCursor, hasNext, hasPrev },
    total,
    token: target.state.hub.version(target.spec.name),
  } as Spec.Page<AnyType>
}

/** Answer a `since` token from the table's change log (an unknown table has no log → snapshot). */
function* resolveSinceOf(target: Helpers.QueryTarget, since: string) {
  const log = target.state.logs.get(target.spec.name)
  return log ? yield* resolveSince(target.state, log, since) : ('snapshot' as const)
}

/** Build the immutable, lazily-compiled {@link Database.Query} over one table. An unknown table
 * still yields a handle (its terminals fail `db.validation`). */
export const createQuery = (
  target: Helpers.QueryTarget,
  query: Helpers.QueryState = EMPTY,
): Database.Query<AnyType> => ({
  where: match =>
    createQuery(target, {
      ...query,
      match: { ...query.match, ...(match as Record<string, Spec.FilterValue>) },
    }),
  filter: (...filters) =>
    createQuery(target, { ...query, filters: [...query.filters, ...filters] }),

  // sort keys STACK: `.order('priority', 'desc').order('title')` sorts by both, in that order
  order: (field, direction = 'asc') =>
    createQuery(target, { ...query, order: [...query.order, { field, direction }] }),
  select: ((...fields: readonly string[]) =>
    createQuery(target, {
      ...query,
      fields: [...(query.fields ?? []), ...fields],
    })) as Database.Query<AnyType>['select'],
  groupBy: ((...fields: readonly string[]) => {
    const next = { ...query, groupBy: [...(query.groupBy ?? []), ...fields] }

    return {
      count: grouped(target, next, opOf('count', null)),
      sum: (field: string) => grouped(target, next, opOf('sum', field))(),
      avg: (field: string) => grouped(target, next, opOf('avg', field))(),
      min: (field: string) => grouped(target, next, opOf('min', field))(),
      max: (field: string) => grouped(target, next, opOf('max', field))(),
    }
  }) as Database.Query<AnyType>['groupBy'],

  *collect() {
    return yield* find(target, query, null)
  },
  *take(limit: number) {
    return yield* find(target, query, Math.max(0, Math.trunc(limit)))
  },
  *first() {
    const rows = yield* find(target, query, 1)
    return rows[0] ?? null
  },
  *unique() {
    const rows = yield* find(target, query, 2)
    if (rows.length > 1) {
      return yield* fail(
        DbErrors.DataIntegrity,
        `query on "${target.spec.name}" matched multiple rows`,
      )
    }
    return rows[0] ?? null
  },
  *count() {
    return yield* count(target, query)
  },
  *exists() {
    const rows = yield* find(target, query, 1)
    return rows.length > 0
  },
  *sum(field: string) {
    return ((yield* scalar(target, query, opOf('sum', field))()) as number | null) ?? 0
  },
  avg: ((field: string) => scalar(target, query, opOf('avg', field))()) as AnyType,
  min: ((field: string) => scalar(target, query, opOf('min', field))()) as AnyType,
  max: ((field: string) => scalar(target, query, opOf('max', field))()) as AnyType,

  *paginate(options: Spec.PaginateOptions) {
    return yield* paginate(target, query, options)
  },
  watch: (options => {
    const filter = combine(predicatesOf(query))
    return watchQuery({
      hub: target.state.hub,
      table: target.spec.name,
      filter,
      // the fields a change must touch to possibly move a row into/out of this result
      fields: new Set([
        ...predicatesOf(query).flatMap(entry => filterFields(entry)),
        ...query.order.map(entry => entry.field),
      ]),
      load: () => find(target, query, null),
      resolve: since => resolveSinceOf(target, since),
      options,
    })
  }) as Database.Query<AnyType>['watch'],
})
