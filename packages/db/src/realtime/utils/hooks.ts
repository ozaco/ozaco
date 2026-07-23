import { useContext } from 'std:effect'
import type { Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import { DB } from '../definition'
import type { SchemaFrom, TableDef } from '../schema/types'
import type { Database } from '../types/database'

type Simplify<T> = { [K in keyof T]: T[K] } & {}

/**
 * Resolve the installed realtime database as a typed {@link Database}. Pass the table(s) this scope
 * touches to type the handle to exactly those rows (`useDatabase([tasks])`); the no-arg form falls
 * back to the loose schema. The argument is a type witness only — the runtime handle is the installed
 * database.
 */
interface UseDatabase {
  <const TTables extends readonly TableDef[]>(
    tables: TTables,
  ): Operation<Database<Simplify<SchemaFrom<TTables>>>>
  <TTable extends TableDef>(
    table: TTable,
  ): Operation<Database<Simplify<SchemaFrom<readonly [TTable]>>>>
  (): Operation<Database>
}

export const useDatabase: UseDatabase = ((_spec?: unknown) => useContext(DB.context)) as AnyType
