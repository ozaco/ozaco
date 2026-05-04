import type { AnyType } from 'std:shared'

import { sql } from 'drizzle-orm'
import { blob, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { ColumnDef, SchemaDef, TableDef } from '../../../utils/schema/types'
import type { DrizzleTableMap } from '../../internal/drizzle-base'

const toSqliteColumn = (name: string, column: ColumnDef): AnyType => {
  let builder: AnyType
  switch (column.type) {
    case 'int':
    case 'bigint': {
      builder = integer(name, { mode: 'number' })
      break
    }
    case 'boolean': {
      builder = integer(name, { mode: 'boolean' })
      break
    }
    case 'timestamp': {
      builder = integer(name, { mode: 'timestamp_ms' })
      break
    }
    case 'text':
    case 'varchar': {
      builder = text(name)
      break
    }
    case 'json': {
      builder = text(name, { mode: 'json' })
      break
    }
    case 'blob': {
      builder = blob(name, { mode: 'buffer' })
      break
    }
    default: {
      builder = text(name)
    }
  }

  if (column.isPrimary) {
    builder = builder.primaryKey(column.isAutoIncrement ? { autoIncrement: true } : undefined)
  }
  if (!column.isNullable && !column.isPrimary) {
    builder = builder.notNull()
  }
  if (column.isUnique && !column.isPrimary) {
    builder = builder.unique()
  }
  if (column.isDefaultNow && column.type === 'timestamp') {
    builder = builder.default(sql`(unixepoch() * 1000)`)
  } else if (column.hasDefault && column.defaultValue !== undefined) {
    builder = builder.default(column.defaultValue as AnyType)
  }
  return builder
}

const buildSqliteTables = (schema: SchemaDef): DrizzleTableMap => {
  const tables: DrizzleTableMap = {}
  for (const tableDef of Object.values(schema.tables)) {
    const columns: Record<string, AnyType> = {}
    for (const [columnName, column] of Object.entries((tableDef as TableDef).columns)) {
      columns[columnName] = toSqliteColumn(columnName, column)
    }
    tables[(tableDef as TableDef).name] = sqliteTable((tableDef as TableDef).name, columns)
  }
  return tables
}

export { buildSqliteTables }
