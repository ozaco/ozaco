import { EffectErrors, attempt, run, sleep, timeout } from 'std:effect'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

describe('timeout', () => {
  it('answers the value within the deadline; past it, std:effect.timeout with the body halted', async () => {
    unwrap(
      await run(function* () {
        expect(
          yield* timeout(function* () {
            yield* sleep(1)

            return 'fast'
          }, 200),
        ).toBe('fast')

        let halted = false
        const late = yield* attempt(() =>
          timeout(
            function* () {
              try {
                yield* sleep(5000)
              } finally {
                halted = true
              }

              return 'slow'
            },
            20,
            { name: 'slow job' },
          ),
        )

        expect(isFailure(late) && late.error).toBe(EffectErrors.Timeout)
        expect(isFailure(late) && late.message).toBe('slow job timed out after 20ms')
        expect(halted).toBe(true)
      }),
    )
  })
})
