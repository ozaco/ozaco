import type { MetricsStoreDef } from 'server:core'
import { attempt, until } from 'std:effect'
import type { Operation } from 'std:effect'
import { Fetch } from 'std:fetch'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'

import { COLUMN_TYPES, MAX_REDIRECTS } from './const'
import { StarRocksErrors } from './errors'
import type { StarRocks } from './types'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** Backtick-quote an identifier, refusing anything that could escape the quoting. */
export function* ident(name: string): Operation<string> {
  if (!IDENT.test(name)) {
    return yield* fail(
      StarRocksErrors.Configuration,
      `unsafe identifier "${name}" — only [A-Za-z0-9_] names are allowed`,
    )
  }

  return `\`${name}\``
}

/** A per-load unique Stream Load label (retrying a label replays the same transaction). */
export const labelFor = (prefix: string, table: string): string =>
  `${prefix}-${table}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/** Swap the redirect target's host:port for the configured `beUrl` (NAT/docker setups). */
export const rewriteRedirect = (beUrl: string | undefined, location: string): string => {
  if (!beUrl) {
    return location
  }

  try {
    const url = new URL(location)

    return `${beUrl.replace(/\/+$/u, '')}${url.pathname}${url.search}`
  } catch {
    return location
  }
}

/**
 * Run one statement over the MySQL protocol. Uses `pool.query` (text protocol, client-side
 * escaping) instead of `execute` — StarRocks' binary prepared-statement support is partial.
 */
export function* runSql(
  ctx: StarRocks.Context,
  statement: string,
  params?: readonly unknown[],
): Operation<readonly MetricsStoreDef.Row[]> {
  const outcome = yield* attempt(() =>
    until(ctx.pool.query(statement, params === undefined ? undefined : [...params])),
  )

  if (isFailure(outcome)) {
    return yield* fail(
      StarRocksErrors.Query,
      `starrocks statement failed: ${String(outcome.error)}`,
      `sql: ${statement}`,
      ...outcome.causes,
    )
  }

  const [rows] = outcome.value as [AnyType]

  return (Array.isArray(rows) ? rows : []) as readonly MetricsStoreDef.Row[]
}

/** Compile the structured, store-portable query spec into one parametrized SELECT. */
export function* compileSelect(
  database: string,
  spec: MetricsStoreDef.QuerySpec,
): Operation<{ readonly sql: string; readonly params: readonly unknown[] }> {
  const table = `${yield* ident(database)}.${yield* ident(spec.table)}`
  const clauses: string[] = []
  const params: unknown[] = []

  if (spec.where) {
    for (const [key, value] of Object.entries(spec.where)) {
      clauses.push(`${yield* ident(key)} = ?`)
      params.push(value)
    }
  }

  if (spec.sinceMs !== undefined) {
    clauses.push('`ts` >= ?')
    params.push(spec.sinceMs)
  }

  if (spec.untilMs !== undefined) {
    clauses.push('`ts` <= ?')
    params.push(spec.untilMs)
  }

  let sql = `SELECT * FROM ${table}`

  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(' AND ')}`
  }

  if (spec.orderBy !== undefined) {
    sql += ` ORDER BY ${yield* ident(spec.orderBy)} ${spec.direction === 'desc' ? 'DESC' : 'ASC'}`
  }

  if (spec.limit !== undefined) {
    sql += ` LIMIT ${Math.max(0, Math.floor(spec.limit))}`
  }

  return { sql, params }
}

/**
 * `CREATE TABLE IF NOT EXISTS` for a define spec: `ts` is mandatory (it is the DUPLICATE KEY, the
 * distribution hash and the prune axis), every other column is nullable.
 */
export function* defineTableSql(
  database: string,
  spec: MetricsStoreDef.DefineSpec,
): Operation<string> {
  const ts = spec.columns.find(column => column.name === 'ts')

  if (!ts) {
    return yield* fail(
      StarRocksErrors.Configuration,
      `metrics table "${spec.table}" needs a "ts" column — it is the sort key and the prune axis`,
    )
  }

  const table = `${yield* ident(database)}.${yield* ident(spec.table)}`
  const lines: string[] = [`${yield* ident('ts')} ${COLUMN_TYPES[ts.kind]} NOT NULL`]

  for (const column of spec.columns) {
    if (column.name === 'ts') {
      continue
    }

    lines.push(`${yield* ident(column.name)} ${COLUMN_TYPES[column.kind]} NULL`)
  }

  return (
    `CREATE TABLE IF NOT EXISTS ${table} (${lines.join(', ')}) ` +
    'ENGINE = OLAP DUPLICATE KEY(`ts`) DISTRIBUTED BY HASH(`ts`) BUCKETS 1 ' +
    "PROPERTIES ('replication_num' = '1')"
  )
}

/**
 * Stream Load one JSON batch: PUT to the FE, follow the FE→BE 307 redirect MANUALLY (the platform
 * fetch drops `Authorization` on cross-origin redirects, so the same headers — label included —
 * are re-sent to the `Location` target), then check the load result's `Status`.
 */
export function* streamLoad(
  ctx: StarRocks.Context,
  table: string,
  rows: readonly MetricsStoreDef.Row[],
): Operation<void> {
  const body = yield* JsonCodec.actions.stringify([...rows])
  const label = labelFor(ctx.labelPrefix, table)
  const headers: Record<string, string> = {
    Authorization: `Basic ${ctx.credentials}`,
    Expect: '100-continue',
    label,
    format: 'json',
    strip_outer_array: 'true',
  }

  let url = `${ctx.feUrl}/api/${ctx.database}/${table}/_stream_load`

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // per-iteration const so the closure never captures the mutated loop variable
    const target = url
    const response = yield* attempt(() =>
      Fetch.actions.request(target, { method: 'PUT', headers, body, redirect: 'manual' }),
    )

    if (isFailure(response)) {
      return yield* fail(
        StarRocksErrors.Ingest,
        `stream load PUT to "${target}" failed: ${String(response.error)}`,
        `ingest: table:${table} label:${label}`,
        ...response.causes,
      )
    }

    const res = response.value

    if (res.status === 307 || res.status === 308) {
      const location = res.headers.get('location')

      if (!location) {
        return yield* fail(
          StarRocksErrors.Ingest,
          `stream load redirect from "${target}" carried no Location header`,
          `ingest: table:${table} label:${label}`,
        )
      }

      url = rewriteRedirect(ctx.beUrl, location)

      continue
    }

    const payload = yield* attempt(() => res.json<StarRocks.StreamLoadResponse>())

    if (isFailure(payload)) {
      return yield* fail(
        StarRocksErrors.Ingest,
        `stream load to "${table}" answered ${res.status} with an unparseable body`,
        `ingest: table:${table} label:${label}`,
        ...payload.causes,
      )
    }

    const status = payload.value.Status

    // 'Publish Timeout' means the txn committed but visibility lagged — the data WILL land
    if (status === 'Success' || status === 'Publish Timeout') {
      yield* ctx.log.debug('stream load ok', { table, rows: rows.length, label, status })

      return
    }

    return yield* fail(
      StarRocksErrors.Ingest,
      `stream load to "${table}" failed: ${status ?? `http ${res.status}`} — ${payload.value.Message ?? 'no message'}`,
      `ingest: table:${table} label:${label}`,
    )
  }

  return yield* fail(
    StarRocksErrors.Ingest,
    `stream load to "${table}" exceeded ${MAX_REDIRECTS} redirects`,
    `ingest: table:${table} label:${label}`,
  )
}
