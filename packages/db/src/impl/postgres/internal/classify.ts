import type { Failure } from 'std:result'
import { asFailure, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { DbErrorCode } from '../../../error-codes'
import type { DbError } from '../../../types/runtime'

const PG_UNIQUE_CODE = '23505'
const PG_FK_CODE = '23503'
const PG_CHECK_CODE = '23514'
const PG_CONNECTION_CODES = new Set(['08000', '08003', '08006', '08001', '08004'])

export const classifyPostgresError = (raw: unknown): Failure<DbError> => {
  if (!raw || typeof raw !== 'object') {
    return asFailure<DbError>(raw as AnyType)
  }
  const err = raw as { code?: string; message?: string }
  const message = err.message ?? 'driver error'

  if (typeof err.code !== 'string') {
    return asFailure<DbError>(raw as AnyType)
  }
  if (err.code === PG_UNIQUE_CODE) {
    return fail(DbErrorCode.UniqueViolation, message, `sqlstate=${err.code}`) as Failure<DbError>
  }
  if (err.code === PG_FK_CODE) {
    return fail(
      DbErrorCode.ForeignKeyViolation,
      message,
      `sqlstate=${err.code}`,
    ) as Failure<DbError>
  }
  if (err.code === PG_CHECK_CODE) {
    return fail(DbErrorCode.CheckViolation, message, `sqlstate=${err.code}`) as Failure<DbError>
  }
  if (PG_CONNECTION_CODES.has(err.code)) {
    return fail(DbErrorCode.ConnectionLost, message, `sqlstate=${err.code}`) as Failure<DbError>
  }
  return asFailure<DbError>(raw as AnyType)
}
