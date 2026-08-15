// oxlint-disable import/exports-last
import type { Doc } from 'db:core'
import { attempt, createContext, operation, until, useContext } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { classifySqlState } from '../shared/dialects'

export interface BunSqlState {
  readonly client: AnyType
}

export const StateRef = createContext<BunSqlState>('db:impl/bun-sql')
/** The reserved connection while inside a transaction. */
export const TxSession = createContext<AnyType>('db:impl/bun-sql:tx-session')
export const TxDepth = createContext<number>('db:impl/bun-sql:tx-depth', 0)

export const raise = operation(function* (error: AnyType) {
  const message = String(error?.message ?? error)
  return yield* fail(classifySqlState(error?.code ?? error?.errno, message), message)
})

/** Run one statement on the reserved transaction connection or the shared client. */
export const exec = operation(function* (statement: string, params: readonly unknown[]) {
  const state = yield* useContext(StateRef)
  const session = yield* TxSession.get()
  const runner = session ?? state.client
  const outcome = yield* attempt(until(runner.unsafe(statement, [...params]) as Promise<AnyType>))
  if (isFailure(outcome)) {
    return yield* raise(outcome.error)
  }
  const result = outcome.value
  return (Array.isArray(result) ? result : []) as Doc[]
})
