import type { Adapter, Spec } from 'db:core'

import { compileCount, compileDelete, compileFind, compileInsert, compileUpdate } from './compile'
import { compileStep } from './ddl'
import { decodeRows, encodeRawParams } from './dialects'
import type { Sql } from './types'

/** The contract members every SQL adapter shares verbatim (only the executor and dialect differ). */

/**
 * Assemble the structured data plane of a SQL adapter over a dialect + executor: every spec is
 * compiled by the shared compiler, run through `exec`, and decoded back to app values by the
 * table's declared column kinds. Adapters spread this into `build({...})` and add what is
 * backend-specific (`transaction`).
 */
export const sqlActions = ({
  dialect,
  exec,
}: Sql.Runtime): Pick<
  Adapter.Actions,
  'find' | 'count' | 'insert' | 'update' | 'remove' | 'introspect' | 'tables' | 'migrate' | 'raw'
> => {
  const decoded = function* (table: Spec.Table, statement: Sql.Statement) {
    const result = yield* exec(statement.text, statement.params)
    return yield* decodeRows(dialect, table, result.rows)
  }

  return {
    *find(spec: Spec.Find) {
      return yield* decoded(spec.table, yield* compileFind(dialect, spec))
    },

    *count(spec: Spec.Count) {
      const statement = yield* compileCount(dialect, spec)
      const result = yield* exec(statement.text, statement.params)

      return Number(result.rows[0]?.count ?? 0)
    },

    *insert(table: Spec.Table, rows: readonly Spec.Doc[]) {
      if (rows.length === 0) {
        return []
      }

      return yield* decoded(table, yield* compileInsert(dialect, table, rows))
    },

    *update(spec: Spec.Update) {
      return yield* decoded(spec.table, yield* compileUpdate(dialect, spec))
    },

    *remove(spec: Spec.Delete) {
      return yield* decoded(spec.table, yield* compileDelete(dialect, spec))
    },

    *introspect(table: Spec.Table) {
      const statement = dialect.introspect(table.name)
      const result = yield* exec(statement.text, statement.params)

      if (result.rows.length === 0) {
        return null
      }

      const declared = new Map(table.columns.map(column => [column.name, column.kind]))

      return {
        columns: result.rows.map(row => {
          const name = String(row.name)
          const kind = declared.get(name)
          return {
            name,
            type: typeof row.type === 'string' ? row.type.toLowerCase() : null,
            expected: kind ? dialect.types[kind].toLowerCase() : null,
          }
        }),
      }
    },

    *tables() {
      const statement = dialect.tables()
      const result = yield* exec(statement.text, statement.params)

      return result.rows.map(row => String(row.name))
    },

    *migrate(steps: readonly Spec.Step[]) {
      for (const step of steps) {
        for (const statement of compileStep(dialect, step)) {
          yield* exec(statement, [])
        }
      }
    },

    *raw(statement: string, params?: readonly unknown[], table?: Spec.Table) {
      const result = yield* exec(statement, yield* encodeRawParams(dialect, params ?? []))
      const rows = table ? yield* decodeRows(dialect, table, result.rows) : result.rows

      return { rows, rowCount: result.rowCount }
    },
  }
}
