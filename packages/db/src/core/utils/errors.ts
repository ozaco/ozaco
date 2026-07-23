import type { Result } from 'std:result'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'
import { createTags } from 'std:shared'

const readPostgresFields = (error: AnyType): PostgresErrorFields => ({
  code: error?.code,
  constraint: error?.constraint,
  table: error?.table,
  column: error?.column,
  detail: error?.detail,
  schema: error?.schema,
  routine: error?.routine,
})

/**
 * Slonik's error taxonomy, ported to the Result system: every Slonik error class becomes a tag we
 * `fail(tag, …)` with, instead of a thrown `Error`. Names mirror Slonik's classes 1:1
 * (`UniqueIntegrityConstraintViolationError` → `DbError.UniqueIntegrityConstraintViolation`, …).
 */
export const DbError = createTags(
  'db',
  // --- query result shape (from the query methods) ---
  'not-found', // NotFoundError — a `one`/`many` expected ≥1 row but got 0
  'data-integrity', // DataIntegrityError — `one`/`oneFirst` matched >1 row, or column count wrong
  // --- integrity constraint violations (SQLSTATE class 23) ---
  'integrity-constraint-violation',
  'unique-integrity-constraint-violation', // 23505
  'foreign-key-integrity-constraint-violation', // 23503
  'not-null-integrity-constraint-violation', // 23502
  'check-integrity-constraint-violation', // 23514
  // --- execution ---
  'statement-timeout', // 57014 + "statement timeout"
  'statement-cancelled', // 57014
  'input-syntax', // 42601
  'tuple-moved-to-another-partition',
  'transaction-rollback', // 40001 serialization_failure / 40P01 deadlock_detected — retryable

  // --- connection / backend ---
  'connection', // ConnectionError — establishing/using a connection failed
  'backend-terminated', // BackendTerminatedError — server closed the connection
  // --- configuration / misuse ---
  'invalid-configuration', // InvalidConfigurationError
  'unexpected-foreign-connection', // UnexpectedForeignConnectionError
  'unexpected-state', // UnexpectedStateError
  // --- fallback ---
  'query', // generic query failure with no more specific classification
)

/** The Postgres error fields Slonik surfaces on integrity/execution failures (from the wire). */
export interface PostgresErrorFields {
  readonly code?: string | undefined
  readonly constraint?: string | undefined
  readonly table?: string | undefined
  readonly column?: string | undefined
  readonly detail?: string | undefined
  readonly schema?: string | undefined
  readonly routine?: string | undefined
}

/**
 * Map a Postgres driver error (node-`pg` or Bun `SQL`) to the matching {@link DbError} tag by
 * SQLSTATE — the Result-world counterpart of `@slonik/pg-driver`'s error classification. The failure
 * carries the message plus the relevant constraint/table/column detail as causes.
 */
export const classifyPostgresError = (error: AnyType): Result.Failure<unknown> => {
  const fields = readPostgresFields(error)
  const code = fields.code ?? ''
  const message = String(error?.message ?? error)
  const causes = [
    fields.constraint ? `constraint=${fields.constraint}` : undefined,
    fields.table ? `table=${fields.table}` : undefined,
    fields.column ? `column=${fields.column}` : undefined,
    fields.detail,
  ].filter((cause): cause is string => Boolean(cause))

  const raise = (tag: string): Result.Failure<unknown> =>
    fail(tag, message, ...causes) as Result.Failure<unknown>

  if (code === '23505') {
    return raise(DbError.UniqueIntegrityConstraintViolation)
  }
  if (code === '23503') {
    return raise(DbError.ForeignKeyIntegrityConstraintViolation)
  }
  if (code === '23502') {
    return raise(DbError.NotNullIntegrityConstraintViolation)
  }
  if (code === '23514') {
    return raise(DbError.CheckIntegrityConstraintViolation)
  }
  if (code.startsWith('23')) {
    return raise(DbError.IntegrityConstraintViolation)
  }
  if (code === '57014') {
    return /statement timeout/iu.test(message)
      ? raise(DbError.StatementTimeout)
      : raise(DbError.StatementCancelled)
  }
  if (code === '42601') {
    return raise(DbError.InputSyntax)
  }
  if (code === '40001' || code === '40P01') {
    return raise(DbError.TransactionRollback)
  }
  if (code === '57P01' || code === '57P02' || code === '57P03') {
    return raise(DbError.BackendTerminated)
  }
  if (code.startsWith('08')) {
    return raise(DbError.Connection)
  }
  return raise(DbError.Query)
}
