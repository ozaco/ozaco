import type { Adapter, Spec } from 'db:core'
import { noteQuery } from 'db:internal'

import {
  compileAggregate,
  compileCount,
  compileDelete,
  compileFind,
  compileInsert,
  compileUpdate,
} from './compile'
import { compileStep } from './ddl'
import { decodeRows, encodeRawParams } from './dialects'
import type { Sql } from './types/sql'

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
  | 'find'
  | 'count'
  | 'aggregate'
  | 'insert'
  | 'update'
  | 'remove'
  | 'introspect'
  | 'tables'
  | 'migrate'
  | 'raw'
> => {
  /** Run one compiled data-plane statement — its (parameterized) text noted for the db span in
   * progress, `db.query.text`. */
  const run = function* (statement: Sql.Statement) {
    yield* noteQuery(statement.text)
    return yield* exec(statement.text, statement.params)
  }

  const decoded = function* (table: Spec.Table, statement: Sql.Statement) {
    const result = yield* run(statement)
    return yield* decodeRows(dialect, table, result.rows)
  }

  return {
    *find(spec: Spec.Find) {
      return yield* decoded(spec.table, yield* compileFind(dialect, spec))
    },

    *count(spec: Spec.Count) {
      const result = yield* run(yield* compileCount(dialect, spec))

      return Number(result.rows[0]?.count ?? 0)
    },

    *aggregate(spec: Spec.Aggregate) {
      const result = yield* run(yield* compileAggregate(dialect, spec))

      // the answer's columns are the grouped ones (their own kinds) plus the aliases: `min`/`max`
      // carry the SOURCE column's kind so a timestamp comes back a Date, counts/sums are numbers
      const kinds = new Map(spec.table.columns.map(column => [column.name, column]))

      const columns: Spec.Column[] = [
        ...spec.groupBy.flatMap(field => {
          const column = kinds.get(field)
          return column ? [column] : []
        }),

        ...spec.ops.map(op => {
          const source = op.field === null ? undefined : kinds.get(op.field)

          const kind: Spec.ColumnKind =
            op.kind === 'count'
              ? 'int'
              : op.kind === 'min' || op.kind === 'max'
                ? (source?.kind ?? 'json')
                : 'float'

          return {
            name: op.as,
            kind,
            optional: true,
            hasDefault: false,
            enumValues: null,
            system: false,
            primary: false,
          }
        }),
      ]

      return yield* decodeRows(dialect, { ...spec.table, columns }, result.rows)
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
