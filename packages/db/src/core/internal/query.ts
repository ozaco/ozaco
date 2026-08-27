import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { DEFAULT_ORDER, FIELDS } from '../const'
import { DbErrors } from '../errors'
import type { Database } from '../types/database'
import type { Helpers } from '../types/helpers'
import type { Spec } from '../types/spec'
import { and, eq, filterFields, gt, lt, or } from '../utils/filter'

import { decodeCursor, encodeCursor } from './cursor'
import { resolveSince } from './log'
import { watchQuery } from './watch'

const EMPTY: Helpers.QueryState = { match: {}, filters: [], order: null }

/** A bare row id used as a cursor (opaque cursors are base64 of JSON — far longer, with
 * punctuation). The page then STARTS at that row (inclusive) instead of after a boundary. */
const BARE_ID = /^[0-9A-Za-z]{8,64}$/u

const predicatesOf = (query: Helpers.QueryState): Spec.Filter[] => [
  ...Object.entries(query.match).map(([field, value]) => eq(field, value)),
  ...query.filters,
]

const combine = (predicates: readonly Spec.Filter[]): Spec.Filter | null => {
  if (predicates.length === 0) {
    return null
  }

  return predicates.length === 1 ? predicates[0]! : and(...predicates)
}

/** Fail `db.validation` when the query references a field that is not a column of the table. */
function* guard(target: Helpers.QueryTarget, query: Helpers.QueryState, extra: readonly string[]) {
  const known = new Set(target.spec.columns.map(column => column.name))

  const referenced = [
    ...Object.keys(query.match),
    ...query.filters.flatMap(filterFields),
    ...(query.order ? [query.order.field] : []),
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

/** The effective sort: the declared order plus `_id` as a deterministic tiebreak. */
const orderOf = (query: Helpers.QueryState): readonly Spec.OrderBy[] =>
  query.order ? [query.order, { field: FIELDS.id, direction: query.order.direction }] : []

function* find(target: Helpers.QueryTarget, query: Helpers.QueryState, limit: number | null) {
  yield* guard(target, query, [])

  return yield* target.state.adapter.find({
    table: target.spec,
    filter: combine(predicatesOf(query)),
    order: orderOf(query),
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

/** Keyset pagination over `(order column, _id)`: the cursor names the boundary row and the page
 * is fetched with one extra row to learn whether more follow. Backward travel flips the query
 * direction and restores the display order afterwards. */
function* paginate(
  target: Helpers.QueryTarget,
  query: Helpers.QueryState,
  options: Spec.PaginateOptions,
) {
  const column = query.order?.field ?? DEFAULT_ORDER
  yield* guard(target, query, [column])
  const limit = Math.max(1, Math.trunc(options.limit))
  const sort = query.order?.direction ?? 'asc'
  const backward = options.direction === 'backward'

  let cursor: Spec.Cursor | null = null
  // a bare row id names an INCLUSIVE boundary — "the window starts at this row"
  let inclusive = false

  if (options.cursor && BARE_ID.test(options.cursor)) {
    inclusive = true

    if (column === FIELDS.id) {
      // no lookup needed: the boundary value IS the id (a vanished row degrades gracefully)
      cursor = { column, direction: sort, value: options.cursor, id: options.cursor }
    } else {
      // the lookup carries the query's own predicates: a row outside this query's set (another
      // tenant's, under a scope filter) must answer EXACTLY like a missing one — no existence oracle
      const boundary = yield* target.state.adapter.find({
        table: target.spec,
        filter: combine([...predicatesOf(query), eq(FIELDS.id, options.cursor)]),
        order: [{ field: FIELDS.id, direction: 'asc' }],
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
        column,
        direction: sort,
        value: boundary[0]![column] as Spec.FilterValue,
        id: options.cursor,
      }
    }
  } else if (options.cursor) {
    const decoded = yield* decodeCursor(options.cursor)

    // a cursor minted for another sort is ignored rather than producing a nonsensical window
    cursor = decoded.column === column && decoded.direction === sort ? decoded : null
  }

  const ahead = sort === 'asc' ? gt : lt
  const behind = sort === 'asc' ? lt : gt
  const seek = backward ? behind : ahead
  const queryDirection = backward ? (sort === 'asc' ? 'desc' : 'asc') : sort

  const predicates = predicatesOf(query)

  if (cursor) {
    const boundary = cursor.value as Spec.FilterValue

    const tie = inclusive
      ? or(seek(FIELDS.id, cursor.id), eq(FIELDS.id, cursor.id))
      : seek(FIELDS.id, cursor.id)

    predicates.push(or(seek(column, boundary), and(eq(column, boundary), tie)))
  }

  const found = yield* target.state.adapter.find({
    table: target.spec,
    filter: combine(predicates),
    order: [
      { field: column, direction: queryDirection },
      { field: FIELDS.id, direction: queryDirection },
    ],
    limit: limit + 1,
    offset: null,
  })

  const hasMore = found.length > limit
  const window = hasMore ? found.slice(0, limit) : [...found]
  const rows = backward ? window.toReversed() : window

  const edge = (row: Spec.Doc) =>
    encodeCursor({ column, direction: sort, value: row[column], id: String(row[FIELDS.id]) })
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
  order: (field, direction = 'asc') =>
    createQuery(target, { ...query, order: { field, direction } }),

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
        ...predicatesOf(query).flatMap(filterFields),
        ...(query.order ? [query.order.field] : []),
      ]),
      load: () => find(target, query, null),
      resolve: since => resolveSinceOf(target, since),
      options,
    })
  }) as Database.Query<AnyType>['watch'],
})
