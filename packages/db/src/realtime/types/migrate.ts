export type MigrationMode = 'auto' | 'manual'

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
}
