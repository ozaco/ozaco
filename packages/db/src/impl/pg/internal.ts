// oxlint-disable import/exports-last
import { attempt, createContext, until, useContext } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { classifySqlState } from '../shared/dialects'
import type { Sql } from '../shared/types'

import type { Pg } from './types'

/** The advisory-lock key every ozaco migrate takes. Advisory locks are scoped to the CONNECTED
 * database, so a constant serializes concurrent boots against one database without coupling
 * unrelated ones. */
export const MIGRATE_LOCK = 727_270_001

export const StateRef = createContext<Pg.State>('db:impl/pg')

/** The pinned client while inside a transaction — statements must ride the same connection. */
const TxSession = createContext<AnyType>('db:impl/pg:tx-session')
const TxDepth = createContext<number>('db:impl/pg:tx-depth', 0)

/** Classify a driver error into a `DbErrors` failure. */
export function* raise(error: AnyType) {
  const message = String(error?.message ?? error)
  return yield* fail(classifySqlState(error?.code, message), message)
}

/** Await a driver promise, classifying a rejection. */
export function* driver(promise: Promise<AnyType>) {
  const outcome = yield* attempt(until(promise))

  if (isFailure(outcome)) {
    return yield* raise(outcome.error)
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
