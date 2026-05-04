import type { ColumnMap, SchemaDef, TableDef, TableMap } from './types'
import { SCHEMA, TABLE } from './types'

export const defineTable = <TName extends string, TColumns extends ColumnMap>(
  name: TName,
  columns: TColumns,
): TableDef<TName, TColumns> => ({
  _t: TABLE,
  name,
  columns,
})

export const defineSchema = <TTables extends TableMap>(tables: TTables): SchemaDef<TTables> => ({
  _t: SCHEMA,
  tables,
})
