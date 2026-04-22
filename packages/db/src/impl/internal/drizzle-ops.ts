import type { Operation } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type {
  DeleteQuery,
  InsertQuery,
  InsertReturning,
  QueryBuilder,
  SelectQuery,
  UpdateQuery,
  UpdateReturning,
  WhereClause,
} from '../../query'
import type { DbError } from '../../runtime'
import type { InferInsert, InferRow } from '../../schema/infer'
import type { SchemaDef, TableDef } from '../../schema/types'

import type { DrizzleRuntime } from './drizzle-base'
import { extractChangeCount, op, runPromise } from './drizzle-base'

const buildWhere = <TTable extends TableDef>(
  runtime: DrizzleRuntime,
  drizzleTable: AnyType,
  clause: WhereClause<TTable>,
): AnyType => {
  const parts: AnyType[] = []
  for (const key of Object.keys(clause) as (keyof WhereClause<TTable>)[]) {
    const column = drizzleTable[key as string]
    if (!column) {
      continue
    }
    parts.push(runtime.eq(column, (clause as Record<string, unknown>)[key as string]))
  }
  if (parts.length === 0) {
    return undefined
  }
  if (parts.length === 1) {
    return parts[0]
  }
  return runtime.and(...parts)
}

const resolveTable = (runtime: DrizzleRuntime, table: TableDef): AnyType => {
  const drizzleTable = runtime.tables[table.name]
  if (!drizzleTable) {
    throw new Error(`Table "${table.name}" not registered in driver schema`)
  }
  return drizzleTable
}

const createSelect = <TTable extends TableDef>(
  runtime: DrizzleRuntime,
  table: TTable,
): SelectQuery<TTable> => {
  const drizzleTable = resolveTable(runtime, table)
  const state: {
    where: WhereClause<TTable> | null
    limit: number | null
    offset: number | null
    orderBy: Array<{ column: string; direction: 'asc' | 'desc' }>
  } = { where: null, limit: null, offset: null, orderBy: [] }

  const build = () => {
    let query = runtime.db.select().from(drizzleTable) as AnyType
    if (state.where) {
      const whereExpr = buildWhere(runtime, drizzleTable, state.where)
      if (whereExpr !== undefined) {
        query = query.where(whereExpr)
      }
    }
    if (state.orderBy.length > 0) {
      const orderExprs = state.orderBy.map(o =>
        o.direction === 'desc'
          ? runtime.desc(drizzleTable[o.column])
          : runtime.asc(drizzleTable[o.column]),
      )
      query = query.orderBy(...orderExprs)
    }
    if (state.limit !== null) {
      query = query.limit(state.limit)
    }
    if (state.offset !== null) {
      query = query.offset(state.offset)
    }
    return query
  }

  const chain: SelectQuery<TTable> = {
    where(clause) {
      state.where = clause
      return chain
    },
    limit(count) {
      state.limit = count
      return chain
    },
    offset(count) {
      state.offset = count
      return chain
    },
    orderBy(column, direction = 'asc') {
      state.orderBy.push({ column: column as string, direction })
      return chain
    },
    all: () => runPromise(() => build()) as Operation<InferRow<TTable>[], DbError>,
    first: () =>
      op<InferRow<TTable> | null, DbError>(function* () {
        const rows = yield* runPromise(() => build().limit(1))
        return (rows as InferRow<TTable>[])[0] ?? null
      }),
    firstOrFail: () =>
      op<InferRow<TTable>, DbError>(function* () {
        const rows = yield* runPromise(() => build().limit(1))
        const row = (rows as InferRow<TTable>[])[0]
        if (row === undefined) {
          yield* fail('not-found' as DbError, `no rows in ${table.name}`)
          throw new Error('unreachable')
        }
        return row
      }),
  }

  return chain
}

const createInsert = <TTable extends TableDef>(
  runtime: DrizzleRuntime,
  table: TTable,
): InsertQuery<TTable> => {
  const drizzleTable = resolveTable(runtime, table)
  const rows: InferInsert<TTable>[] = []

  const chain: InsertQuery<TTable> = {
    values(row) {
      rows.push(row)
      return chain
    },
    valuesMany(many) {
      rows.push(...many)
      return chain
    },
    returning(): InsertReturning<TTable> {
      const buildReturning = () => runtime.db.insert(drizzleTable).values(rows).returning()
      const returning: InsertReturning<TTable> = {
        all: () => runPromise(() => buildReturning()) as Operation<InferRow<TTable>[], DbError>,
        first: () =>
          op<InferRow<TTable> | null, DbError>(function* () {
            const result = yield* runPromise(() => buildReturning())
            return (result as InferRow<TTable>[])[0] ?? null
          }),
        firstOrFail: () =>
          op<InferRow<TTable>, DbError>(function* () {
            const result = yield* runPromise(() => buildReturning())
            const row = (result as InferRow<TTable>[])[0]
            if (row === undefined) {
              yield* fail('not-found' as DbError, `insert returned no rows`)
              throw new Error('unreachable')
            }
            return row
          }),
      }
      return returning
    },
    execute: () =>
      op<void, DbError>(function* () {
        yield* runPromise(() => runtime.db.insert(drizzleTable).values(rows))
      }),
  }

  return chain
}

const createUpdate = <TTable extends TableDef>(
  runtime: DrizzleRuntime,
  table: TTable,
): UpdateQuery<TTable> => {
  const drizzleTable = resolveTable(runtime, table)
  const state: {
    set: Partial<InferRow<TTable>> | null
    where: WhereClause<TTable> | null
  } = { set: null, where: null }

  const build = () => {
    let query = runtime.db.update(drizzleTable).set(state.set ?? {}) as AnyType
    if (state.where) {
      const whereExpr = buildWhere(runtime, drizzleTable, state.where)
      if (whereExpr !== undefined) {
        query = query.where(whereExpr)
      }
    }
    return query
  }

  const chain: UpdateQuery<TTable> = {
    set(values) {
      state.set = values
      return chain
    },
    where(clause) {
      state.where = clause
      return chain
    },
    returning(): UpdateReturning<TTable> {
      const buildReturning = () => build().returning()
      return {
        all: () => runPromise(() => buildReturning()) as Operation<InferRow<TTable>[], DbError>,
        first: () =>
          op<InferRow<TTable> | null, DbError>(function* () {
            const rows = yield* runPromise(() => buildReturning())
            return (rows as InferRow<TTable>[])[0] ?? null
          }),
      }
    },
    execute: () =>
      op<number, DbError>(function* () {
        const result = yield* runPromise(() => build())
        return extractChangeCount(result)
      }),
  }

  return chain
}

const createDelete = <TTable extends TableDef>(
  runtime: DrizzleRuntime,
  table: TTable,
): DeleteQuery<TTable> => {
  const drizzleTable = resolveTable(runtime, table)
  const state: { where: WhereClause<TTable> | null } = { where: null }

  const build = () => {
    let query = runtime.db.delete(drizzleTable) as AnyType
    if (state.where) {
      const whereExpr = buildWhere(runtime, drizzleTable, state.where)
      if (whereExpr !== undefined) {
        query = query.where(whereExpr)
      }
    }
    return query
  }

  const chain: DeleteQuery<TTable> = {
    where(clause) {
      state.where = clause
      return chain
    },
    execute: () =>
      op<number, DbError>(function* () {
        const result = yield* runPromise(() => build())
        return extractChangeCount(result)
      }),
  }

  return chain
}

export const createQueryBuilder = (runtime: DrizzleRuntime, schema: SchemaDef): QueryBuilder => {
  const builder: QueryBuilder = {
    from: table => createSelect(runtime, table),
    insert: table => createInsert(runtime, table),
    update: table => createUpdate(runtime, table),
    delete: table => createDelete(runtime, table),
    transaction: <T, E = never>(fn: (tx: QueryBuilder) => Operation<T, E | DbError>) =>
      op<T, E | DbError>(function* () {
        yield* runPromise(() => runtime.execRaw('BEGIN'))
        try {
          const result = yield* fn(builder)
          yield* runPromise(() => runtime.execRaw('COMMIT'))
          return result
        } catch (error) {
          yield* runPromise(() => runtime.execRaw('ROLLBACK'))
          throw error
        }
      }),
    raw: <T = unknown>(query: string, params: unknown[] = []) =>
      op<T[], DbError>(function* () {
        const rows = yield* runPromise(() => runtime.execRaw(query, params))
        return rows as T[]
      }),
  }
  void schema
  return builder
}
