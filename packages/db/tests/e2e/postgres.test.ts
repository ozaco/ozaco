import { DbAdapter, DbErrors } from 'db:core'
import { runAdapterSuite } from 'db:testing'
import { run } from 'std:effect'
import { formatFailure, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunSqlAdapter } from 'db:impl/bun-sql'
import { PgAdapter } from 'db:impl/pg'

/** Set DB_TEST_PG_URL (e.g. postgres://localhost/ozaco_test) to run these against a live server.
 * The suite drops and recreates its tables on every test. */
const url = process.env.DB_TEST_PG_URL

runAdapterSuite({
  label: 'pg',
  enabled: Boolean(url),
  raw: true,
  use: () => PgAdapter.use({ url: url! }),
})

runAdapterSuite({
  label: 'bun-sql',
  enabled: Boolean(url),
  raw: true,
  use: () => BunSqlAdapter.use({ url: url! }),
})

/** A local port nothing listens on (bound, then released). */
const closedPort = (): number => {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const { port } = server

  server.stop(true)

  return port
}

/** One statement against a refused connection: the adapter's failure. */
const refused = (use: (url: string) => AnyType): Promise<AnyType> =>
  run(function* () {
    yield* use(`postgres://ozaco:secret@127.0.0.1:${closedPort()}/ozaco`)

    return yield* DbAdapter.actions.raw('SELECT 1', [])
  })

// no server needed: the driver's rejection — not the runtime's `std:result.unknown` fold of it —
// is what the adapter classifies (the `DbErrors` matchers: its SQLSTATE / code, its text): ONE
// level, the driver's text as the message, the driver error as its `raw`
describe('driver rejections (refused connection)', () => {
  it('pg: the driver error’s text, the driver error as raw', async () => {
    const outcome = await refused(target => PgAdapter.use({ url: target }))

    expect(isFailure(outcome)).toBe(true)
    expect(outcome.error).toBe(DbErrors.Query)
    expect(outcome.message).toStartWith('connect ECONNREFUSED 127.0.0.1:')
    expect(outcome.causes.filter(isFailure)).toHaveLength(0)
    expect(outcome.raw).toBeInstanceOf(Error)
    expect(outcome.raw.code).toBe('ECONNREFUSED')
    expect(outcome.raw.message).toBe(outcome.message)
    expect(formatFailure(outcome, { chain: true })).not.toContain('std:result.unknown')
  })

  it('bun-sql: the driver error’s text, the driver error as raw', async () => {
    const outcome = await refused(target => BunSqlAdapter.use({ url: target }))

    expect(isFailure(outcome)).toBe(true)
    expect(outcome.error).toBe(DbErrors.Query)
    expect(outcome.causes.filter(isFailure)).toHaveLength(0)
    expect(outcome.raw).toBeInstanceOf(Error)
    expect(outcome.raw.code).toStartWith('ERR_POSTGRES_')
    expect(outcome.message).toBe(outcome.raw.message)
    expect(formatFailure(outcome, { chain: true })).not.toContain('std:result.unknown')
  })
})
