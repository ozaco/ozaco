// oxlint-disable import/exports-last
import type { Doc } from 'db:core'
import { attempt, createContext, operation, until, useContext } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { classifySqlState } from '../shared/dialects'

import type { PgLiveOptions } from './live'

export interface PgState {
  readonly pool: AnyType
  readonly options: { readonly url: string; readonly ssl?: AnyType }
  /** listener reconnect budget (from `options.live` when given as an object). */
  readonly liveOptions: PgLiveOptions
  /** set once the LISTEN/NOTIFY feed opened — `migrate` then installs triggers on new tables. */
  liveActive: boolean
}

export const StateRef = createContext<PgState>('db:impl/pg')
/** The pinned client while inside a transaction — statements must ride the same connection. */
export const TxSession = createContext<AnyType>('db:impl/pg:tx-session')
export const TxDepth = createContext<number>('db:impl/pg:tx-depth', 0)

export const raise = operation(function* (error: AnyType) {
  const message = String(error?.message ?? error)
  return yield* fail(classifySqlState(error?.code, message), message)
})

/** Run one statement on the pinned transaction client or the pool, classifying driver errors. */
export const exec = operation(function* (statement: string, params: readonly unknown[]) {
  const state = yield* useContext(StateRef)
  const session = yield* TxSession.get()
  const runner = session ?? state.pool
  const outcome = yield* attempt(until(runner.query(statement, [...params]) as Promise<AnyType>))
  if (isFailure(outcome)) {
    return yield* raise(outcome.error)
  }
  return outcome.value as AnyType
})

export const rowsOf = (result: AnyType): Doc[] => (result?.rows ?? []) as Doc[]
