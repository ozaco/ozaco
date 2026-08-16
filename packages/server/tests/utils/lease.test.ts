import { createLease, guardLease } from 'server:utils'
import { fork, sleep } from 'std:effect'

import { describe, expect, it } from 'bun:test'

import { catchFailure, runScoped } from '../helpers'

describe('createLease', () => {
  it('tracks expiry against the injected clock', () => {
    let time = 0
    const lease = createLease({ ttlMs: 100, now: () => time })

    expect(lease.ttlMs).toBe(100)
    expect(lease.expired()).toBe(false)
    expect(lease.remaining()).toBe(100)

    time = 60
    expect(lease.remaining()).toBe(40)

    lease.renew()
    expect(lease.remaining()).toBe(100)

    time = 159
    expect(lease.expired()).toBe(false)

    time = 160
    expect(lease.expired()).toBe(true)
    expect(lease.remaining()).toBe(0)
  })

  it('throws an invalid-options failure on invalid ttl', () => {
    for (const ttlMs of [0, -5, Number.NaN]) {
      const failure = catchFailure(() => createLease({ ttlMs }))
      expect(failure.error).toBe('invalid-options')
      expect(failure.message).toBe(`createLease: ttlMs must be a positive number, got ${ttlMs}`)
    }
  })
})

describe('guardLease', () => {
  it('fires onExpire exactly once when the lease lapses', async () => {
    let fired = 0

    await runScoped(function* () {
      const lease = createLease({ ttlMs: 40 })
      yield* guardLease(lease, function* () {
        fired += 1
      })
    })

    expect(fired).toBe(1)
  })

  it('renewals keep the guard from firing until the lease truly lapses', async () => {
    let fired = 0

    await runScoped(function* () {
      const lease = createLease({ ttlMs: 120 })
      const guard = yield* fork(() =>
        guardLease(
          lease,
          function* () {
            fired += 1
          },
          { intervalMs: 10 },
        ),
      )

      yield* sleep(60)
      lease.renew()

      // past the ORIGINAL deadline, before the renewed one — the guard must not have fired
      yield* sleep(80)
      expect(fired).toBe(0)

      yield* guard
    })

    expect(fired).toBe(1)
  })
})
