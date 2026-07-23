// oxlint-disable import/exports-last
import type { PrimitiveValueExpression } from 'db:core'
import type { AnyType } from 'std:shared'

import type { Column, ColumnKind } from '../schema/types'

import type { Filter } from './expr'
import { and, eq, gt, gte, ilike, inList, like, lt, lte, ne, not, notInList, or } from './expr'

/** A comparable scalar accepted in a filter. */
export type FilterValue = string | number | boolean | null

/** MongoDB-style per-field operators. Bare `{ field: value }` is shorthand for `$eq`. */
export interface FieldOps {
  readonly $eq?: FilterValue
  readonly $ne?: FilterValue
  readonly $gt?: FilterValue
  readonly $gte?: FilterValue
  readonly $lt?: FilterValue
  readonly $lte?: FilterValue
  readonly $in?: readonly FilterValue[]
  readonly $nin?: readonly FilterValue[]
  /** raw `LIKE` pattern (case-sensitive; caller supplies `%`/`_`). */
  readonly $like?: string
  /** case-insensitive substring / prefix / suffix match. */
  readonly $contains?: string
  readonly $startsWith?: string
  readonly $endsWith?: string
  /** `true` → `IS NOT NULL`, `false` → `IS NULL`. */
  readonly $exists?: boolean
}

/** One field's condition: a bare value (→ `$eq`) or an operator object. */
export type FieldFilter = FilterValue | FieldOps

/**
 * A MongoDB-style filter over a document `TDoc`: any field mapped to a {@link FieldFilter}, combined
 * implicitly with AND, plus the logical `$and` / `$or` / `$not` combinators. Compiles to a SQL
 * predicate via {@link compileFilter}; every field is checked against the table's columns (+ the
 * `_id` / `_createdAt` / `_version` system fields) so only real columns reach SQL.
 */
export type MongoFilter<TDoc = Record<string, unknown>> = {
  readonly [K in keyof TDoc]?: FieldFilter
} & {
  readonly $and?: readonly MongoFilter<TDoc>[]
  readonly $or?: readonly MongoFilter<TDoc>[]
  readonly $not?: MongoFilter<TDoc>
}

const SYSTEM_KINDS: Record<string, ColumnKind> = {
  _id: 'text',
  _createdAt: 'timestamp',
  _version: 'int',
}

/** Coerce a JSON scalar to the column's stored representation — query-string values arrive as strings,
 * so numeric/boolean columns need converting to match how writes bind them. */
const coerce = (kind: ColumnKind | undefined, value: FilterValue): PrimitiveValueExpression => {
  if (value === null || value === undefined) {
    return null
  }
  if (kind === 'int' || kind === 'float' || kind === 'timestamp') {
    return typeof value === 'number' ? value : Number(value)
  }
  if (kind === 'boolean') {
    return value === true || value === 'true'
  }
  return value as PrimitiveValueExpression
}

const OPERATOR_KEYS = new Set([
  '$eq',
  '$ne',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$in',
  '$nin',
  '$like',
  '$contains',
  '$startsWith',
  '$endsWith',
  '$exists',
])

const isOps = (value: unknown): value is FieldOps =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).some(key => OPERATOR_KEYS.has(key))

/** Compile one field's condition (bare value or operator object) into predicates. */
const compileField = (
  column: string,
  kind: ColumnKind | undefined,
  cond: FieldFilter,
): Filter[] => {
  if (!isOps(cond)) {
    return [eq(column, coerce(kind, cond as FilterValue))]
  }
  const out: Filter[] = []
  if ('$eq' in cond) {
    out.push(eq(column, coerce(kind, cond.$eq!)))
  }
  if ('$ne' in cond) {
    out.push(ne(column, coerce(kind, cond.$ne!)))
  }
  if ('$gt' in cond) {
    out.push(gt(column, coerce(kind, cond.$gt!)))
  }
  if ('$gte' in cond) {
    out.push(gte(column, coerce(kind, cond.$gte!)))
  }
  if ('$lt' in cond) {
    out.push(lt(column, coerce(kind, cond.$lt!)))
  }
  if ('$lte' in cond) {
    out.push(lte(column, coerce(kind, cond.$lte!)))
  }
  if ('$in' in cond) {
    out.push(
      inList(
        column,
        (cond.$in ?? []).map(value => coerce(kind, value)),
      ),
    )
  }
  if ('$nin' in cond) {
    out.push(
      notInList(
        column,
        (cond.$nin ?? []).map(value => coerce(kind, value)),
      ),
    )
  }
  if ('$like' in cond) {
    out.push(like(column, String(cond.$like)))
  }
  if ('$contains' in cond) {
    out.push(ilike(column, `%${String(cond.$contains)}%`))
  }
  if ('$startsWith' in cond) {
    out.push(ilike(column, `${String(cond.$startsWith)}%`))
  }
  if ('$endsWith' in cond) {
    out.push(ilike(column, `%${String(cond.$endsWith)}`))
  }
  if ('$exists' in cond) {
    out.push(cond.$exists ? ne(column, null) : eq(column, null))
  }
  return out
}

/**
 * Compile a {@link MongoFilter} into a single SQL {@link Filter} against a table's columns. Unknown
 * fields are ignored (the wizard's `filter(table)` zod schema rejects them at the request boundary;
 * this keeps direct/programmatic use safe). Returns `null` for an empty filter (no predicate).
 */
export const compileFilter = (filter: MongoFilter, columns: readonly Column[]): Filter | null => {
  const kinds = new Map<string, ColumnKind>(columns.map(column => [column.name, column.kind]))
  for (const [name, kind] of Object.entries(SYSTEM_KINDS)) {
    kinds.set(name, kind)
  }

  const compileNode = (node: MongoFilter): Filter | null => {
    const preds: Filter[] = []
    for (const [key, raw] of Object.entries(node)) {
      if (raw === undefined) {
        continue
      }
      if (key === '$and') {
        const parts = (raw as MongoFilter[]).map(compileNode).filter(Boolean) as Filter[]
        if (parts.length > 0) {
          preds.push(and(...parts))
        }
        continue
      }
      if (key === '$or') {
        const parts = (raw as MongoFilter[]).map(compileNode).filter(Boolean) as Filter[]
        if (parts.length > 0) {
          preds.push(or(...parts))
        }
        continue
      }
      if (key === '$not') {
        const inner = compileNode(raw as MongoFilter)
        if (inner) {
          preds.push(not(inner))
        }
        continue
      }
      if (!kinds.has(key)) {
        continue
      }
      preds.push(...compileField(key, kinds.get(key), raw as FieldFilter))
    }
    if (preds.length === 0) {
      return null
    }
    return preds.length === 1 ? (preds[0] as Filter) : and(...preds)
  }

  return compileNode(filter as AnyType)
}
