import type { ColumnDef, TableDef } from '../schema/types'

type Dialect = 'sqlite' | 'postgres'

/** Quote an identifier for SQL, escaping embedded double quotes (`"` → `""`). */
const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** Quote a string literal for SQL, escaping embedded single quotes (`'` → `''`). */
const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`

const sqliteType = (column: ColumnDef): string => {
  switch (column.type) {
    case 'int':
    case 'bigint':
    case 'boolean':
    case 'timestamp': {
      return 'INTEGER'
    }
    case 'text':
    case 'varchar':
    case 'json': {
      return 'TEXT'
    }
    case 'blob': {
      return 'BLOB'
    }
    default: {
      return 'TEXT'
    }
  }
}

const postgresType = (column: ColumnDef): string => {
  switch (column.type) {
    case 'int': {
      return column.isAutoIncrement && column.isPrimary ? 'SERIAL' : 'INTEGER'
    }
    case 'bigint': {
      return 'BIGINT'
    }
    case 'boolean': {
      return 'BOOLEAN'
    }
    case 'timestamp': {
      return 'TIMESTAMP WITH TIME ZONE'
    }
    case 'text': {
      return 'TEXT'
    }
    case 'varchar': {
      return column.length === null ? 'VARCHAR' : `VARCHAR(${column.length})`
    }
    case 'json': {
      return 'JSON'
    }
    case 'blob': {
      return 'BYTEA'
    }
    default: {
      return 'TEXT'
    }
  }
}

const dialectColumnType = (column: ColumnDef, dialect: Dialect): string =>
  dialect === 'sqlite' ? sqliteType(column) : postgresType(column)

const renderDefault = (value: unknown): string => {
  if (value === null) {
    return 'NULL'
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value)
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE'
  }
  const str = typeof value === 'string' ? value : JSON.stringify(value)
  return `'${str.replaceAll("'", "''")}'`
}

const columnConstraints = (column: ColumnDef, dialect: Dialect): string[] => {
  const parts: string[] = []
  if (column.isPrimary) {
    parts.push('PRIMARY KEY')
    if (dialect === 'sqlite' && column.isAutoIncrement) {
      parts.push('AUTOINCREMENT')
    }
  }
  const serialSkipsNotNull = dialect === 'postgres' && column.isAutoIncrement && column.isPrimary
  if (!column.isNullable && !column.isPrimary && !serialSkipsNotNull) {
    parts.push('NOT NULL')
  }
  if (column.isUnique && !column.isPrimary) {
    parts.push('UNIQUE')
  }
  if (column.isDefaultNow && column.type === 'timestamp') {
    parts.push(dialect === 'sqlite' ? 'DEFAULT (unixepoch() * 1000)' : 'DEFAULT NOW()')
  } else if (column.hasDefault && !column.isAutoIncrement && column.defaultValue !== undefined) {
    parts.push(`DEFAULT ${renderDefault(column.defaultValue)}`)
  }
  if (column.foreignKey) {
    parts.push(
      `REFERENCES ${quoteIdent(column.foreignKey.table)}(${quoteIdent(column.foreignKey.column)})`,
    )
  }
  return parts
}

interface AddColumnArgs {
  readonly tableName: string
  readonly columnName: string
  readonly column: ColumnDef
  readonly dialect: Dialect
}

export type { Dialect }

export const columnType = dialectColumnType

export const formatDefault = renderDefault

export const createTableStatement = (table: TableDef, dialect: Dialect): string => {
  const parts: string[] = []
  for (const [name, column] of Object.entries(table.columns)) {
    const type = dialectColumnType(column, dialect)
    const constraints = columnConstraints(column, dialect)
    parts.push(
      `  ${quoteIdent(name)} ${type}${constraints.length > 0 ? ` ${constraints.join(' ')}` : ''}`,
    )
  }
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(table.name)} (\n${parts.join(',\n')}\n)`
}

export const addColumnStatement = ({
  tableName,
  columnName,
  column,
  dialect,
}: AddColumnArgs): string => {
  const type = dialectColumnType(column, dialect)
  const constraints = columnConstraints(column, dialect).filter(c => !c.includes('PRIMARY KEY'))
  return `ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${quoteIdent(columnName)} ${type}${constraints.length > 0 ? ` ${constraints.join(' ')}` : ''}`
}

export const existingColumnsQuery = (tableName: string, dialect: Dialect): string =>
  dialect === 'sqlite'
    ? `SELECT name FROM pragma_table_info(${quoteLiteral(tableName)})`
    : `SELECT column_name AS name FROM information_schema.columns WHERE table_name = ${quoteLiteral(tableName)}`

export const migrationsTableDdl = (dialect: Dialect): string =>
  dialect === 'sqlite'
    ? `CREATE TABLE IF NOT EXISTS "_ozaco_migrations" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "tag" TEXT NOT NULL UNIQUE, "applied_at" INTEGER NOT NULL)`
    : `CREATE TABLE IF NOT EXISTS "_ozaco_migrations" ("id" SERIAL PRIMARY KEY, "tag" TEXT NOT NULL UNIQUE, "applied_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW())`

export const recordMigrationSql = (dialect: Dialect): string =>
  dialect === 'sqlite'
    ? `INSERT INTO "_ozaco_migrations" ("tag", "applied_at") VALUES (?, ?) ON CONFLICT DO NOTHING`
    : `INSERT INTO "_ozaco_migrations" ("tag") VALUES ($1) ON CONFLICT DO NOTHING`
