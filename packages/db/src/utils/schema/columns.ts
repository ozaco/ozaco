// oxlint-disable oxc/no-rest-spread-properties

import type { ColumnDef, ColumnRef, ColumnType } from './types'
import { COLUMN } from './types'

const makeBuilder = <TJs>(base: ColumnDef<TJs>): ColumnBuilder<TJs> => ({
  ...base,
  notNull: () => makeBuilder({ ...base, isNullable: false }),
  optional: () => makeBuilder({ ...base, isNullable: true }) as ColumnBuilder<TJs | null>,
  primary: () => makeBuilder({ ...base, isPrimary: true, isNullable: false }),
  autoIncrement: () => makeBuilder({ ...base, isAutoIncrement: true, hasDefault: true }),
  unique: () => makeBuilder({ ...base, isUnique: true }),
  default: value => makeBuilder({ ...base, defaultValue: value, hasDefault: true }),
  defaultNow: () => makeBuilder({ ...base, isDefaultNow: true, hasDefault: true }),
  references: ref => makeBuilder({ ...base, foreignKey: ref }),
})

const makeColumn = <TJs>(
  type: ColumnType,
  overrides: Partial<ColumnDef<TJs>> = {},
): ColumnBuilder<TJs> =>
  makeBuilder<TJs>({
    _t: COLUMN,
    type,
    isNullable: false,
    isPrimary: false,
    isUnique: false,
    isAutoIncrement: false,
    hasDefault: false,
    isDefaultNow: false,
    defaultValue: undefined,
    foreignKey: null,
    length: null,
    __js: undefined as unknown as TJs,
    ...overrides,
  })

export const col = {
  int: () => makeColumn<number>('int'),
  bigint: () => makeColumn<bigint>('bigint'),
  text: () => makeColumn<string>('text'),
  varchar: (length: number) => makeColumn<string>('varchar', { length }),
  boolean: () => makeColumn<boolean>('boolean'),
  timestamp: () => makeColumn<Date>('timestamp'),
  json: <T = unknown>() => makeColumn<T>('json'),
  blob: () => makeColumn<Uint8Array>('blob'),
}

export interface ColumnBuilder<TJs> extends ColumnDef<TJs> {
  notNull(): ColumnBuilder<TJs>
  optional(): ColumnBuilder<TJs | null>
  primary(): ColumnBuilder<TJs>
  autoIncrement(): ColumnBuilder<TJs>
  unique(): ColumnBuilder<TJs>
  default(value: TJs): ColumnBuilder<TJs>
  defaultNow(): ColumnBuilder<TJs>
  references(ref: ColumnRef): ColumnBuilder<TJs>
}
