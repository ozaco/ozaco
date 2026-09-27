// oxlint-disable import/exports-last
import { DbErrors } from 'db:core'
import { driverCause } from 'db:internal'
import { createContext, until, useContext } from 'std:effect'
import { asFailure, isFailure, succeed } from 'std:result'
import type { AnyType } from 'std:shared'

import { SQL } from 'bun'

import type { Sql } from '../shared/types/sql'

import type { BunSql } from './types'

export const StateRef = createContext<BunSql.State>('db:impl/bun-sql')

/** The reserved connection while inside a transaction. */
const TxSession = createContext<AnyType>('db:impl/bun-sql:tx-session')
const TxDepth = createContext<number>('db:impl/bun-sql:tx-depth', 0)

/** A driver rejection as its `DbErrors` failure — classified by the `DbErrors` matchers (Bun SQL
 * puts the SQLSTATE in `errno`, its `code` is the generic `ERR_POSTGRES_SERVER_ERROR`; else the
 * text; `db.query` for anything else), the driver's message, the driver error as `raw` and its
 * SQLSTATE as the `sqlstate <code>` cause the db span reports as `db.response.status_code`. */
const raise = (error: unknown) => asFailure(error, DbErrors, driverCause(error))

/** Await a driver promise. A rejection is classified where it happens — from the driver error
 * itself, never from the effect runtime's fold of it. */
export function* driver(promise: Promise<AnyType>) {
  const outcome = yield* until(promise.then(value => succeed(value), raise))

  if (isFailure(outcome)) {
    return yield* outcome
  }

  return outcome.value as AnyType
}

/** Run one statement on the reserved transaction connection or the shared client. */
export const exec: Sql.Executor = function* (statement: string, params: readonly unknown[]) {
  const state = yield* useContext(StateRef)
  const runner = (yield* TxSession.get()) ?? state.client
  const result = yield* driver(runner.unsafe(statement, [...params]))
  const rows = (Array.isArray(result) ? result : []) as AnyType[]

  return { rows, rowCount: rows.length }
}

export const SqlClient = SQL as AnyType

/** The shared-transaction seam `runSqlTransaction` drives. */
export const transactional: Sql.Transactional = {
  exec,
  depth: TxDepth,

  // a transaction reserves one pooled connection for its whole duration
  *session(body) {
    const state = yield* useContext(StateRef)
    const session = yield* driver(state.client.reserve())

    try {
      return yield* TxSession.with(session, body)
    } finally {
      session.release?.()
    }
  },
}
