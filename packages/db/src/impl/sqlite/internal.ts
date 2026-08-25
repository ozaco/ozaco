// oxlint-disable import/exports-last
import { DbErrors } from 'db:core'
import { createContext, until, useContext } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Sql } from '../shared/types'

import type { Sqlite } from './types'

export const StateRef = createContext<Sqlite.State>('db:impl/sqlite')
const TxDepth = createContext<number>('db:impl/sqlite:tx-depth', 0)

export const createLock = (): Sqlite.Lock => {
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

  return {
    *acquire() {
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
    },
  }
}

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

/** Run one statement on the shared handle, classifying any SQLiteError into a `DbErrors` failure. */
export const exec: Sql.Executor = function* (statement: string, params: readonly unknown[]) {
  const state = yield* useContext(StateRef)

  try {
    const rows = state.db.query(statement).all(...(params as AnyType[])) as AnyType[]
    return { rows, rowCount: rows.length }
  } catch (error) {
    return yield* fail(classify(error), String((error as AnyType)?.message ?? error))
  }
}

/** The shared-transaction seam `runSqlTransaction` drives. */
export const transactional: Sql.Transactional = {
  exec,
  depth: TxDepth,

  // one shared handle — a second top-level transaction must wait for the first to settle
  *session(body) {
    const state = yield* useContext(StateRef)
    const release = yield* state.lock.acquire()

    try {
      return yield* body()
    } finally {
      release()
    }
  },
}
