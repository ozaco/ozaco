import type { Operation } from 'std:effect'
import { backoff, backoffDelay, retry, run } from 'std:effect'
import { fail, isFailure, isSuccess, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

describe('backoffDelay', () => {
  it('grows exponentially from the defaults', () => {
    expect(backoffDelay(1)).toBe(250)
    expect(backoffDelay(2)).toBe(500)
    expect(backoffDelay(3)).toBe(1000)
  })

  it('caps at maxDelayMs', () => {
    expect(backoffDelay(20)).toBe(30_000)
    expect(backoffDelay(4, { delayMs: 100, factor: 3, maxDelayMs: 1000 })).toBe(1000)
  })

  it('is deterministic without jitter and bounded with it', () => {
    expect(backoffDelay(2, { jitter: 0 })).toBe(500)
    expect(backoffDelay(2, { jitter: 0.4, random: () => 0 })).toBeCloseTo(300)
    expect(backoffDelay(2, { jitter: 0.4, random: () => 1 })).toBeCloseTo(500)
  })

  it('backoff binds options into a reusable schedule', () => {
    const schedule = backoff({ delayMs: 10 })
    expect(schedule(1)).toBe(10)
    expect(schedule(3)).toBe(40)
  })
})

describe('retry', () => {
  it('returns immediately when the first attempt succeeds', async () => {
    let calls = 0

    const outcome = await run(() =>
      retry(function* (): Operation<string> {
        calls += 1
        return 'ok'
      }),
    )

    expect(calls).toBe(1)
    expect(isSuccess(outcome)).toBe(true)
    expect(unwrap(outcome)).toBe('ok')
  })

  it('succeeds after transient failures', async () => {
    let calls = 0

    const outcome = await run(() =>
      retry(
        function* (): Operation<string> {
          calls += 1
          if (calls < 3) {
            yield* fail('transient', `attempt ${calls} failed`)
          }
          return 'ok'
        },
        { attempts: 3, delayMs: 1 },
      ),
    )

    expect(calls).toBe(3)
    expect(isSuccess(outcome)).toBe(true)
    expect(unwrap(outcome)).toBe('ok')
  })

  it('exhausts attempts and re-raises the LAST failure with the retry cause appended', async () => {
    let calls = 0

    const outcome = await run(() =>
      retry(
        function* (): Operation<string> {
          calls += 1
          return yield* fail(`error-${calls}`, `attempt ${calls} down`)
        },
        { attempts: 2, delayMs: 1 },
      ),
    )

    expect(calls).toBe(2)
    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('error-2')
      expect(outcome.causes).toContain('retry: 2 attempts exhausted')
    }
  })

  it('stops immediately when the predicate rejects the failure', async () => {
    let calls = 0

    const outcome = await run(() =>
      retry(
        function* (): Operation<string> {
          calls += 1
          return yield* fail('fatal', 'not retriable')
        },
        { attempts: 5, delayMs: 1, when: failure => failure.error !== 'fatal' },
      ),
    )

    expect(calls).toBe(1)
    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('fatal')
      expect(outcome.causes).toContain('retry: 1 attempts exhausted')
    }
  })
})
