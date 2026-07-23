import { z } from 'zod'

import { introspectColumns } from './introspect'
import type { SchemaDef, SystemFields, TableDef } from './types'
import { SCHEMA, TABLE } from './types'

/** Flatten a type into a single plain object so TS materializes (and displays) it eagerly instead of
 * keeping a lazy alias/intersection. */
type Simplify<T> = { [K in keyof T]: T[K] } & {}

/** The resolved stored-row + insert types for a zod shape, computed once at `table` so they
 * travel with the table as plain object types (no zod machinery in downstream hovers). */
type DocOf<TShape extends z.ZodRawShape> = Simplify<z.infer<z.ZodObject<TShape>> & SystemFields>
type InsertOf<TShape extends z.ZodRawShape> = Simplify<z.input<z.ZodObject<TShape>>>

const makeTable = <TName extends string, TDoc, TInsert>(
  def: TableDef<TName, TDoc, TInsert>,
): TableBuilder<TName, TDoc, TInsert> => ({
  ...def,
  index: (name, columns) =>
    makeTable<TName, TDoc, TInsert>({
      ...def,
      indexes: [...def.indexes, { name, columns: [...columns], unique: false }],
    }),
  unique: (name, columns) =>
    makeTable<TName, TDoc, TInsert>({
      ...def,
      indexes: [...def.indexes, { name, columns: [...columns], unique: true }],
    }),
})

/** A {@link TableDef} plus fluent index declaration. Index columns are checked against the row's own
 * field names (`keyof TDoc`). */
export interface TableBuilder<TName extends string, TDoc, TInsert> extends TableDef<
  TName,
  TDoc,
  TInsert
> {
  index(name: string, columns: (keyof TDoc & string)[]): TableBuilder<TName, TDoc, TInsert>
  unique(name: string, columns: (keyof TDoc & string)[]): TableBuilder<TName, TDoc, TInsert>
}

/** Declare a table from a zod object shape. System fields (`_id`, `_createdAt`) are implicit. The
 * returned type carries the resolved row/insert types, not the raw zod shape. */
export const table = <TName extends string, TShape extends z.ZodRawShape>(
  name: TName,
  shape: TShape,
): TableBuilder<TName, DocOf<TShape>, InsertOf<TShape>> =>
  makeTable<TName, DocOf<TShape>, InsertOf<TShape>>({
    _t: TABLE,
    name,
    validator: z.object(shape) as z.ZodObject<z.ZodRawShape>,
    columns: introspectColumns(shape),
    indexes: [],
  })

/** Assemble standalone tables into the internal {@link SchemaDef} the driver + `createDatabase`
 * consume — keyed by each table's `name`. Replaces the old central `defineSchema`: tables are now
 * declared piece by piece and only gathered into this array where they're used (driver install,
 * `useDatabase`). */
export const schemaFrom = (tables: readonly TableDef[]): SchemaDef => ({
  _t: SCHEMA,
  tables: Object.fromEntries(tables.map(entry => [entry.name, entry])),
})
