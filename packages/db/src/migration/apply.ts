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

  for (const tableDef of Object.values(schema.tables)) {
    const table = tableDef as TableDef
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
