// oxlint-disable import/exports-last
import type { Future } from 'std:effect'
import { attempt, operation } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type {
  CommonQueryMethods,
  DriverConnection,
  Field,
  Interceptor,
  Query,
  QueryContext,
  QueryResult,
  QueryResultRow,
  QuerySqlToken,
  StreamHandler,
} from '../types'

import { classifyPostgresError, DbError } from './errors'

/** Everything the engine needs to run a query on a physical connection. */
export interface EngineDeps {
  readonly connection: DriverConnection
  readonly interceptors: readonly Interceptor[]
  readonly context: QueryContext
}

const firstColumn = (row: QueryResultRow, fields: readonly Field[]): unknown => {
  const key = fields[0]?.name
  return key === undefined ? undefined : row[key]
}

/**
 * Run one query on a connection through the full interceptor pipeline — the effect-native port of
 * Slonik's query execution: `beforeTransformQuery` → `transformQuery` → `beforeQueryExecution`
 * (may short-circuit) → driver → `transformRow` → zod `parser` → `beforeQueryResult` →
 * `afterQueryExecution` (reverse). Driver errors are classified to {@link DbError} tags (never thrown).
 */
export const executeQuery = operation(function* (
  deps: EngineDeps,
  token: QuerySqlToken<AnyType>,
): Generator<AnyType, QueryResult<QueryResultRow>, AnyType> {
  const { connection, interceptors, context } = deps
  let query: Query = { sql: token.sql, values: token.values }

  for (const interceptor of interceptors) {
    if (interceptor.beforeTransformQuery) {
      yield* interceptor.beforeTransformQuery(context, query)
    }
  }
  for (const interceptor of interceptors) {
    if (interceptor.transformQuery) {
      query = yield* interceptor.transformQuery(context, query)
    }
  }

  // an interceptor may satisfy the query without touching the backend (e.g. a cache hit)
  let raw: QueryResult<QueryResultRow> | null = null
  for (const interceptor of interceptors) {
    if (interceptor.beforeQueryExecution) {
      const short = yield* interceptor.beforeQueryExecution(context, query)
      if (short) {
        raw = short
        break
      }
    }
  }

  if (!raw) {
    const outcome = yield* attempt(connection.query(query))
    if (isFailure(outcome)) {
      for (const interceptor of interceptors) {
        if (interceptor.queryExecutionError) {
          yield* interceptor.queryExecutionError(context, query, outcome.error)
        }
      }
      return yield* classifyPostgresError(outcome.error)
    }
    raw = outcome.value
  }

  // per-row transform (interceptors), then validate against the token's zod parser
  const rows: QueryResultRow[] = []
  for (const source of raw.rows) {
    let row: QueryResultRow = source
    for (const interceptor of interceptors) {
      if (interceptor.transformRow) {
        row = yield* interceptor.transformRow(context, query, row, raw.fields)
      }
    }
    if (token.parser) {
      const parsed = token.parser.safeParse(row)
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue: AnyType) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')
        return yield* fail(DbError.DataIntegrity, `row failed validation: ${issues}`)
      }
      rows.push(parsed.data)
    } else {
      rows.push(row)
    }
  }

  const result: QueryResult<QueryResultRow> = {
    command: raw.command,
    fields: raw.fields,
    notices: raw.notices,
    rowCount: raw.rowCount,
    rows,
  }

  for (const interceptor of interceptors) {
    if (interceptor.beforeQueryResult) {
      yield* interceptor.beforeQueryResult(context, query, result)
    }
  }
  for (let index = interceptors.length - 1; index >= 0; index -= 1) {
    const interceptor = interceptors[index]!
    if (interceptor.afterQueryExecution) {
      yield* interceptor.afterQueryExecution(context, query, result)
    }
  }

  return result
})

type RunQuery = (token: QuerySqlToken<AnyType>) => Future<QueryResult<QueryResultRow>>
type RunStream = (token: QuerySqlToken<AnyType>, handler: StreamHandler<AnyType>) => Future<void>

/**
 * Build the {@link CommonQueryMethods} (`any`/`one`/`many`/…) over a `run`/`streamRun` pair. Result-
 * shape errors surface as {@link DbError} tags: `not-found` (0 rows where ≥1 expected) and
 * `data-integrity` (>1 row where exactly 1 expected).
 */
export const makeQueryMethods = (run: RunQuery, streamRun: RunStream): CommonQueryMethods => {
  const methods = {
    query: operation(function* (token: QuerySqlToken<AnyType>) {
      return yield* run(token)
    }),

    any: operation(function* (token: QuerySqlToken<AnyType>) {
      return (yield* run(token)).rows
    }),

    anyFirst: operation(function* (token: QuerySqlToken<AnyType>) {
      const result = yield* run(token)
      return result.rows.map(row => firstColumn(row, result.fields))
    }),

    many: operation(function* (token: QuerySqlToken<AnyType>) {
      const result = yield* run(token)
      if (result.rows.length === 0) {
        return yield* fail(DbError.NotFound, 'expected ≥1 row, got 0')
      }
      return result.rows
    }),

    manyFirst: operation(function* (token: QuerySqlToken<AnyType>) {
      const result = yield* run(token)
      if (result.rows.length === 0) {
        return yield* fail(DbError.NotFound, 'expected ≥1 row, got 0')
      }
      return result.rows.map(row => firstColumn(row, result.fields))
    }),

    maybeOne: operation(function* (token: QuerySqlToken<AnyType>) {
      const result = yield* run(token)
      if (result.rows.length > 1) {
        return yield* fail(DbError.DataIntegrity, `expected ≤1 row, got ${result.rows.length}`)
      }
      return result.rows[0] ?? null
    }),

    maybeOneFirst: operation(function* (token: QuerySqlToken<AnyType>) {
      const result = yield* run(token)
      if (result.rows.length > 1) {
        return yield* fail(DbError.DataIntegrity, `expected ≤1 row, got ${result.rows.length}`)
      }
      return result.rows[0] ? firstColumn(result.rows[0], result.fields) : null
    }),

    one: operation(function* (token: QuerySqlToken<AnyType>) {
      const result = yield* run(token)
      if (result.rows.length === 0) {
        return yield* fail(DbError.NotFound, 'expected exactly 1 row, got 0')
      }
      if (result.rows.length > 1) {
        return yield* fail(
          DbError.DataIntegrity,
          `expected exactly 1 row, got ${result.rows.length}`,
        )
      }
      return result.rows[0]!
    }),

    oneFirst: operation(function* (token: QuerySqlToken<AnyType>) {
      const result = yield* run(token)
      if (result.rows.length === 0) {
        return yield* fail(DbError.NotFound, 'expected exactly 1 row, got 0')
      }
      if (result.rows.length > 1) {
        return yield* fail(
          DbError.DataIntegrity,
          `expected exactly 1 row, got ${result.rows.length}`,
        )
      }
      return firstColumn(result.rows[0]!, result.fields)
    }),

    exists: operation(function* (token: QuerySqlToken<AnyType>) {
      const wrapped: QuerySqlToken = {
        type: token.type,
        sql: `SELECT EXISTS(${token.sql}) AS "exists"`,
        values: token.values,
        parser: null,
      }
      const result = yield* run(wrapped)
      return Boolean((result.rows[0] as AnyType)?.exists)
    }),

    stream: (token: QuerySqlToken<AnyType>, handler: StreamHandler<AnyType>) =>
      streamRun(token, handler),
  }

  return methods as unknown as CommonQueryMethods
}
