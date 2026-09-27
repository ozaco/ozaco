/**
 * `DbErrors` carries the matchers that classify a DRIVER error by value — its SQLSTATE (`code` on
 * node-postgres, `errno` on Bun SQL), its `SQLITE_*` code, else its text — and `driverCause` the
 * code as the `sqlstate <code>` / `sqlite <code>` cause the db span reports as
 * `db.response.status_code`.
 */
import { DbErrors } from 'db:core'
import { driverCause } from 'db:internal'
import { asFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

/** A driver error: an Error carrying the driver's fields. */
const driverError = (message: string, fields: Readonly<Record<string, unknown>>): Error =>
  Object.assign(new Error(message), fields)

describe('DbErrors — a driver error classified by value', () => {
  it.each([
    [{ code: '23505' }, DbErrors.Unique],
    [{ code: '23503' }, DbErrors.ForeignKey],
    [{ code: '23502' }, DbErrors.NotNull],
    [{ code: '23514' }, DbErrors.Check],
    [{ code: '40001' }, DbErrors.Conflict],
    [{ code: '40P01' }, DbErrors.Conflict],
    [{ code: '08006' }, DbErrors.Connection],
    [{ code: '57P01' }, DbErrors.Connection],
    // Bun SQL: the SQLSTATE in `errno`, a generic `code`
    [{ errno: '23505', code: 'ERR_POSTGRES_SERVER_ERROR' }, DbErrors.Unique],
    [{ code: 'SQLITE_CONSTRAINT_UNIQUE', errno: 2067 }, DbErrors.Unique],
    [{ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' }, DbErrors.Unique],
    [{ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' }, DbErrors.ForeignKey],
    [{ code: 'SQLITE_CONSTRAINT_NOTNULL' }, DbErrors.NotNull],
    [{ code: 'SQLITE_CONSTRAINT_CHECK' }, DbErrors.Check],
    [{ code: 'SQLITE_BUSY' }, DbErrors.Conflict],
    [{ code: 'SQLITE_LOCKED' }, DbErrors.Conflict],
    [{ code: '42601' }, DbErrors.Query],
    [{ code: 'SQLITE_ERROR' }, DbErrors.Query],
    [{ code: 'ECONNREFUSED' }, DbErrors.Query],
  ] as const)('%o → %s, the driver’s text, the error as raw', (fields, tag) => {
    const error = driverError('the driver says no', fields)
    const failure = asFailure(error, DbErrors)

    expect(failure.error).toBe(tag)
    expect(failure.message).toBe('the driver says no')
    expect(failure.raw).toBe(error)
    expect(failure.causes).toEqual([])
  })

  it('the text decides only when the code does not', () => {
    const hidden = driverError('duplicate key value violates unique constraint "users_pkey"', {})
    const sqlite = driverError('UNIQUE constraint failed: users.email', {
      code: 'SQLITE_CONSTRAINT',
    })
    const coded = driverError('null value in column "unique_code" violates not-null constraint', {
      code: '23502',
    })

    expect(asFailure(hidden, DbErrors).error).toBe(DbErrors.Unique)
    expect(asFailure(sqlite, DbErrors).error).toBe(DbErrors.Unique)
    expect(asFailure(coded, DbErrors).error).toBe(DbErrors.NotNull)
  })

  it('anything else is db.query — the catch-all, never std:result.unknown', () => {
    const thrown = new TypeError('Client was closed and is not queryable')
    const failure = asFailure(thrown, DbErrors)

    expect(failure.error).toBe(DbErrors.Query)
    expect(failure.message).toBe('Client was closed and is not queryable')
    expect(failure.raw).toBe(thrown)
    expect(asFailure('boom', DbErrors).error).toBe(DbErrors.Query)
  })
})

describe('driverCause — the driver code as a string cause', () => {
  it('sqlstate <code> / sqlite <code>, nothing for an error without one', () => {
    expect(driverCause(driverError('x', { code: '23505' }))).toBe('sqlstate 23505')
    expect(
      driverCause(driverError('x', { errno: '40001', code: 'ERR_POSTGRES_SERVER_ERROR' })),
    ).toBe('sqlstate 40001')
    expect(driverCause(driverError('x', { code: 'SQLITE_BUSY', errno: 5 }))).toBe(
      'sqlite SQLITE_BUSY',
    )
    expect(driverCause(driverError('x', { code: 'ECONNREFUSED', errno: -61 }))).toBeUndefined()
    expect(driverCause('boom')).toBeUndefined()
  })

  it('rides the classified failure as its one cause', () => {
    const error = driverError('deadlock detected', { code: '40P01' })
    const failure = asFailure(error, DbErrors, driverCause(error))

    expect(failure.error).toBe(DbErrors.Conflict)
    expect(failure.causes).toEqual(['sqlstate 40P01'])
  })
})
