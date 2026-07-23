import type { z } from 'zod'

declare const ID_BRAND: unique symbol
declare const DOC: unique symbol
declare const INSERT: unique symbol

export const TABLE = Symbol.for('db:table')
export const SCHEMA = Symbol.for('db:schema')

/** An opaque record id branded by the table it points at. The runtime value is a plain string. */
export type Id<TTable extends string> = string & { readonly [ID_BRAND]: TTable }

/** The storage-level shape of a column, derived from its zod type. */
export type ColumnKind = 'text' | 'int' | 'float' | 'boolean' | 'timestamp' | 'json' | 'enum'

export interface Column {
  readonly name: string
  readonly kind: ColumnKind
  readonly optional: boolean
  readonly hasDefault: boolean
  readonly enumValues: readonly string[] | null
  /** the referenced table when the column was declared via `id('table')`, otherwise null. */
  readonly reference: string | null
}

export interface Index {
  readonly name: string
  readonly columns: readonly string[]
  readonly unique: boolean
}

export interface TableDef<TName extends string = string, TDoc = unknown, TInsert = unknown> {
  readonly _t: typeof TABLE
  readonly name: TName
  /** the zod object used to validate writes. Typed loosely on purpose: the resolved row / insert
   * types (not the raw zod shape) are what surface in `Database` / `useDatabase` hovers. */
  readonly validator: z.ZodObject<z.ZodRawShape>
  /** the storage columns derived from `validator` (system fields excluded). */
  readonly columns: readonly Column[]
  readonly indexes: readonly Index[]
  /** phantom carriers for the resolved row + insert types — never present at runtime, they exist so
   * the plain object types travel with the table (and `Infer`/`InferInsert` can read them back)
   * without dragging the zod machinery into every hover. */
  readonly [DOC]?: TDoc
  readonly [INSERT]?: TInsert
}

export type TableMap = Record<string, TableDef>

export interface SchemaDef<TTables extends TableMap = TableMap> {
  readonly _t: typeof SCHEMA
  readonly tables: TTables
}

/** Per-table resolved types the {@link Database} is keyed by: the stored row + the accepted insert. */
export interface TableTypes<TDoc = unknown, TInsert = unknown> {
  readonly doc: TDoc
  readonly insert: TInsert
}

/** A type-only schema: table name → its resolved `{ doc, insert }`. Decoupled from the runtime
 * {@link SchemaDef} so `Database`/`useDatabase` hovers show plain rows — no `SchemaDef`, `TableDef`,
 * `TableBuilder`, or zod. */
export type Schema = Record<string, TableTypes>

/** Build a {@link Schema} from a tuple of standalone tables — keyed by each table's `name`, each value
 * its resolved `{ doc, insert }`. The type companion to runtime `schemaFrom`; powers
 * `useDatabase([...])` typing. Extraction is inlined (no wrapper names) so the hover stays flat. */
export type SchemaFrom<TTables extends readonly TableDef[]> = {
  readonly [Table in TTables[number] as Table['name']]: Table extends TableDef<
    string,
    infer TDoc,
    infer TInsert
  >
    ? { readonly doc: TDoc; readonly insert: TInsert }
    : never
}

/** The fields the engine adds to every stored document, regardless of dialect. */
export interface SystemFields {
  readonly _id: string
  readonly _createdAt: number
}
