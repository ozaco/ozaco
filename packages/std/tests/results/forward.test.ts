import { describe, expect, test } from 'bun:test'

import { Err, err, forward, ok, okAsync } from '../../dist/results'
import { wait } from '../../src/shared'

describe('std/results/fn', () => {
  const testData = 'hi' as const

  describe('sync', () => {
    test('ok - not nested', () => {
      const result = forward(() => {
        return testData
      }, '?test-cause')

      expect(result).toBe(testData)
    })

    test('ok - nested 1', () => {
      const result = forward(() => {
        return ok(testData)
      }, '?test-cause')

      expect(result).toBe(testData)
    })

    test('ok - nested 2', () => {
      const result = forward(() => {
        return ok(ok(testData))
      }, '?test-cause')

      expect(result).toBe(testData)
    })

    test('ok - nested 3', () => {
      const result = forward(() => {
        return ok(ok(testData))
      }, '?test-cause')

      expect(result).toBe(testData)
    })

    test('err - not nested', () => {
      const result = forward.bind(
        null,
        () => {
          return err('?test', 'test message').appendCause('?test-cause')
        },
        '?test-cause'
      )

      expect(result).toThrow(Err)
    })

    test('err - nested 1', () => {
      const result = forward.bind(
        null,
        () => {
          return ok(err('?test', 'test message').appendCause('?test-cause'))
        },
        '?test-cause'
      )

      expect(result).toThrow(Err)
    })

    test('err - nested 2', () => {
      const result = forward.bind(
        null,
        () => {
          return ok(ok(err('?test', 'test message').appendCause('?test-cause')))
        },
        '?test-cause'
      )

      expect(result).toThrow(Err)
    })

    test('err - nested 3', () => {
      const result = forward.bind(
        null,
        () => {
          return ok(ok(ok(err('?test', 'test message').appendCause('?test-cause'))))
        },
        '?test-cause'
      )

      expect(result).toThrow(Err)
    })
  })

  describe('async', () => {
    test('ok - not nested', async () => {
      const result = forward(async () => {
        await wait(0)

        return testData
      })

      const awaited = await result

      expect(result).toBeInstanceOf(Promise)
      expect(awaited).toBe(testData)
    })

    test('ok - nested 1', async () => {
      const result = forward(async () => {
        await wait(0)

        return okAsync(testData)
      })

      const awaited = await result

      expect(result).toBeInstanceOf(Promise)
      expect(awaited).toBe(testData)
    })

    test('ok - nested 2', async () => {
      const result = forward(async () => {
        await wait(0)

        return okAsync(okAsync(testData))
      })

      const awaited = await result

      expect(result).toBeInstanceOf(Promise)
      expect(awaited).toBe(testData)
    })

    test('ok - nested 3', async () => {
      const result = forward(async () => {
        await wait(0)

        return okAsync(okAsync(okAsync(testData)))
      })

      const awaited = await result

      expect(result).toBeInstanceOf(Promise)
      expect(awaited).toBe(testData)
    })

    test('err - not nested', () => {
      const result = forward.bind(null, async () => {
        await wait(0)

        return err('?test', 'test message').appendCause('?test-cause')
      })

      expect(result).toThrow(Err)
    })

    test('err - nested 1', () => {
      const result = forward.bind(null, async () => {
        await wait(0)

        return ok(err('?test', 'test message').appendCause('?test-cause'))
      })

      expect(result).toThrow(Err)
    })

    test('err - nested 2', () => {
      const result = forward.bind(null, async () => {
        await wait(0)

        return ok(ok(err('?test', 'test message').appendCause('?test-cause')))
      })

      expect(result).toThrow(Err)
    })

    test('err - nested 3', () => {
      const result = forward.bind(null, async () => {
        await wait(0)

        return ok(ok(ok(err('?test', 'test message').appendCause('?test-cause'))))
      })

      expect(result).toThrow(Err)
    })
  })

  describe('hybrid', () => {
    test('ok - not nested', async () => {
      const result = forward(async () => {
        await wait(0)

        return testData
      })

      const awaited = await result

      expect(result).toBeInstanceOf(Promise)
      expect(awaited).toBe(testData)
    })

    test('ok - nested 1', async () => {
      const result = forward(async () => {
        await wait(0)

        return okAsync(testData)
      })

      const awaited = await result

      expect(result).toBeInstanceOf(Promise)
      expect(awaited).toBe(testData)
    })

    test('ok - nested 2', async () => {
      const result = forward(async () => {
        await wait(0)

        return okAsync(okAsync(testData))
      })

      const awaited = await result

      expect(result).toBeInstanceOf(Promise)
      expect(awaited).toBe(testData)
    })

    test('ok - nested 3', async () => {
      const result = forward(async () => {
        await wait(0)

        return okAsync(okAsync(okAsync(testData)))
      })

      const awaited = await result

      expect(result).toBeInstanceOf(Promise)
      expect(awaited).toBe(testData)
    })

    test('err - not nested', () => {
      const result = forward.bind(null, async () => {
        await wait(0)

        return err('?test', 'test message').appendCause('?test-cause')
      })

      expect(result).toThrow(Err)
    })

    test('err - nested 1', () => {
      const result = forward.bind(null, async () => {
        await wait(0)

        return ok(err('?test', 'test message').appendCause('?test-cause'))
      })

      expect(result).toThrow(Err)
    })

    test('err - nested 2', () => {
      const result = forward.bind(null, async () => {
        await wait(0)

        return ok(ok(err('?test', 'test message').appendCause('?test-cause')))
      })

      expect(result).toThrow(Err)
    })

    test('err - nested 3', () => {
      const result = forward.bind(null, async () => {
        await wait(0)

        return ok(ok(ok(err('?test', 'test message').appendCause('?test-cause'))))
      })

      expect(result).toThrow(Err)
    })
  })
})
