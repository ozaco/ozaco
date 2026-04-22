const SQLITE_UNIQUE = /UNIQUE constraint failed: (?<column>.+)/
const SQLITE_FK = /FOREIGN KEY constraint failed/
const PG_UNIQUE_CODE = '23505'
const PG_FK_CODE = '23503'
const PG_CHECK_CODE = '23514'
const PG_CONNECTION_CODES = new Set(['08000', '08003', '08006', '08001', '08004'])

export type DbError =
  | 'connection-lost'
  | 'unique-violation'
  | 'foreign-key-violation'
  | 'check-violation'
  | 'not-found'
  | 'validation'
  | 'tx-conflict'
  | 'driver'

export interface DbErrorDetail {
  readonly kind: DbError
  readonly message: string
  readonly column: string | null
  readonly cause: unknown
}

export const classifyDriverError = (raw: unknown): DbErrorDetail => {
  if (!raw || typeof raw !== 'object') {
    return { kind: 'driver', message: String(raw), column: null, cause: raw }
  }

  const err = raw as { code?: string; message?: string }
  const message = err.message ?? 'driver error'

  if (typeof err.code === 'string') {
    if (err.code === PG_UNIQUE_CODE) {
      return { kind: 'unique-violation', message, column: null, cause: raw }
    }
    if (err.code === PG_FK_CODE) {
      return { kind: 'foreign-key-violation', message, column: null, cause: raw }
    }
    if (err.code === PG_CHECK_CODE) {
      return { kind: 'check-violation', message, column: null, cause: raw }
    }
    if (PG_CONNECTION_CODES.has(err.code)) {
      return { kind: 'connection-lost', message, column: null, cause: raw }
    }
  }

  if (typeof err.message === 'string') {
    const unique = SQLITE_UNIQUE.exec(err.message)
    if (unique) {
      return {
        kind: 'unique-violation',
        message: err.message,
        column: unique.groups?.column ?? null,
        cause: raw,
      }
    }
    if (SQLITE_FK.test(err.message)) {
      return { kind: 'foreign-key-violation', message: err.message, column: null, cause: raw }
    }
  }

  return { kind: 'driver', message, column: null, cause: raw }
}
