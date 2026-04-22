import type { AnyType } from 'std:shared'

import {
  customType,
  bigint as pgBigint,
  boolean as pgBoolean,
  integer as pgInteger,
  json as pgJson,
  serial as pgSerial,
  pgTable,
  text as pgText,
  timestamp as pgTimestamp,
  varchar as pgVarchar,
} from 'drizzle-orm/pg-core'

import type { ColumnDef, SchemaDef, TableDef } from '../../schema/types'

import type { DrizzleTableMap } from './drizzle-base'

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  fromDriver: value => new Uint8Array(value),
  toDriver: value => Buffer.from(value),
})

const pgBaseBuilder = (name: string, column: ColumnDef): AnyType => {
  switch (column.type) {
    case 'int': {
      return column.isAutoIncrement && column.isPrimary ? pgSerial(name) : pgInteger(name)
    }
    case 'bigint': {
      return pgBigint(name, { mode: 'bigint' })
    }
    case 'boolean': {
      return pgBoolean(name)
    }
    case 'timestamp': {
      return pgTimestamp(name, { mode: 'date', withTimezone: true })
    }
    case 'text': {
      return pgText(name)
    }
    case 'varchar': {
      return column.length === null ? pgVarchar(name) : pgVarchar(name, { length: column.length })
    }
    case 'json': {
      return pgJson(name)
    }
    case 'blob': {
      return bytea(name)
    }
    default: {
      return pgText(name)
    }
  }
}

const applyPgConstraints = (builder: AnyType, column: ColumnDef): AnyType => {
  let result = builder
  if (column.isPrimary) {
    result = result.primaryKey()
  }
  if (!column.isNullable && !column.isPrimary && !column.isAutoIncrement) {
    result = result.notNull()
  }
  if (column.isUnique && !column.isPrimary) {
    result = result.unique()
  }
  if (column.isDefaultNow && column.type === 'timestamp') {
    result = result.defaultNow()
  } else if (column.hasDefault && !column.isAutoIncrement && column.defaultValue !== undefined) {
    result = result.default(column.defaultValue as AnyType)
  }
  return result
}

const toPgColumn = (name: string, column: ColumnDef): AnyType =>
  applyPgConstraints(pgBaseBuilder(name, column), column)

const buildPgTables = (schema: SchemaDef): DrizzleTableMap => {
  const tables: DrizzleTableMap = {}
  for (const tableDef of Object.values(schema.tables)) {
    const columns: Record<string, AnyType> = {}
    for (const [columnName, column] of Object.entries((tableDef as TableDef).columns)) {
      columns[columnName] = toPgColumn(columnName, column)
    }
    tables[(tableDef as TableDef).name] = pgTable((tableDef as TableDef).name, columns)
  }
  return tables
}

export { buildPgTables }
