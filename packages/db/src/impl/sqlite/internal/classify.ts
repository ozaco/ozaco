import type { Result } from 'std:result'
import { asFailure, fail } from 'std:result'

import { DbErrorCode } from '../../../error-codes'

const SQLITE_UNIQUE = /UNIQUE constraint failed: (?<column>.+)/u
const SQLITE_FK = /FOREIGN KEY constraint failed/u

export const classifySqliteError = (raw: unknown): Result.Failure<unknown> => {
  if (!raw || typeof raw !== 'object') {
    return asFailure(raw) as Result.Failure<unknown>
  }
  const err = raw as { message?: string }
  if (typeof err.message !== 'string') {
    return asFailure(raw) as Result.Failure<unknown>
  }

  const unique = SQLITE_UNIQUE.exec(err.message)
  if (unique) {
    const column = unique.groups?.column ?? ''
    return fail(
      DbErrorCode.UniqueViolation,
      err.message,
      `column=${column}`,
    ) as Result.Failure<unknown>
  }
  if (SQLITE_FK.test(err.message)) {
    return fail(DbErrorCode.ForeignKeyViolation, err.message) as Result.Failure<unknown>
  }

  return asFailure(raw) as Result.Failure<unknown>
}
