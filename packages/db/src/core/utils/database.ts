import type { Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import { DbClient } from '../definition/database'
import { BusMeta } from '../internal/context'
import type { Database } from '../types/database'
import type { Schema } from '../types/schema'

/**
 * Resolve the installed {@link Database.Handle}, typed by the schema you pass:
 * `const db = yield* useDb(schema)` (from `defineSchema({ users, posts })` — the ONE place the
 * tables are listed). The argument is TYPE-ONLY — it drives inference and is never read at
 * runtime: the handle is the install's, and a table the install does not declare still fails
 * `db.validation` at its terminals. `useDb()` with no argument answers the untyped handle.
 */
export function useDb(): Operation<Database.Handle>
export function useDb<TDef extends Schema.Def>(
  schema: TDef,
): Operation<Database.Handle<Schema.Of<TDef>>>

export function useDb(_schema?: unknown): Operation<Database.Handle> {
  return DbClient.context.expect() as AnyType
}

/** Run `body` with correlation data attached to every bus envelope its writes ship
 * (`Bus.Envelope.meta`) — e.g. `withBusMeta({ requestId }, () => db.insert(...))`. Nested calls
 * replace the data for their extent. */
export const withBusMeta = <T>(
  meta: Readonly<Record<string, unknown>>,
  body: () => Operation<T>,
): Operation<T> => BusMeta.with(meta, body)
