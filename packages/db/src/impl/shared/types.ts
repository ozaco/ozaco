import type { Spec } from 'db:core'
import type { Context, Operation } from 'std:effect'

/** The shared SQL layer every SQL-backed adapter (`sqlite`, `pg`, `bun-sql`) is assembled from. */
export namespace Sql {
  /**
   * The dialect descriptor the shared spec→SQL compiler is parameterized by. Portable value
   * mapping is fixed across dialects: `timestamp` is stored as epoch millis, `json` as text, so
   * rows round-trip identically regardless of driver. `encode`/`decode` are OPERATIONS because
   * `json` columns are (de)serialized through the installed `JsonCodec`.
   */

  export interface Dialect {
    /** 1-based bind placeholder (`$1` for Postgres, `?` for SQLite). */
    readonly placeholder: (index: number) => string
    readonly types: Readonly<Record<Spec.ColumnKind, string>>

    /** native case-insensitive LIKE operator, or null → `LOWER(x) LIKE LOWER(p)` fallback. */
    readonly ilike: string | null
    readonly reindexTable: (table: string) => string

    /** Retype one column in place (with a cast), or null when the backend cannot. */
    readonly alterColumn: ((table: string, column: string, type: string) => string) | null

    /** The column listing of a table — rows must expose the column name as `name` and its
     * native type as `type`. */
    readonly introspect: (table: string) => Statement

    /** Every table of the current schema — rows must expose the name as `name`. */
    readonly tables: () => Statement
    encode(kind: Spec.ColumnKind, value: unknown): Operation<unknown>
    decode(kind: Spec.ColumnKind, value: unknown): Operation<unknown>
  }

  /** One statement under construction: binds accumulate in order, encoded by column kind. */
  export interface Builder {
    readonly dialect: Dialect
    readonly kinds: ReadonlyMap<string, Spec.ColumnKind>
    readonly params: unknown[]
  }

  export interface Statement {
    readonly text: string
    readonly params: readonly unknown[]
  }

  /** What one executed statement yields, driver-normalized. */
  export interface Result {
    readonly rows: readonly Spec.Doc[]
    readonly rowCount: number
  }

  /** Run one statement (on the pinned transaction session when inside one), classifying driver
   * errors into `DbErrors` failures. */
  export type Executor = (statement: string, params: readonly unknown[]) => Operation<Result>

  /** What the shared data-plane action factory needs from an adapter. */
  export interface Runtime {
    readonly dialect: Dialect
    readonly exec: Executor
  }

  /** What the shared transaction runner needs: the executor, the nesting-depth context and how to
   * pin a session for a top-level transaction (`session` runs `body` with the session bound and
   * releases it afterwards, whatever the outcome). */

  export interface Transactional {
    readonly exec: Executor
    readonly depth: Context<number>
    session<T>(body: () => Operation<T>): Operation<T>
  }
}
