// oxlint-disable import/exports-last
import type { Doc } from 'db:core'
import { DbErrors } from 'db:core'
import { createContext, operation, until, useContext } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Database } from 'bun:sqlite'

export interface Lock {
  acquire(): AnyType
}

/** Minimal FIFO mutex — SQLite is one shared handle, so top-level transactions serialize on it. */
export const createLock = (): Lock => {
  const waiters: Array<() => void> = []
  let held = false

  const release = (): void => {
    const next = waiters.shift()
    if (next) {
      next() // hand the lock straight to the next waiter; it stays held
      return
    }
    held = false
  }

  const acquire = operation(function* () {
    if (!held) {
      held = true
      return release
    }
    yield* until(
      new Promise<void>(resolve => {
        waiters.push(resolve)
      }),
    )
    return release
  })

  return { acquire }
}

export interface SqliteState {
  readonly db: Database
  readonly lock: Lock
}

export const StateRef = createContext<SqliteState>('db:impl/sqlite')
export const TxDepth = createContext<number>('db:impl/sqlite:tx-depth', 0)

const classify = (error: AnyType): string => {
  const code = typeof error?.code === 'string' ? error.code : ''
  const message = String(error?.message ?? error)
  if (code.includes('CONSTRAINT_UNIQUE') || code.includes('CONSTRAINT_PRIMARYKEY')) {
    return DbErrors.Unique
  }
  if (code.includes('CONSTRAINT_FOREIGNKEY')) {
    return DbErrors.ForeignKey
  }
  if (code.includes('CONSTRAINT_NOTNULL')) {
    return DbErrors.NotNull
  }
  if (code.includes('CONSTRAINT_CHECK')) {
    return DbErrors.Check
  }
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
    return DbErrors.Conflict
  }
  if (/unique constraint failed/iu.test(message)) {
    return DbErrors.Unique
  }
  return DbErrors.Query
}

/** Run one statement, classifying any SQLiteError into a `DbErrors` failure. */
export const exec = operation(function* (statement: string, params: readonly unknown[]) {
  const state = yield* useContext(StateRef)
  try {
    return state.db.query(statement).all(...(params as AnyType[])) as Doc[]
  } catch (error) {
    return yield* fail(classify(error), String((error as AnyType)?.message ?? error))
  }
})
