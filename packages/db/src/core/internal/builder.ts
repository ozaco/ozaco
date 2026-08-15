// oxlint-disable import/exports-last
import type { Flow } from 'std:effect'
import { operation } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { DbAdapter } from '../adapter'
import { DEFAULT_ORDER, ID, VERSION } from '../const'
import { DbErrors } from '../errors'
import { matches } from '../query/evaluate'
import { and, eq, filterFields, gt, lt, or } from '../query/ops'
import type { ChangeEvent, WatchDelta, WatchOptions } from '../types/change'
import type { Doc } from '../types/common'
import type { QueryHandle } from '../types/db'
import type { Filter, FilterValue, OrderBy, Page, PaginateOptions } from '../types/query'
import type { TableSpec } from '../types/schema'

import { decodeCursor, encodeCursor } from './cursor'
import type { Hub } from './hub'

export interface BuilderDeps {
  readonly spec: TableSpec
  readonly hub: Hub
}

interface QueryState {
  readonly match: Readonly<Record<string, FilterValue>>
  readonly filters: readonly Filter[]
  readonly order: OrderBy | null
}

const predicatesOf = (state: QueryState): Filter[] => [
  ...Object.entries(state.match).map(([field, value]) => eq(field, value)),
  ...state.filters,
]

const combine = (predicates: readonly Filter[]): Filter | null => {
  if (predicates.length === 0) {
    return null
  }
  return predicates.length === 1 ? predicates[0]! : and(...predicates)
}

/** The first field referenced by the query that is not a column of the table, or null. */
const unknownField = (
  spec: TableSpec,
  state: QueryState,
  extra: readonly string[],
): string | null => {
  const known = new Set(spec.columns.map(column => column.name))
  const referenced = [
    ...Object.keys(state.match),
    ...state.filters.flatMap(filterFields),
    ...(state.order ? [state.order.field] : []),
    ...extra,
  ]
  return referenced.find(field => !known.has(field)) ?? null
}

const guard = operation(function* (spec: TableSpec, state: QueryState, extra: readonly string[]) {
  const bad = unknownField(spec, state, extra)
  if (bad) {
    return yield* fail(DbErrors.Validation, `unknown column "${bad}" in query on "${spec.name}"`)
  }
})

const orderOf = (state: QueryState): readonly OrderBy[] =>
  state.order ? [state.order, { field: ID, direction: state.order.direction }] : []

const runFind = operation(function* (deps: BuilderDeps, state: QueryState, limit: number | null) {
  yield* guard(deps.spec, state, [])
  return yield* DbAdapter.actions.find({
    table: deps.spec,
    filter: combine(predicatesOf(state)),
    order: orderOf(state),
    limit,
    offset: null,
  })
})

const runPaginate = operation(function* (
  deps: BuilderDeps,
  state: QueryState,
  options: PaginateOptions,
) {
  yield* guard(deps.spec, state, [state.order ? state.order.field : DEFAULT_ORDER])
  const limit = Math.max(1, Math.trunc(options.limit))
  const column = state.order?.field ?? DEFAULT_ORDER
  const sortDirection = state.order?.direction ?? 'asc'
  const travel = options.direction ?? 'forward'

  const decoded = options.cursor ? yield* decodeCursor(options.cursor) : null
  const cursor =
    decoded && decoded.column === column && decoded.direction === sortDirection ? decoded : null

  const forwardOp = sortDirection === 'asc' ? gt : lt
  const backwardOp = sortDirection === 'asc' ? lt : gt
  const seek = travel === 'backward' ? backwardOp : forwardOp
  const queryDirection: 'asc' | 'desc' =
    travel === 'backward' ? (sortDirection === 'asc' ? 'desc' : 'asc') : sortDirection

  const predicates = predicatesOf(state)
  if (cursor) {
    const boundary = cursor.value as FilterValue
    predicates.push(or(seek(column, boundary), and(eq(column, boundary), seek(ID, cursor.id))))
  }

  const found = yield* DbAdapter.actions.find({
    table: deps.spec,
    filter: combine(predicates),
    order: [
      { field: column, direction: queryDirection },
      { field: ID, direction: queryDirection },
    ],
    limit: limit + 1,
    offset: null,
  })

  const hasMore = found.length > limit
  const window = hasMore ? found.slice(0, limit) : [...found]
  const rows = travel === 'backward' ? window.toReversed() : window

  const first = rows[0]
  const last = rows.at(-1)
  const edge = (row: Doc): string =>
    encodeCursor({ column, direction: sortDirection, value: row[column], id: String(row[ID]) })

  const hasNext = travel === 'backward' ? cursor !== null : hasMore
  const hasPrev = travel === 'backward' ? hasMore : cursor !== null

  const total = options.count
    ? yield* DbAdapter.actions.count({ table: deps.spec, filter: combine(predicatesOf(state)) })
    : undefined

  return {
    data: rows,
    pageInfo: {
      nextCursor: hasNext && last ? edge(last) : null,
      prevCursor: hasPrev && first ? edge(first) : null,
      hasNext,
      hasPrev,
    },
    total,
    version: deps.hub.version(deps.spec.name),
  } as Page<AnyType>
})

interface WatchComputation {
  readonly rows: readonly Doc[]
  readonly delta: WatchDelta<AnyType>
}

const watchFlow = (
  deps: BuilderDeps,
  state: QueryState,
  options?: WatchOptions,
): Flow<AnyType, never> =>
  ({
    *[Symbol.iterator]() {
      const table = deps.spec.name
      const subscription = yield* deps.hub.changes(table)
      const mode = options?.mode ?? 'snapshot'
      const filter = combine(predicatesOf(state))
      // the ids+versions of the last computed result — powers delta diffing AND the
      // "this change cannot affect this query" wake-up skip
      let known: Map<string, number> | null = null
      // hub version already reflected by the last recompute; queued events at or below it are
      // coalesced away without touching the database
      let computed = -1

      const recompute = operation(function* (): Generator<AnyType, WatchComputation, AnyType> {
        // capture BEFORE the read: anything committed after this point recomputes again
        computed = deps.hub.version(table)
        const rows = yield* runFind(deps, state, null)
        const next = new Map<string, number>()
        const added: Doc[] = []
        const changed: Doc[] = []
        for (const row of rows) {
          const id = String(row[ID])
          const version = Number(row[VERSION] ?? 0)
          next.set(id, version)
          if (!known) {
            continue
          }
          const before = known.get(id)
          if (before === undefined) {
            added.push(row)
          } else if (before !== version) {
            changed.push(row)
          }
        }
        const removed: string[] = []
        if (known) {
          for (const id of known.keys()) {
            if (!next.has(id)) {
              removed.push(id)
            }
          }
        }
        const delta: WatchDelta<AnyType> = known
          ? { added, changed, removed, version: computed }
          : { added: [...rows], changed: [], removed: [], version: computed }
        known = next
        return { rows, delta }
      })

      /** true when the event provably cannot change this query's result. */
      const skippable = (event: ChangeEvent): boolean => {
        if (!known || event.op === 'touch' || event.id === '') {
          return false
        }
        if (event.op === 'delete') {
          return !known.has(event.id)
        }
        if (!event.doc) {
          return false
        }
        const relevant = filter ? matches(event.doc, filter) : true
        return !relevant && !known.has(event.id)
      }

      let primed = false
      return {
        next: operation(function* () {
          if (!primed) {
            primed = true
            const sinceCurrent =
              options?.since !== undefined && deps.hub.version(table) === options.since
            const initial = yield* recompute()
            if (!sinceCurrent) {
              return {
                done: false as const,
                value:
                  mode === 'delta'
                    ? initial.delta
                    : ({ rows: initial.rows, version: computed } as AnyType),
              }
            }
            // consumer is already current — the baseline was computed silently for future diffs
          }
          for (;;) {
            const step = yield* subscription.next()
            if (step.done) {
              continue
            }
            const event = step.value
            if (event.version <= computed || skippable(event)) {
              continue
            }
            const result = yield* recompute()
            if (
              mode === 'delta' &&
              result.delta.added.length === 0 &&
              result.delta.changed.length === 0 &&
              result.delta.removed.length === 0
            ) {
              continue
            }
            return {
              done: false as const,
              value:
                mode === 'delta'
                  ? result.delta
                  : ({ rows: result.rows, version: computed } as AnyType),
            }
          }
        }),
      }
    },
  }) as Flow<AnyType, never>

/** Build the immutable, lazily-compiled {@link QueryHandle} over one table. */
export const createQueryHandle = (deps: BuilderDeps, state?: QueryState): QueryHandle<AnyType> => {
  const current: QueryState = state ?? { match: {}, filters: [], order: null }

  return {
    where: match =>
      createQueryHandle(deps, {
        ...current,
        match: { ...current.match, ...(match as Record<string, FilterValue>) },
      }),
    filter: (...filters) =>
      createQueryHandle(deps, { ...current, filters: [...current.filters, ...filters] }),
    order: (field, direction = 'asc') =>
      createQueryHandle(deps, { ...current, order: { field, direction } }),

    collect: operation(function* () {
      return yield* runFind(deps, current, null)
    }),
    take: operation(function* (count: number) {
      return yield* runFind(deps, current, Math.max(0, Math.trunc(count)))
    }),
    first: operation(function* () {
      const rows = yield* runFind(deps, current, 1)
      return rows[0] ?? null
    }),
    unique: operation(function* () {
      const rows = yield* runFind(deps, current, 2)
      if (rows.length > 1) {
        return yield* fail(
          DbErrors.DataIntegrity,
          `query on "${deps.spec.name}" matched multiple rows`,
        )
      }
      return rows[0] ?? null
    }),
    count: operation(function* () {
      yield* guard(deps.spec, current, [])
      return yield* DbAdapter.actions.count({
        table: deps.spec,
        filter: combine(predicatesOf(current)),
      })
    }),
    exists: operation(function* () {
      const rows = yield* runFind(deps, current, 1)
      return rows.length > 0
    }),
    paginate: operation(function* (options: PaginateOptions) {
      return yield* runPaginate(deps, current, options)
    }),
    watch: ((options?: WatchOptions) => watchFlow(deps, current, options)) as AnyType,
  }
}
