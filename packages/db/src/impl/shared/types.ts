import type { ColumnKind } from 'db:core'
import type { Operation } from 'std:effect'

/**
 * The dialect descriptor the shared spec→SQL compiler is parameterized by. Portable value mapping
 * is fixed across dialects: `timestamp` is stored as epoch millis, `json` as text, so rows
 * round-trip identically regardless of driver.
 *
 * `encode`/`decode` are OPERATIONS because `json` columns are (de)serialized through the installed
 * `JsonCodec` — every other kind is a straight mapping that never suspends.
 */
export interface SqlDialect {
  /** 1-based bind placeholder (`$1` for Postgres, `?` for SQLite). */
  readonly placeholder: (index: number) => string
  readonly types: Readonly<Record<ColumnKind, string>>
  /** native case-insensitive LIKE operator, or null → `LOWER(x) LIKE LOWER(p)` fallback. */
  readonly ilike: string | null
  readonly reindexTable: (table: string) => string
  encode(kind: ColumnKind, value: unknown): Operation<unknown>
  decode(kind: ColumnKind, value: unknown): Operation<unknown>
}

export interface Statement {
  readonly text: string
  readonly params: readonly unknown[]
}
