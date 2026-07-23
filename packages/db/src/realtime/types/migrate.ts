import type { DriverDef } from 'db:core'

export type MigrationMode = 'auto' | 'manual'

/** The SQL dialect the schema/query builders target — resolved from the installed driver
 * (`useDriver()`). Postgres/SQLite share the ANSI path; `surreal` takes the SurrealQL branch. */
export type Dialect = DriverDef.Info['dialect']

export interface MigrationStatement {
  readonly kind: 'create-table' | 'add-column' | 'drop-column' | 'create-index'
  readonly table: string
  readonly sql: string
  readonly destructive: boolean
}

export interface MigrationPlan {
  readonly statements: readonly MigrationStatement[]
}

export interface ApplyOptions {
  readonly allowDestructive?: boolean | undefined
  /** Target dialect for the emitted DDL. Defaults to `postgres` (the ANSI path). */
  readonly dialect?: Dialect | undefined
}
