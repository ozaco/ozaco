import type { AnyType } from 'std:shared'

import { COLUMN } from '../const'
import type { Id } from '../types/common'
import type { ColumnDef, ColumnKind, ColumnMeta } from '../types/schema'

const make = <TValue>(kind: ColumnKind, meta: ColumnMeta): ColumnDef<TValue, AnyType, AnyType> => ({
  _t: COLUMN,
  kind,
  meta,
  optional: () => make<TValue>(kind, { ...meta, optional: true }),
  default: (value: TValue | (() => TValue)) =>
    make<TValue>(kind, {
      ...meta,
      hasDefault: true,
      defaultValue: (typeof value === 'function' ? value : () => value) as () => unknown,
    }),
})

const base = <TValue>(
  kind: ColumnKind,
  extra?: Partial<ColumnMeta>,
): ColumnDef<TValue, false, false> =>
  make<TValue>(kind, {
    optional: false,
    hasDefault: false,
    defaultValue: null,
    enumValues: null,
    reference: null,
    ...extra,
  })

/**
 * The column DSL — declares a table's storage shape explicitly (no validator introspection).
 * Chain `.optional()` for a nullable/omittable column and `.default(value | () => value)` for an
 * insert-time default. `json<T>()` types the stored JSON; `enumOf` constrains to a string union;
 * `id('table')` declares a reference and brands the value type.
 */
export const column = {
  text: () => base<string>('text'),
  int: () => base<number>('int'),
  float: () => base<number>('float'),
  boolean: () => base<boolean>('boolean'),
  timestamp: () => base<Date>('timestamp'),
  json: <TValue = unknown>() => base<TValue>('json'),
  enumOf: <const TValues extends readonly [string, ...string[]]>(...values: TValues) =>
    base<TValues[number]>('enum', { enumValues: values }),
  id: <TTable extends string>(table: TTable) => base<Id<TTable>>('text', { reference: table }),
}
