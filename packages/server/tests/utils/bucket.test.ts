import { createTokenBucket } from 'server:utils'

import { describe, expect, it } from 'bun:test'

import { catchFailure } from '../helpers'

describe('createTokenBucket', () => {
  it('starts full and rejects when drained', () => {
    const time = 0
    const bucket = createTokenBucket({ capacity: 10, refillPerSecond: 5, now: () => time })

    expect(bucket.available()).toBe(10)
    expect(bucket.take(10)).toBe(true)
    expect(bucket.take()).toBe(false)
    expect(bucket.available()).toBe(0)
  })

  it('refills continuously from elapsed time and caps at capacity', () => {
    let time = 0
    const bucket = createTokenBucket({ capacity: 10, refillPerSecond: 5, now: () => time })

    bucket.take(10)

    time = 1000
    expect(bucket.available()).toBe(5)
    expect(bucket.take(6)).toBe(false)
    expect(bucket.take(5)).toBe(true)

    time = 1400
    expect(bucket.available()).toBeCloseTo(2)

    time = 100_000
    expect(bucket.available()).toBe(10)
  })

  it('take defaults to one token', () => {
    const time = 0
    const bucket = createTokenBucket({ capacity: 2, refillPerSecond: 0, now: () => time })

    expect(bucket.take()).toBe(true)
    expect(bucket.take()).toBe(true)
    expect(bucket.take()).toBe(false)
  })

  it('never refills when refillPerSecond is zero', () => {
    let time = 0
    const bucket = createTokenBucket({ capacity: 3, refillPerSecond: 0, now: () => time })

    bucket.take(3)
    time = 1_000_000
    expect(bucket.available()).toBe(0)
  })

  it('throws an invalid-options failure on invalid configuration', () => {
    for (const capacity of [0, -1, Number.POSITIVE_INFINITY]) {
      const failure = catchFailure(() => createTokenBucket({ capacity, refillPerSecond: 1 }))
      expect(failure.error).toBe('invalid-options')
      expect(failure.message).toBe(
        `createTokenBucket: capacity must be a positive number, got ${capacity}`,
      )
    }

    const refill = catchFailure(() => createTokenBucket({ capacity: 5, refillPerSecond: -1 }))
    expect(refill.error).toBe('invalid-options')
    expect(refill.message).toBe(
      'createTokenBucket: refillPerSecond must be zero or positive, got -1',
    )
  })
})
