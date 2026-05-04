import type { DbErrorCode } from '../error-codes'

export type DbError = (typeof DbErrorCode)[keyof typeof DbErrorCode]
