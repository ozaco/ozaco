/* oxlint-disable no-await-in-loop */
import type { SchemaDef, TableDef } from '../schema/types'

import type { Dialect } from './ddl'
import {
  addColumnStatement,
  createTableStatement,
  existingColumnsQuery,
  migrationsTableDdl,
  recordMigrationSql,
} from './ddl'

const listExistingColumns = async (
  exec: RawExec,
  tableName: string,
  dialect: Dialect,
): Promise<Set<string>> => {
  try {
    const rows = (await exec(existingColumnsQuery(tableName, dialect))) as Array<{ name: string }>
    return new Set(rows.map(r => r.name))
  } catch {
    return new Set()
  }
}

/**
 * Order tables so foreign-key targets are created before the tables referencing them (postgres
 * rejects a `REFERENCES` to a table that does not exist yet). Cycles fall back to definition order.
 */
const sortByForeignKeys = (tables: TableDef[]): TableDef[] => {
  const remaining = new Map(tables.map(table => [table.name, table]))
  const sorted: TableDef[] = []

  while (remaining.size > 0) {
    let progressed = false
    for (const [name, table] of remaining) {
      const blocked = Object.values(table.columns).some(
        column =>
          column.foreignKey &&
          column.foreignKey.table !== name &&
          remaining.has(column.foreignKey.table),
      )
      if (!blocked) {
        sorted.push(table)
        remaining.delete(name)
        progressed = true
      }
    }
    if (!progressed) {
      sorted.push(...remaining.values())
      break
    }
  }

  return sorted
}

export type RawExec = (sql: string, params?: unknown[]) => Promise<unknown[]>

export const schemaTag = (schema: SchemaDef): string => {
  const tables = Object.entries(schema.tables)
    .map(([name, table]) => {
      const cols = Object.entries((table as TableDef).columns)
        .map(
          ([col, def]) =>
            `${col}:${def.type}${def.isNullable ? '?' : ''}${def.isPrimary ? '!' : ''}`,
        )
        .toSorted()
        .join(',')
      return `${name}(${cols})`
    })
    .toSorted()
    .join('|')
  return `v1:${tables}`
}

export const applyMigrations = async (
  exec: RawExec,
  schema: SchemaDef,
  dialect: Dialect,
): Promise<void> => {
  await exec(migrationsTableDdl(dialect))

  for (const table of sortByForeignKeys(Object.values(schema.tables) as TableDef[])) {
    const existing = await listExistingColumns(exec, table.name, dialect)

    if (existing.size === 0) {
      await exec(createTableStatement(table, dialect))
      continue
    }

    for (const [columnName, column] of Object.entries(table.columns)) {
      if (!existing.has(columnName)) {
        await exec(addColumnStatement({ tableName: table.name, columnName, column, dialect }))
      }
    }
  }

  const tag = schemaTag(schema)
  const params = dialect === 'sqlite' ? [tag, Date.now()] : [tag]
  await exec(recordMigrationSql(dialect), params)
}
