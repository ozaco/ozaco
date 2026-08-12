import { isFailure, isSuccess, unwrap } from 'std:result'
import type { AnyType, StandardSchemaV1 } from 'std:shared'
import { match, validateSync } from 'std:shared'

import { describe, expect, it } from 'bun:test'

// minimal standard schema: parses numbers and doubles them, so tests can see the PARSED output
const numberSchema: StandardSchemaV1<number, number> = {
  '~standard': {
    version: 1,
    vendor: 'ozaco-tests',
    validate: value =>
      typeof value === 'number'
        ? { value: value * 2 }
        : { issues: [{ message: 'expected number' }] },
  },
}

const asyncSchema: StandardSchemaV1<string, string> = {
  '~standard': {
    version: 1,
    vendor: 'ozaco-tests',
    validate: value => Promise.resolve({ value: String(value) }),
  },
}

describe('match', () => {
  it('when picks the first matching case and supports non-function handlers', () => {
    const verdict = match('text' as string | number)
      .when(value => typeof value === 'string', true)
      .when(value => typeof value === 'string', false)
      .otherwise(() => 'none')

    expect(verdict).toBe(true)
  })

  it('with validates through the schema and hands the parsed output to the handler', () => {
    const doubled = match(21 as unknown)
      .with(numberSchema, parsed => parsed + 1)
      .otherwise(() => -1)

    expect(doubled).toBe(43)

    const missed = match('nan' as unknown)
      .with(numberSchema, parsed => parsed + 1)
      .otherwise(value => `fallback:${String(value)}`)

    expect(missed).toBe('fallback:nan')
  })

  it('cases accumulate immutably — earlier builders are unaffected', () => {
    const base = match(7 as number)
    const extended = base.when(
      value => value === 7,
      () => 'matched',
    )

    expect(extended.otherwise(() => 'fallback')).toBe('matched')
    expect(base.otherwise(() => 'fallback')).toBe('fallback')
  })

  it('exhaustive throws a failure when nothing matched', () => {
    const builder = match('unhandled' as string).when(
      value => value === 'other',
      () => 'no',
    )
    const exhaustive = builder.exhaustive as AnyType

    let caught: unknown
    try {
      exhaustive()
    } catch (error) {
      caught = error
    }

    expect(isFailure(caught)).toBe(true)
    if (isFailure(caught)) {
      expect(String(caught.error)).toContain('non-exhaustive')
    }
  })

  it('run returns the matched value or undefined', () => {
    const hit = match(5 as number)
      .when(
        value => value > 1,
        value => value * 10,
      )
      .run()
    expect(hit).toBe(50)

    const miss = match(0 as number)
      .when(
        value => value > 1,
        value => value * 10,
      )
      .run()
    expect(miss).toBeUndefined()
  })
})

describe('validateSync', () => {
  it('returns the parsed output, raw issues, or an async-schema failure', () => {
    const parsed = validateSync(numberSchema, 4)
    expect(isSuccess(parsed)).toBe(true)
    expect(unwrap(parsed)).toBe(8)

    const invalid = validateSync(numberSchema, 'nope')
    expect(isFailure(invalid)).toBe(true)
    if (isFailure(invalid)) {
      expect(invalid.error).toEqual([{ message: 'expected number' }])
    }

    const asyncOutcome = validateSync(asyncSchema, 'later')
    expect(isFailure(asyncOutcome)).toBe(true)
    if (isFailure(asyncOutcome)) {
      expect(asyncOutcome.error[0]!.message).toContain('async schema')
    }
  })
})
