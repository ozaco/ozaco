// oxlint-disable import/exports-last
import { attempt, createContext, until, useContext } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { SQL } from 'bun'

import { classifySqlState } from '../shared/dialects'
import type { Sql } from '../shared/types'

import type { BunSql } from './types'

export const StateRef = createContext<BunSql.State>('db:impl/bun-sql')

/** The reserved connection while inside a transaction. */
const TxSession = createContext<AnyType>('db:impl/bun-sql:tx-session')
const TxDepth = createContext<number>('db:impl/bun-sql:tx-depth', 0)

/** Await a driver promise, classifying a rejection into a `DbErrors` failure. */
export function* driver(promise: Promise<AnyType>) {
  const outcome = yield* attempt(until(promise))

  if (isFailure(outcome)) {
    const error = outcome.error as AnyType
    const message = String(error?.message ?? error)

    // Bun SQL puts the SQLSTATE in `errno` (`code` is the generic ERR_POSTGRES_SERVER_ERROR);
    // node-postgres puts it in `code` — look for the five-character state in either
    const state = [error?.errno, error?.code].find(
      value => typeof value === 'string' && value.length === 5,
    )

    return yield* fail(classifySqlState(state, message), message)
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
