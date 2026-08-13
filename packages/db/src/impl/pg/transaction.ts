import { attempt, operation, until, useContext } from 'std:effect'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { exec, raise, StateRef, TxDepth, TxSession } from './internal'

/** Run `body` atomically on one pinned client; nested calls become savepoints. */
export const runTransaction = operation(function* (body: () => AnyType) {
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
  const state = yield* useContext(StateRef)
  const connect = yield* attempt(until(state.pool.connect() as Promise<AnyType>))
  if (isFailure(connect)) {
    return yield* raise(connect.error)
  }
  const client = connect.value
  try {
    return yield* TxSession.with(client, () =>
      TxDepth.with(1, function* () {
        yield* exec('BEGIN', [])
        const inner = yield* attempt(body())
        if (isFailure(inner)) {
          yield* attempt(exec('ROLLBACK', []))
          return yield* inner
        }
        yield* exec('COMMIT', [])
        return inner.value as AnyType
      }),
    )
  } finally {
    client.release()
  }
})
