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

/** The characters that open a run of text a `;` must NOT split on: string literals, the three
 * quoted-identifier styles and the two comment styles. */
const CLOSERS: Readonly<Record<string, string>> = {
  "'": "'",
  '"': '"',
  '`': '`',
  '[': ']',
  '--': '\n',
  '/*': '*/',
}

/**
 * Whether `sql` holds MORE than one top-level statement. `bun:sqlite`'s `query()` prepares only
 * the first statement and silently ignores the rest, so the executor must know when to hand a
 * script to `run()` instead. Literals, quoted identifiers and comments are skipped as opaque
 * runs, so a `;` inside them — or inside a trigger body — still counts (a trigger script runs
 * whole through `run()`, which is exactly right).
 */
const isMultiStatement = (sql: string): boolean => {
  let index = 0
  let split = false

  while (index < sql.length) {
    const pair = sql.slice(index, index + 2)
    const opener = CLOSERS[pair] ? pair : CLOSERS[sql[index]!] ? sql[index]! : null

    if (opener) {
      const closer = CLOSERS[opener]!
      const end = sql.indexOf(closer, index + opener.length)
      index = end === -1 ? sql.length : end + closer.length
      // a doubled quote (`''`) simply re-opens the literal on the next pass
      continue
    }

    const char = sql[index]!
    index += 1

    if (char === ';') {
      split = true
    } else if (split && !/\s/u.test(char)) {
      return true
    }
  }

  return false
}

/**
 * Run one statement on the shared handle, classifying any SQLiteError into a `DbErrors` failure.
 * A multi-statement SCRIPT (DDL batches, trigger definitions) runs whole through `run()` — it
 * yields no rows and cannot take bind parameters, so a script with params fails loudly instead
 * of silently binding to its first statement only.
 */
export const exec: Sql.Executor = function* (statement: string, params: readonly unknown[]) {
  const state = yield* useContext(StateRef)

  try {
    if (isMultiStatement(statement)) {
      if (params.length > 0) {
        return yield* fail(
          DbErrors.Query,
          'a multi-statement script cannot take bind parameters — run the statements one by one',
        )
      }

      const changes = state.db.run(statement)
      return { rows: [], rowCount: Number(changes.changes ?? 0) }
    }

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
