import type { AnyType } from 'std:shared'

import { COLUMN, FIELDS } from '../const'
import type { Schema } from '../types/schema'
import type { Spec } from '../types/spec'
import type { Utils } from '../types/utils'

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

const systemColumn = (name: string, kind: Spec.ColumnKind, primary: boolean): Spec.Column => ({
  name,
  kind,
  optional: false,
  hasDefault: false,
  enumValues: null,
  system: true,
  primary,
})

/** A fresh `column.*` declaration of `kind` (required, no default, no enum unless `extra`). */
export const declare = <TValue>(
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

/** `timestamp()` reads back a `Date`; `timestamp({ as: 'ms' })` keeps epoch millis as a plain
 * `number` in and out (like the system `_created_at`/`_updated_at`). Both are stored the same
 * way — an integer of epoch millis — so switching between them needs no migration. */
export const timestamp = (options?: Utils.TimestampOptions) =>
  options?.as === 'ms' ? declare<number>('int') : declare<Date>('timestamp')

/** A declared column as the adapter sees it. */
export const columnSpecOf = (name: string, def: Schema.Column): Spec.Column => ({
  name,
  kind: def.kind,
  optional: def.meta.optional,
  hasDefault: def.meta.hasDefault,
  enumValues: def.meta.enumValues,
  system: false,
  primary: false,
})

/** A table declaration with its chainable `index` / `unique`. */
export const builderOf = <TName extends string, TDoc, TInsert>(
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

/** The implicit system columns, in stamp order. */
export const systemColumns = (): readonly Spec.Column[] => [
  systemColumn(FIELDS.id, 'text', true),
  systemColumn(FIELDS.created, 'int', false),
  systemColumn(FIELDS.updated, 'int', false),
  systemColumn(FIELDS.version, 'text', false),
]
