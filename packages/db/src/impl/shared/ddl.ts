// oxlint-disable import/exports-last
import type { ColumnSpec, IndexSpec, MigrateStep } from 'db:core'
import { CREATED, UPDATED, VERSION } from 'db:core'

import { quoteIdent } from './compile'
import type { SqlDialect } from './types'

const indexName = (table: string, index: string): string => `${table}__${index}`

const columnDdl = (dialect: SqlDialect, column: ColumnSpec): string => {
  const parts = [quoteIdent(column.name), dialect.types[column.kind]]
  if (column.primary) {
    parts.push('PRIMARY KEY')
  } else if (!column.optional) {
    parts.push('NOT NULL')
  }
  // legacy tables gain system columns via add-column; give them backfillable defaults
  if (column.system && column.name === VERSION) {
    parts.push('DEFAULT 1')
  }
  if (column.system && (column.name === CREATED || column.name === UPDATED)) {
    parts.push('DEFAULT 0')
  }
  return parts.join(' ')
}

/** New columns on an EXISTING table are added nullable (a populated table cannot satisfy a bare
 * NOT NULL), except system columns which carry defaults. */
const addColumnDdl = (dialect: SqlDialect, column: ColumnSpec): string =>
  column.system
    ? columnDdl(dialect, column)
    : `${quoteIdent(column.name)} ${dialect.types[column.kind]}`

const createIndexSql = (table: string, index: IndexSpec): string =>
  `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quoteIdent(indexName(table, index.name))} ON ${quoteIdent(table)} (${index.columns.map(quoteIdent).join(', ')})`

/** Compile one reconcile step to its statements for this dialect. */
export const compileMigrateStep = (dialect: SqlDialect, step: MigrateStep): readonly string[] => {
  switch (step.kind) {
    case 'create-table': {
      return [
        `CREATE TABLE IF NOT EXISTS ${quoteIdent(step.table.name)} (${step.table.columns
          .map(column => columnDdl(dialect, column))
          .join(', ')})`,
      ]
    }
    case 'add-column': {
      return [
        `ALTER TABLE ${quoteIdent(step.table)} ADD COLUMN ${addColumnDdl(dialect, step.column)}`,
      ]
    }
    case 'drop-column': {
      return [`ALTER TABLE ${quoteIdent(step.table)} DROP COLUMN ${quoteIdent(step.column)}`]
    }
    case 'create-index': {
      return [createIndexSql(step.table, step.index)]
    }
    case 'drop-index': {
      return [`DROP INDEX IF EXISTS ${quoteIdent(indexName(step.table, step.index))}`]
    }
    case 'drop-table': {
      return [`DROP TABLE IF EXISTS ${quoteIdent(step.table)}`]
    }
    case 'reindex': {
      return [dialect.reindexTable(step.table)]
    }
    default: {
      return []
    }
  }
}
