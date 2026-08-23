import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Sql } from './types'

/**
 * Run `body` atomically on a SQL backend. A top-level call pins a session (`runtime.session`)
 * and wraps the body in `BEGIN … COMMIT` (rolling back on any failure); nested calls become
 * savepoints on the same session. `begin` lets a dialect pick its lock mode (`BEGIN IMMEDIATE`).
 */
export function* runSqlTransaction(
  runtime: Sql.Transactional,
  body: () => Operation<unknown>,
  begin = 'BEGIN',
) {
  const { exec, depth } = runtime
  const level = (yield* depth.get()) ?? 0

  if (level > 0) {
    const savepoint = `ozaco_sp_${level}`
    yield* exec(`SAVEPOINT ${savepoint}`, [])
    const outcome = yield* attempt(depth.with(level + 1, body))

    if (isFailure(outcome)) {
      yield* attempt(exec(`ROLLBACK TO SAVEPOINT ${savepoint}`, []))
      return yield* outcome
    }

    yield* exec(`RELEASE SAVEPOINT ${savepoint}`, [])

    return outcome.value as AnyType
  }

  return yield* runtime.session(() =>
    depth.with(1, function* () {
      yield* exec(begin, [])
      const outcome = yield* attempt(body)
      if (isFailure(outcome)) {
        yield* attempt(exec('ROLLBACK', []))
        return yield* outcome
      }
      yield* exec('COMMIT', [])
      return outcome.value as AnyType
    }),
  )
}
