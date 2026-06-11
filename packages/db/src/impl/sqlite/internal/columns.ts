import type { AnyType } from 'std:shared'

import { sql } from 'drizzle-orm'
import { blob, customType, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { ColumnDef, SchemaDef, TableDef } from '../../../utils/schema/types'
import type { DrizzleTableMap } from '../../internal/drizzle-base'

// The sqlite connection runs with safeIntegers on (see host.ts), so the driver hands every INTEGER
// back as a BigInt — int64 values round-trip losslessly. These custom types normalize the driver
// value to each column's JS contract; drizzle's own integer modes would either pass the BigInt
// through (`number` mode) or throw on it (`timestamp_ms` mode).
const sqliteInt = customType<{ data: number; driverData: number | bigint }>({
  dataType: () => 'integer',
  fromDriver: Number,
  toDriver: value => value,
})

const sqliteBigint = customType<{ data: bigint; driverData: number | bigint }>({
  dataType: () => 'integer',
  fromDriver: value => (typeof value === 'bigint' ? value : BigInt(value)),
  toDriver: value => value,
})

const sqliteTimestamp = customType<{ data: Date; driverData: number | bigint }>({
  dataType: () => 'integer',
  fromDriver: value => new Date(Number(value)),
  toDriver: value => value.getTime(),
})

const toSqliteColumn = (name: string, column: ColumnDef): AnyType => {
  let builder: AnyType
  switch (column.type) {
    case 'int': {
      builder = sqliteInt(name)
      break
    }
    case 'bigint': {
      builder = sqliteBigint(name)
      break
    }
    case 'boolean': {
      builder = integer(name, { mode: 'boolean' })
      break
    }
    case 'timestamp': {
      builder = sqliteTimestamp(name)
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
