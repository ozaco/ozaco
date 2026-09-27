// oxlint-disable import/exports-last
import { DbErrors } from 'db:core'
import { driverCause } from 'db:internal'
import { createContext, until, useContext } from 'std:effect'
import { asFailure, isFailure, succeed } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Sql } from '../shared/types/sql'

import type { Pg } from './types'

/** The advisory-lock key every ozaco migrate takes. Advisory locks are scoped to the CONNECTED
 * database, so a constant serializes concurrent boots against one database without coupling
 * unrelated ones. */
export const MIGRATE_LOCK = 727_270_001

export const StateRef = createContext<Pg.State>('db:impl/pg')

/** The pinned client while inside a transaction — statements must ride the same connection. */
const TxSession = createContext<AnyType>('db:impl/pg:tx-session')
const TxDepth = createContext<number>('db:impl/pg:tx-depth', 0)

/** A driver rejection as its `DbErrors` failure — classified by the `DbErrors` matchers (the
 * SQLSTATE in `code`, else the text; `db.query` for anything else), the driver's message, the
 * driver error as `raw` and its SQLSTATE as the `sqlstate <code>` cause the db span reports as
 * `db.response.status_code`. */
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

/** Run one statement on the pinned transaction client or the pool. */
export const exec: Sql.Executor = function* (statement: string, params: readonly unknown[]) {
  const state = yield* useContext(StateRef)
  const runner = (yield* TxSession.get()) ?? state.pool
  const result = yield* driver(runner.query(statement, [...params]))
  const rows = (result?.rows ?? []) as AnyType[]

  return { rows, rowCount: Number(result?.rowCount ?? rows.length) }
}

/** The shared-transaction seam `runSqlTransaction` drives. */
export const transactional: Sql.Transactional = {
  exec,
  depth: TxDepth,

  // a transaction pins one pooled client for its whole duration
  *session(body) {
    const state = yield* useContext(StateRef)
    const client = yield* driver(state.pool.connect())

    try {
      return yield* TxSession.with(client, body)
    } finally {
      client.release()
    }
  },
}
