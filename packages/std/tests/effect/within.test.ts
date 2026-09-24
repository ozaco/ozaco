import {
  EffectErrors,
  attempt,
  createContext,
  createScope,
  run,
  sleep,
  suspend,
  within,
} from 'std:effect'
import { fail, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

const tick = (ms = 5) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })

describe('within(scope, op)', () => {
  it('resolves contexts from the target scope, not the caller', async () => {
    const Vault = createContext<string>('within-test.vault')
    const [scope, destroy] = createScope()
    scope.set(Vault, 'vault')

    const outcome = await run(function* () {
      yield* Vault.set('caller')
      const inside = yield* within(scope, () => Vault.expect())
      return { inside, outside: yield* Vault.expect() }
    })

    expect(unwrap(outcome)).toEqual({ inside: 'vault', outside: 'caller' })
    await destroy()
  })

  it('raises a failure to the caller only — the target scope survives', async () => {
    const [scope, destroy] = createScope()
    let sentinelTornDown = false

    scope.run(function* () {
      try {
        yield* suspend()
      } finally {
        sentinelTornDown = true
      }
    })

    const outcome = await run(function* () {
      const failed = yield* attempt(() =>
        within(scope, function* () {
          yield* sleep(1)
          return yield* fail('within-test.boom', 'inside the vault')
        }),
      )

      yield* sleep(5)
      const after = yield* within(scope, function* () {
        return 'still usable'
      })

      return { error: isFailure(failed) ? failed.error : null, after }
    })

    expect(unwrap(outcome)).toEqual({ error: 'within-test.boom', after: 'still usable' })
    expect(sentinelTornDown).toBe(false)

    await destroy()
    expect(sentinelTornDown).toBe(true)
  })

  it('halts the op when the caller halts', async () => {
    const [scope, destroy] = createScope()
    let started = false
    let cleaned = false
    let completed = false

    const caller = run(function* () {
      yield* within(scope, function* () {
        started = true
        try {
          yield* sleep(200)
          completed = true
        } finally {
          cleaned = true
        }
      })
    })

    await tick(5)
    expect(started).toBe(true)

    await caller.halt()
    expect(cleaned).toBe(true)

    await tick(220)
    expect(completed).toBe(false)

    // the target scope is untouched by the caller's halt
    const alive = await scope.run(function* () {
      return 'alive'
    })
    expect(unwrap(alive)).toBe('alive')

    await destroy()
  })

  it('halts the op when the target scope closes — the caller sees Halted', async () => {
    const [scope, destroy] = createScope()
    let cleaned = false

    const caller = run(function* () {
      const outcome = yield* attempt(() =>
        within(scope, function* () {
          try {
            yield* suspend()
          } finally {
            cleaned = true
          }
        }),
      )

      return isFailure(outcome) ? outcome.error : 'no failure'
    })

    await tick(5)
    await destroy()

    expect(cleaned).toBe(true)
    expect(unwrap(await caller)).toBe(EffectErrors.Halted)
  })
})
