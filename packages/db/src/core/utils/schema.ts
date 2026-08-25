// oxlint-disable import/exports-last
import type { AnyType } from 'std:shared'

import { COLUMN, FIELDS, TABLE } from '../const'
import type { Schema } from '../types/schema'
import type { Spec } from '../types/spec'

const makeColumn = <TValue>(
  kind: Spec.ColumnKind,
  meta: Schema.ColumnMeta,
): Schema.Column<TValue, AnyType, AnyType> => ({
  _t: COLUMN,
  kind,
  meta,
  optional: () => makeColumn<TValue>(kind, { ...meta, optional: true }),
  default: (value: TValue | (() => TValue)) =>
    makeColumn<TValue>(kind, {
      ...meta,
      hasDefault: true,
      defaultValue: (typeof value === 'function' ? value : () => value) as () => unknown,
    }),
})

const declare = <TValue>(
  kind: Spec.ColumnKind,
  extra?: Partial<Schema.ColumnMeta>,
): Schema.Column<TValue, false, false> =>
  makeColumn<TValue>(kind, {
    optional: false,
    hasDefault: false,
    defaultValue: null,
    enumValues: null,
    ...extra,
  })

/**
 * The column DSL — declares a table's storage shape explicitly (no validator introspection).
 * Chain `.optional()` for a nullable/omittable column and `.default(value | () => value)` for an
 * insert-time default. `json<T>()` types the stored JSON; `enumOf` constrains to a string union;
 * `id('table')` brands the value type with the table it names — type-level only: the db layer
 * keeps no relations (no foreign keys, no loaders); the id is stored as plain text.
 */
export const column = {
  text: () => declare<string>('text'),
  int: () => declare<number>('int'),
  float: () => declare<number>('float'),
  boolean: () => declare<boolean>('boolean'),
  timestamp: () => declare<Date>('timestamp'),
  json: <TValue = unknown>() => declare<TValue>('json'),
  enumOf: <const TValues extends readonly [string, ...string[]]>(...values: TValues) =>
    declare<TValues[number]>('enum', { enumValues: values }),
  id: <TTable extends string>(_table: TTable) => declare<Schema.Id<TTable>>('text'),
}

const columnSpecOf = (name: string, def: Schema.Column): Spec.Column => ({
  name,
  kind: def.kind,
  optional: def.meta.optional,
  hasDefault: def.meta.hasDefault,
  enumValues: def.meta.enumValues,
  system: false,
  primary: false,
})

const builderOf = <TName extends string, TDoc, TInsert>(
  def: Schema.Table<TName, TDoc, TInsert>,
): Schema.Builder<TName, TDoc, TInsert> => {
  const withIndex = (index: Spec.Index) =>
    builderOf<TName, TDoc, TInsert>({ ...def, indexes: [...def.indexes, index] })

  return {
    ...def,
    index: (name, columns) => withIndex({ name, columns: [...columns], unique: false }),
    unique: (name, columns) => withIndex({ name, columns: [...columns], unique: true }),
  }
}

/** Declare a table from a column shape. System fields (`_id`/`_created_at`/`_updated_at`/
 * `_version`) are implicit. The returned type carries the resolved row/insert types, not the DSL
 * shape. */
export const table = <TName extends string, TShape extends Schema.Shape>(
  name: TName,
  shape: TShape,
  options?: Schema.TableOptions,
): Schema.Builder<TName, Schema.DocFor<TShape>, Schema.InsertFor<TShape>> => {
  const entries = Object.entries(shape)

  return builderOf<TName, Schema.DocFor<TShape>, Schema.InsertFor<TShape>>({
    _t: TABLE,
    name,
    columns: entries.map(([columnName, def]) => columnSpecOf(columnName, def)),
    indexes: [],
    defaults: Object.fromEntries(
      entries
        .filter(([, def]) => def.meta.defaultValue !== null)
        .map(([columnName, def]) => [columnName, def.meta.defaultValue!]),
    ),
    validate: options?.validate ?? null,
    log: options?.log ?? true,
  })
}

const systemColumn = (name: string, kind: Spec.ColumnKind, primary: boolean): Spec.Column => ({
  name,
  kind,
  optional: false,
  hasDefault: false,
  enumValues: null,
  system: true,
  primary,
})

/** The implicit system columns, in stamp order. */
const systemColumns = (): readonly Spec.Column[] => [
  systemColumn(FIELDS.id, 'text', true),
  systemColumn(FIELDS.created, 'int', false),
  systemColumn(FIELDS.updated, 'int', false),
  systemColumn(FIELDS.version, 'text', false),
]

/** Build the adapter-facing {@link Spec.Table} (system columns included) from a declared table. */
export const tableSpecOf = (def: Schema.Table): Spec.Table => ({
  name: def.name,
  columns: [...systemColumns(), ...def.columns],
  indexes: def.indexes,
})
