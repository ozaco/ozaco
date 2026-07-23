// oxlint-disable import/exports-last
import type { DatabasePool, FragmentSqlToken, PrimitiveValueExpression } from 'db:core'
import { sql } from 'db:core'
import type { Future, Signal } from 'std:effect'
import { createSignal, operation } from 'std:effect'
import { IO } from 'std:io'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'

import { CREATED, DEFAULT_ORDER, ID, VERSION } from '../const'
import { coerceRow, coerceRows, commaList, ident } from '../internal/coerce'
import { decodeCursor, encodeCursor } from '../internal/cursor'
import type { SchemaDef, TableDef } from '../schema/types'
import type { BusHolder, ChangeBus, ChangeEvent } from '../types/change'
import type { Database, QueryHandle, Row } from '../types/database'
import type { Dialect } from '../types/migrate'
import type { Page, PaginateOptions } from '../types/page'
import type { Filter } from '../utils/expr'
import { and, eq, gt, lt } from '../utils/expr'
import type { MongoFilter } from '../utils/filter'
import { compileFilter } from '../utils/filter'

interface QueryState {
  readonly table: string
  readonly match: Record<string, PrimitiveValueExpression>
  readonly filters: readonly Filter[]
  readonly order: { readonly column: string; readonly direction: 'asc' | 'desc' } | null
}

/**
 * Build the Convex-like {@link Database} over a core `@ozaco/db` {@link DatabasePool}. Writes are
 * validated by each table's zod schema; `_id`/`_createdAt`/`_version` are stamped; every committed
 * write is broadcast on `changes` (and, when a {@link ChangeBus} is supplied, published to the other
 * nodes). Queries + keyset pagination compile to the core `sql` tag and run on the pool.
 */
export const createRealtimeDatabase = (
  pool: DatabasePool,
  schema: SchemaDef,
  config: { busHolder?: BusHolder; dialect?: Dialect } = {},
): Database => {
  const busHolder: BusHolder = config.busHolder ?? {}
  const dialect: Dialect = config.dialect ?? 'postgres'
  const tableOf = (name: string): TableDef => schema.tables[name] as TableDef
  // SurrealQL diverges from the ANSI path in a few statement shapes (see below). `INSERT`/`UPDATE`
  // return the affected records by default — no `RETURNING *`, which SurrealDB's parser rejects.
  const isSurreal = dialect === 'surreal'
  const returningAll = isSurreal ? sql.fragment`` : sql.fragment`RETURNING *`
  const changes = createSignal<ChangeEvent>()
  const versions = new Map<string, number>()
  const versionOf = (name: string): string => String(versions.get(name) ?? 0)
  const bump = (name: string): number => {
    const next = (versions.get(name) ?? 0) + 1
    versions.set(name, next)
    return next
  }

  // `json`-kind columns are bound as JSON TEXT, never as the raw JS value: node-pg encodes a JS array
  // as a Postgres ARRAY literal `{…}`, which a json/jsonb column rejects (`22P02 invalid input syntax
  // for json`). Serializing to a string inserts as text (Postgres casts it to json/jsonb, SQLite stores
  // the text, SurrealDB stores the string) and round-trips through `coerce`'s decode, which JSON-parses
  // `json` columns that come back as strings. Applied consistently across insert/patch/replace.
  const jsonColumnsOf = (name: string): ReadonlySet<string> =>
    new Set(
      tableOf(name)
        .columns.filter(column => column.kind === 'json')
        .map(column => column.name),
    )

  const bindColumn = operation(function* (
    jsonColumns: ReadonlySet<string>,
    column: string,
    value: PrimitiveValueExpression,
  ) {
    if (value === null || value === undefined || !jsonColumns.has(column)) {
      return value
    }
    return (yield* JsonCodec.actions.stringify(value)) as PrimitiveValueExpression
  })

  // Emit a committed write to local watchers and, when a bus is attached (multi-node), to the other
  // nodes. The bus is read from the holder on each write, so it can be attached after construction
  // (the server auto-attaches a Broker-backed bus once resources mount — see `connectBus`).
  const broadcast = operation(function* (event: ChangeEvent) {
    changes.send(event)
    const bus = busHolder.current
    if (bus) {
      yield* bus.publish({ ...event, origin: bus.origin })
    }
  })

  const whereClause = (state: QueryState): FragmentSqlToken => {
    const preds: Filter[] = [
      ...Object.entries(state.match).map(([column, value]) => eq(column, value)),
      ...state.filters,
    ]
    return preds.length === 0 ? sql.fragment`` : sql.fragment`WHERE ${and(...preds)}`
  }

  const direction = (value: 'asc' | 'desc'): FragmentSqlToken =>
    value === 'desc' ? sql.fragment`DESC` : sql.fragment`ASC`

  const runList = (state: QueryState, extra: FragmentSqlToken): Future<readonly Row[]> => {
    const order = state.order
    const orderClause = order
      ? sql.fragment`ORDER BY ${ident(order.column)} ${direction(order.direction)}`
      : sql.fragment``
    return pool.any(
      sql`SELECT * FROM ${ident(state.table)} ${whereClause(state)} ${orderClause} ${extra}`,
    )
  }

  const makeQuery = (state: QueryState): QueryHandle<AnyType> => ({
    where: match =>
      makeQuery({
        ...state,
        match: { ...state.match, ...(match as Record<string, PrimitiveValueExpression>) },
      }),
    filter: predicate => makeQuery({ ...state, filters: [...state.filters, predicate] }),
    match: (filter: MongoFilter) => {
      const compiled = compileFilter(filter, tableOf(state.table).columns)
      return compiled
        ? makeQuery({ ...state, filters: [...state.filters, compiled] })
        : makeQuery(state)
    },
    order: (field, dir = 'asc') =>
      makeQuery({ ...state, order: { column: field, direction: dir } }),

    collect: operation(function* () {
      return (yield* coerceRows(
        yield* runList(state, sql.fragment``),
        tableOf(state.table).columns,
      )) as AnyType
    }),
    take: operation(function* (count: number) {
      return (yield* coerceRows(
        yield* runList(state, sql.fragment`LIMIT ${Math.trunc(count)}`),
        tableOf(state.table).columns,
      )) as AnyType
    }),
    first: operation(function* () {
      const rows = yield* runList(state, sql.fragment`LIMIT 1`)
      return (rows[0] ? yield* coerceRow(rows[0], tableOf(state.table).columns) : null) as AnyType
    }),
    unique: operation(function* () {
      const rows = yield* runList(state, sql.fragment`LIMIT 2`)
      if (rows.length > 1) {
        return yield* fail('db.validation', `query on "${state.table}" matched multiple rows`)
      }
      return (rows[0] ? yield* coerceRow(rows[0], tableOf(state.table).columns) : null) as AnyType
    }),
    count: operation(function* () {
      // SurrealQL has no `COUNT(*)`: it's the `count()` aggregate with `GROUP ALL`, which still yields
      // exactly one row (`{ count: 0 }`) on an empty table, so `oneFirst` stays valid for both paths.
      const value = yield* pool.oneFirst(
        isSurreal
          ? sql`SELECT count() AS "count" FROM ${ident(state.table)} ${whereClause(state)} GROUP ALL`
          : sql`SELECT COUNT(*) AS "count" FROM ${ident(state.table)} ${whereClause(state)}`,
      )
      return Number(value ?? 0)
    }),

    paginate: operation(function* (options: PaginateOptions) {
      const limit = Math.max(1, Math.trunc(options.limit))
      const column = state.order?.column ?? DEFAULT_ORDER
      const sortDir = state.order?.direction ?? 'asc'
      const travel = options.direction ?? 'forward'

      const decoded = options.cursor ? yield* decodeCursor(options.cursor) : null
      const cursor =
        decoded && decoded.column === column && decoded.direction === sortDir ? decoded : null

      const forwardOp = sortDir === 'asc' ? gt : lt
      const backwardOp = sortDir === 'asc' ? lt : gt
      const seek = travel === 'backward' ? backwardOp : forwardOp
      const queryDir: 'asc' | 'desc' =
        travel === 'backward' ? (sortDir === 'asc' ? 'desc' : 'asc') : sortDir

      const preds: Filter[] = [
        ...Object.entries(state.match).map(([col, value]) => eq(col, value)),
        ...state.filters,
      ]
      if (cursor) {
        const beyond = sql.fragment`(${seek(column, cursor.value as PrimitiveValueExpression)} OR (${eq(column, cursor.value as PrimitiveValueExpression)} AND ${seek(ID, cursor.id)}))`
        preds.push(beyond)
      }
      const where = preds.length === 0 ? sql.fragment`` : sql.fragment`WHERE ${and(...preds)}`
      const orderClause = sql.fragment`ORDER BY ${ident(column)} ${direction(queryDir)}, ${ident(ID)} ${direction(queryDir)}`

      const result = (yield* pool.any(
        sql`SELECT * FROM ${ident(state.table)} ${where} ${orderClause} LIMIT ${limit + 1}`,
      )) as Row[]

      const hasMore = result.length > limit
      const windowRows = hasMore ? result.slice(0, limit) : result
      const rows = (yield* coerceRows(
        travel === 'backward' ? [...windowRows].toReversed() : windowRows,
        tableOf(state.table).columns,
      )) as Row[]

      const first = rows[0]
      const last = rows.at(-1)
      const edge = operation(function* (row: Row) {
        return yield* encodeCursor({
          value: row[column],
          id: String(row[ID]),
          column,
          direction: sortDir,
        })
      })

      const hasNext = travel === 'backward' ? cursor !== null : hasMore
      const hasPrev = travel === 'backward' ? hasMore : cursor !== null

      return {
        data: rows,
        pageInfo: {
          nextCursor: hasNext && last ? yield* edge(last) : null,
          prevCursor: hasPrev && first ? yield* edge(first) : null,
          hasNext,
          hasPrev,
        },
        resourceVersion: versionOf(state.table),
      } as Page<AnyType>
    }),
  })

  const insertRow = operation(function* (name: string, value: AnyType) {
    const def = tableOf(name)
    const parsed = def.validator.safeParse(value)
    if (!parsed.success) {
      return yield* fail('db.validation', `invalid insert into "${name}"`)
    }
    const version = bump(name)
    const row: Row = {
      [ID]: yield* IO.actions.uuid(),
      [CREATED]: Date.now(),
      [VERSION]: version,
      ...(parsed.data as Record<string, PrimitiveValueExpression>),
    }
    const columns = Object.keys(row)
    const jsonColumns = jsonColumnsOf(name)
    const bound: FragmentSqlToken[] = []
    for (const column of columns) {
      const boundValue = yield* bindColumn(
        jsonColumns,
        column,
        row[column] as PrimitiveValueExpression,
      )
      bound.push(sql.fragment`${boundValue}`)
    }
    const inserted = yield* pool.one(
      sql`INSERT INTO ${ident(name)} (${commaList(columns.map(ident))}) VALUES (${commaList(
        bound,
      )}) ${returningAll}`,
    )
    const doc = (yield* coerceRow(inserted, def.columns))!
    yield* broadcast({
      table: name,
      id: String(doc[ID]),
      op: 'insert',
      row: doc,
      resourceVersion: String(version),
    })
    return doc as AnyType
  })

  const patchRow = operation(function* (name: string, id: string, value: AnyType) {
    const def = tableOf(name)
    const parsed = def.validator.partial().safeParse(value)
    if (!parsed.success) {
      return yield* fail('db.validation', `invalid patch of "${name}"`)
    }
    const data = parsed.data as Record<string, PrimitiveValueExpression>
    const version = bump(name)
    const jsonColumns = jsonColumnsOf(name)
    const assignments: FragmentSqlToken[] = []
    for (const [column, columnValue] of Object.entries(data)) {
      const boundValue = yield* bindColumn(jsonColumns, column, columnValue)
      assignments.push(sql.fragment`${ident(column)} = ${boundValue}`)
    }
    assignments.push(sql.fragment`${ident(VERSION)} = ${version}`)
    const updated = yield* pool.maybeOne(
      sql`UPDATE ${ident(name)} SET ${commaList(assignments)} WHERE ${ident(ID)} = ${id} ${returningAll}`,
    )
    if (!updated) {
      return null as AnyType
    }
    const doc = (yield* coerceRow(updated, def.columns))!
    yield* broadcast({ table: name, id, op: 'patch', row: doc, resourceVersion: String(version) })
    return doc as AnyType
  })

  const replaceRow = operation(function* (name: string, id: string, value: AnyType) {
    const def = tableOf(name)
    const parsed = def.validator.safeParse(value)
    if (!parsed.success) {
      return yield* fail('db.validation', `invalid replace of "${name}"`)
    }
    const data = parsed.data as Record<string, PrimitiveValueExpression>
    const version = bump(name)
    const jsonColumns = jsonColumnsOf(name)
    const assignments: FragmentSqlToken[] = []
    for (const [column, columnValue] of Object.entries(data)) {
      const boundValue = yield* bindColumn(jsonColumns, column, columnValue)
      assignments.push(sql.fragment`${ident(column)} = ${boundValue}`)
    }
    assignments.push(sql.fragment`${ident(VERSION)} = ${version}`)
    const updated = yield* pool.maybeOne(
      sql`UPDATE ${ident(name)} SET ${commaList(assignments)} WHERE ${ident(ID)} = ${id} ${returningAll}`,
    )
    if (!updated) {
      return null as AnyType
    }
    const doc = (yield* coerceRow(updated, def.columns))!
    yield* broadcast({ table: name, id, op: 'replace', row: doc, resourceVersion: String(version) })
    return doc as AnyType
  })

  const deleteRow = operation(function* (name: string, id: string) {
    // SurrealQL returns nothing from a DELETE unless asked; `RETURN BEFORE` yields the removed rows so
    // the `length > 0` check (did anything actually delete?) holds on both paths.
    const removed = yield* pool.any(
      isSurreal
        ? sql`DELETE FROM ${ident(name)} WHERE ${ident(ID)} = ${id} RETURN BEFORE`
        : sql`DELETE FROM ${ident(name)} WHERE ${ident(ID)} = ${id} RETURNING ${ident(ID)}`,
    )
    if (removed.length > 0) {
      const version = bump(name)
      yield* broadcast({ table: name, id, op: 'delete', resourceVersion: String(version) })
    }
    return removed.length > 0
  })

  const getRow = operation(function* (name: string, id: string) {
    const found = yield* pool.maybeOne(
      sql`SELECT * FROM ${ident(name)} WHERE ${ident(ID)} = ${id} LIMIT 1`,
    )
    return (found ? yield* coerceRow(found, tableOf(name).columns) : null) as AnyType
  })

  return {
    get: getRow,
    insert: insertRow,
    patch: patchRow,
    replace: replaceRow,
    delete: deleteRow,
    query: (name: string) =>
      makeQuery({ table: name, match: {}, filters: [], order: null }) as QueryHandle<AnyType>,
    resourceVersion: versionOf,
    changes,
  } as unknown as Database
}

/**
 * Drain a {@link ChangeBus} into a local `changes` signal — forwarding writes that originated on OTHER
 * nodes (own echoes, `origin === bus.origin`, are dropped) so a multi-node deployment's watchers react
 * to remote writes just as they do to local ones. Runs forever; spawn it as a background task (the
 * `RealtimeDb` plugin does this at install when a `bus` is configured).
 */
export const bridgeChangeBus = operation(function* (
  changes: Signal<ChangeEvent, never>,
  bus: ChangeBus,
) {
  const feed = yield* bus.events
  for (;;) {
    const step = yield* feed.next()
    if (step.done) {
      break
    }
    if (step.value.origin === bus.origin) {
      continue
    }
    changes.send(step.value)
  }
})
