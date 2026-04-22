export const COLUMN = Symbol.for('@ozaco/db.column')
export const TABLE = Symbol.for('@ozaco/db.table')
export const SCHEMA = Symbol.for('@ozaco/db.schema')

export type ColumnType =
  | 'int'
  | 'bigint'
  | 'text'
  | 'varchar'
  | 'boolean'
  | 'timestamp'
  | 'json'
  | 'blob'

export interface ColumnRef {
  readonly table: string
  readonly column: string
}

export interface ColumnDef<TJs = unknown> {
  readonly _t: typeof COLUMN
  readonly type: ColumnType
  readonly isNullable: boolean
  readonly isPrimary: boolean
  readonly isUnique: boolean
  readonly isAutoIncrement: boolean
  readonly hasDefault: boolean
  readonly isDefaultNow: boolean
  readonly defaultValue: unknown
  readonly foreignKey: ColumnRef | null
  readonly length: number | null
  readonly __js: TJs
}

export type ColumnMap = Record<string, ColumnDef>

export interface TableDef<TName extends string = string, TColumns extends ColumnMap = ColumnMap> {
  readonly _t: typeof TABLE
  readonly name: TName
  readonly columns: TColumns
}

export type TableMap = Record<string, TableDef>

export interface SchemaDef<TTables extends TableMap = TableMap> {
  readonly _t: typeof SCHEMA
  readonly tables: TTables
}
