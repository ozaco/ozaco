import type { Failure } from 'std:result'
import { asFailure, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { DbErrorCode } from '../../../error-codes'
import type { DbError } from '../../../types/runtime'

const SQLITE_UNIQUE = /UNIQUE constraint failed: (?<column>.+)/
const SQLITE_FK = /FOREIGN KEY constraint failed/

export const classifySqliteError = (raw: unknown): Failure<DbError> => {
  if (!raw || typeof raw !== 'object') {
    return asFailure<DbError>(raw as AnyType)
  }
  const err = raw as { message?: string }
  if (typeof err.message !== 'string') {
    return asFailure<DbError>(raw as AnyType)
  }

  const unique = SQLITE_UNIQUE.exec(err.message)
  if (unique) {
    const column = unique.groups?.column ?? ''
    return fail(DbErrorCode.UniqueViolation, err.message, `column=${column}`) as Failure<DbError>
  }
  if (SQLITE_FK.test(err.message)) {
    return fail(DbErrorCode.ForeignKeyViolation, err.message) as Failure<DbError>
  }

  return asFailure<DbError>(raw as AnyType)
}
