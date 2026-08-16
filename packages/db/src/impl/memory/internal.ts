import type { Doc, IndexSpec, OrderBy } from 'db:core'
import { compareValues } from 'db:core'
import { operation } from 'std:effect'

import { JsonCodec } from 'std:codec/impl/json'

export { matches } from 'db:core'

/** Sort a copy by the order spec — nulls last ascending, first descending (Postgres defaults). */
export const sortRows = (rows: readonly Doc[], order: readonly OrderBy[]): Doc[] => {
  if (order.length === 0) {
    return [...rows]
  }
  return rows.toSorted((left, right) => {
    for (const entry of order) {
      const a = left[entry.field]
      const b = right[entry.field]
      const aNull = a === null || a === undefined
      const bNull = b === null || b === undefined
      if (aNull || bNull) {
        if (aNull && bNull) {
          continue
        }
        const nullRank = aNull ? 1 : -1
        return entry.direction === 'desc' ? -nullRank : nullRank
      }
      const rank = compareValues(a, b) ?? 0
      if (rank !== 0) {
        return entry.direction === 'desc' ? -rank : rank
      }
    }
    return 0
  })
}

/** The values of a unique index for one row, as a comparable key — null when any part is null
 * (SQL unique indexes admit multiple nulls). */
export const uniqueKey = operation(function* (index: IndexSpec, doc: Doc) {
  const parts: unknown[] = []
  for (const columnName of index.columns) {
    const value =
      doc[columnName] instanceof Date ? (doc[columnName] as Date).getTime() : doc[columnName]
    if (value === null || value === undefined) {
      return null
    }
    parts.push(value)
  }
  return yield* JsonCodec.actions.stringify(parts)
})
