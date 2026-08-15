// oxlint-disable import/exports-last
import { CREATED, ID, SCHEMA, TABLE, UPDATED, VERSION } from '../const'
import type {
  ColumnShape,
  ColumnSpec,
  DocFor,
  InsertFor,
  SchemaDef,
  StandardSchemaV1,
  TableDef,
  TableSpec,
} from '../types/schema'

/** A {@link TableDef} plus fluent index declaration. Index columns are checked against the row's own
 * field names. */
export interface TableBuilder<TName extends string, TDoc, TInsert> extends TableDef<
  TName,
  TDoc,
  TInsert
> {
  index(name: string, columns: (keyof TDoc & string)[]): TableBuilder<TName, TDoc, TInsert>
  unique(name: string, columns: (keyof TDoc & string)[]): TableBuilder<TName, TDoc, TInsert>
}

export interface TableOptions {
  /** Table-level insert/replace validator — any Standard Schema v1 library (zod v4, valibot, …).
   * Runs on the user value (defaults applied, system fields excluded). Not applied to `patch`. */
  readonly validate?: StandardSchemaV1 | undefined
}

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

/** Declare a table from a column shape. System fields (`_id`/`_createdAt`/`_version`) are implicit.
 * The returned type carries the resolved row/insert types, not the DSL shape. */
export const table = <TName extends string, TShape extends ColumnShape>(
  name: TName,
  shape: TShape,
  options?: TableOptions,
): TableBuilder<TName, DocFor<TShape>, InsertFor<TShape>> =>
  makeTable<TName, DocFor<TShape>, InsertFor<TShape>>({
    _t: TABLE,
    name,
    columns: Object.entries(shape).map(
      ([columnName, def]): ColumnSpec => ({
        name: columnName,
        kind: def.kind,
        optional: def.meta.optional,
        hasDefault: def.meta.hasDefault,
        enumValues: def.meta.enumValues,
        reference: def.meta.reference,
        system: false,
        primary: false,
      }),
    ),
    indexes: [],
    defaults: Object.fromEntries(
      Object.entries(shape)
        .filter(([, def]) => def.meta.defaultValue !== null)
        .map(([columnName, def]) => [columnName, def.meta.defaultValue!]),
    ),
    validate: options?.validate ?? null,
  })

/** Assemble standalone tables into the runtime {@link SchemaDef} the `DbClient` install consumes. */
export const schemaFrom = (tables: readonly TableDef[]): SchemaDef => ({
  _t: SCHEMA,
  tables: Object.fromEntries(tables.map(entry => [entry.name, entry])),
})

/** The implicit system columns, in stamp order. */
export const systemColumns = (): readonly ColumnSpec[] => [
  {
    name: ID,
    kind: 'text',
    optional: false,
    hasDefault: false,
    enumValues: null,
    reference: null,
    system: true,
    primary: true,
  },
  {
    name: CREATED,
    kind: 'int',
    optional: false,
    hasDefault: false,
    enumValues: null,
    reference: null,
    system: true,
    primary: false,
  },
  {
    name: UPDATED,
    kind: 'int',
    optional: false,
    hasDefault: false,
    enumValues: null,
    reference: null,
    system: true,
    primary: false,
  },
  {
    name: VERSION,
    kind: 'int',
    optional: false,
    hasDefault: false,
    enumValues: null,
    reference: null,
    system: true,
    primary: false,
  },
]

/** Build the adapter-facing {@link TableSpec} (system columns included) from a declared table. */
export const tableSpecOf = (def: TableDef): TableSpec => ({
  name: def.name,
  columns: [...systemColumns(), ...def.columns],
  indexes: def.indexes,
})
