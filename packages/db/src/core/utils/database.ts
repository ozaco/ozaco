import type { Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import { DbClient } from '../definition/database'
import { BusMeta } from '../internal/context'
import type { Database } from '../types/database'
import type { Schema } from '../types/schema'

/**
 * Resolve the installed {@link Database.Handle}, typed by the tables you pass:
 * `const db = yield* useDb(users, posts)`. The tables are a TYPE-ONLY argument — they drive the
 * `Schema.From<TTables>` inference and are never read at runtime (the handle is the install's;
 * passing a table the install does not declare only changes the static type, and its terminals
 * still fail `db.validation`). Hence the `_` prefix: the parameter exists for inference alone.
 */
export const useDb = <TTables extends readonly Schema.Table[]>(
  ..._tables: TTables
): Operation<Database.Handle<Schema.From<TTables>>> => DbClient.context.expect() as AnyType

/** Run `body` with correlation data attached to every bus envelope its writes ship
 * (`Bus.Envelope.meta`) — e.g. `withBusMeta({ requestId }, () => db.insert(...))`. Nested calls
 * replace the data for their extent. */
export const withBusMeta = <T>(
  meta: Readonly<Record<string, unknown>>,
  body: () => Operation<T>,
): Operation<T> => BusMeta.with(meta, body)
