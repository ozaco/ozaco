import type { DriverQueryResult, Field, QueryResultRow } from 'db:core'
import { operation, until } from 'std:effect'
import type { Subscription } from 'std:effect'

import type { AnyType } from '@ozaco/std/shared'

/** Late `import()` hidden from the bundler (via the `Function` ctor) so a driver's OPTIONAL enhancer
 * package (`pg-query-stream`, `pg-copy-streams`, `@surrealdb/node`) stays optional — absent, the
 * driver degrades instead of failing to resolve. */
export const dynamicImport = (specifier: string): Promise<AnyType> =>
  // oxlint-disable-next-line no-new-func
  (Function('specifier', 'return import(specifier)') as (s: string) => Promise<AnyType>)(specifier)

/** Derive `fields` from the first row's keys (drivers whose result carries no column metadata) and
 * default the command to SELECT (writes should use `RETURNING`). */
export const mapResult = (
  rows: readonly QueryResultRow[],
  count: number | undefined,
): DriverQueryResult => {
  const first = rows[0]
  const fields: Field[] = first ? Object.keys(first).map(name => ({ name, dataTypeId: 0 })) : []
  return {
    command: 'SELECT',
    fields,
    notices: [],
    rowCount: count ?? rows.length,
    rows,
  }
}

/** Replay an already-materialized row array as a subscription — the buffering fallback for backends
 * without a server-side cursor. */
export const arraySubscription = (
  rows: readonly QueryResultRow[],
): Subscription<QueryResultRow, void> => {
  let index = 0
  return {
    next: operation(function* () {
      if (index < rows.length) {
        const value = rows[index]!
        index += 1
        return { value, done: false } as IteratorResult<QueryResultRow, void>
      }
      return { value: undefined, done: true } as IteratorResult<QueryResultRow, void>
    }),
  }
}

/** Pull rows one at a time from a (sync or async) iterator — REAL streaming, so a large result set is
 * never fully buffered. `bun:sqlite`'s `Statement.iterate()` and `pg-query-stream` both feed this. */
export const iteratorSubscription = (
  iterator: Iterator<QueryResultRow> | AsyncIterator<QueryResultRow>,
): Subscription<QueryResultRow, void> => ({
  next: operation(function* () {
    const step = iterator.next() as
      | IteratorResult<QueryResultRow, void>
      | Promise<IteratorResult<QueryResultRow, void>>
    return step instanceof Promise ? yield* until(step) : step
  }),
})
