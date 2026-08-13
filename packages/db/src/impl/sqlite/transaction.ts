import { attempt, operation, useContext } from 'std:effect'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { exec, StateRef, TxDepth } from './internal'

/** Run `body` atomically: top-level transactions serialize on the shared handle's lock, nested
 * calls become savepoints. */
export const runTransaction = operation(function* (body: () => AnyType) {
  const state = yield* useContext(StateRef)
  const depth = (yield* TxDepth.get()) ?? 0
  if (depth > 0) {
    const savepoint = `ozaco_sp_${depth}`
    yield* exec(`SAVEPOINT ${savepoint}`, [])
    const outcome = yield* attempt(TxDepth.with(depth + 1, body))
    if (isFailure(outcome)) {
      yield* attempt(exec(`ROLLBACK TO SAVEPOINT ${savepoint}`, []))
      return yield* outcome
    }
    yield* exec(`RELEASE SAVEPOINT ${savepoint}`, [])
    return outcome.value as AnyType
  }
  // one shared handle — a second top-level transaction must wait for the first to settle
  const release = yield* state.lock.acquire()
  try {
    yield* exec('BEGIN IMMEDIATE', [])
    const outcome = yield* attempt(TxDepth.with(1, body))
    if (isFailure(outcome)) {
      yield* attempt(exec('ROLLBACK', []))
      return yield* outcome
    }
    yield* exec('COMMIT', [])
    return outcome.value as AnyType
  } finally {
    release()
  }
})
