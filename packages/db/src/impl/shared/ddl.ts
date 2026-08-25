import type { Spec } from 'db:core'
import { FIELDS, VERSION_ZERO } from 'db:core'

import { quoteIdent } from './compile'
import type { Sql } from './types'

const indexName = (table: string, index: string): string => `${table}__${index}`

/** Backfill defaults for system columns added to a LEGACY table (`add-column` on existing rows). */
const systemDefault = (column: Spec.Column): string | null => {
  if (!column.system) {
    return null
  }

  if (column.name === FIELDS.version) {
    return `DEFAULT '${VERSION_ZERO}'`
  }

  return column.name === FIELDS.created || column.name === FIELDS.updated ? 'DEFAULT 0' : null
}

const columnDdl = (dialect: Sql.Dialect, column: Spec.Column): string => {
  const parts = [quoteIdent(column.name), dialect.types[column.kind]]

  if (column.primary) {
    parts.push('PRIMARY KEY')
  } else if (!column.optional) {
    parts.push('NOT NULL')
  }
  const fallback = systemDefault(column)

  if (fallback) {
    parts.push(fallback)
  }

  return parts.join(' ')
}

/** New columns on an EXISTING table are added nullable (a populated table cannot satisfy a bare
 * NOT NULL), except system columns which carry defaults. */
const addColumnDdl = (dialect: Sql.Dialect, column: Spec.Column): string =>
  column.system
    ? columnDdl(dialect, column)
    : `${quoteIdent(column.name)} ${dialect.types[column.kind]}`

const createIndexSql = (table: string, index: Spec.Index): string =>
  `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quoteIdent(indexName(table, index.name))} ON ${quoteIdent(table)} (${index.columns.map(quoteIdent).join(', ')})`

/** Compile one reconcile step to its statements for this dialect. */
export const compileStep = (dialect: Sql.Dialect, step: Spec.Step): readonly string[] => {
  switch (step.kind) {
    case 'create-table': {
      const columns = step.table.columns.map(column => columnDdl(dialect, column)).join(', ')
      return [`CREATE TABLE IF NOT EXISTS ${quoteIdent(step.table.name)} (${columns})`]
    }

    case 'add-column': {
      return [
        `ALTER TABLE ${quoteIdent(step.table)} ADD COLUMN ${addColumnDdl(dialect, step.column)}`,
      ]
    }

    case 'drop-column': {
      return [`ALTER TABLE ${quoteIdent(step.table)} DROP COLUMN ${quoteIdent(step.column)}`]
    }

    case 'alter-column': {
      const { alterColumn } = dialect
      return alterColumn && !step.unsupported
        ? [alterColumn(step.table, step.column.name, dialect.types[step.column.kind])]
        : []
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
