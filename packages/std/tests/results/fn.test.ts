import { describe, expect, test } from 'bun:test'

import { $fn, Err, Ok, ResultAsync, err, errAsync, ok, okAsync } from '../../dist/results'
import { wait } from '../../dist/shared'

describe('std/results/fn', () => {
  describe('sync', () => {
    test('ok - not nested', () => {
      const result = $fn(() => {
        return 'ok'
      })()

      expect(result).toBeInstanceOf(Ok)
      expect(result.unwrap()).toBe('ok')
    })

    test('ok - nested 1', () => {
      const result = $fn(() => {
        return ok('ok')
      })()

      expect(result).toBeInstanceOf(Ok)
      expect(result.unwrap()).toBe('ok')
    })

    test('ok - nested 2', () => {
      const result = $fn(() => {
        return ok(ok('ok'))
      })()

      expect(result).toBeInstanceOf(Ok)
      expect(result.unwrap()).toBe('ok')
    })

    test('ok - nested 3', () => {
      const result = $fn(() => {
        return ok(ok(ok('ok')))
      })()

      expect(result).toBeInstanceOf(Ok)
      expect(result.unwrap()).toBe('ok')
    })

    test('err - not nested', () => {
      const result = $fn(() => {
        return err('?test', 'test message').appendCause('?test-cause')
      })()

      expect(result).toBeInstanceOf(Err)
      expect(result.unwrap).toThrow()

      if (result.isErr()) {
        expect(result.name).toBe('?test')
        expect(result.causes).toEqual(['?test-cause'])
      }
    })

    test('err - nested 1', () => {
      const result = $fn(() => {
        return ok(err('?test', 'test message').appendCause('?test-cause'))
      })()

      expect(result).toBeInstanceOf(Err)
      expect(result.unwrap).toThrow()

      if (result.isErr()) {
        expect(result.name).toBe('?test')
        expect(result.causes).toEqual(['?test-cause'])
      }
    })

    test('err - nested 2', () => {
      const result = $fn(() => {
        return ok(ok(err('?test', 'test message').appendCause('?test-cause')))
      })()

      expect(result).toBeInstanceOf(Err)
      expect(result.unwrap).toThrow()

      if (result.isErr()) {
        expect(result.name).toBe('?test')
        expect(result.causes).toEqual(['?test-cause'])
      }
    })
  })

  describe('async', () => {
    test('ok - not nested', async () => {
      const result = $fn(async () => {
        await wait(0)

        return 'ok'
      })()

      const awaited = await result

      expect(result).toBeInstanceOf(ResultAsync)
      expect(awaited).toBeInstanceOf(Ok)
      expect(awaited.unwrap()).toBe('ok')
    })

    test('ok - nested 1', async () => {
      const result = $fn(async () => {
        await wait(0)

        return okAsync('ok')
      })()

      const awaited = await result

      expect(result).toBeInstanceOf(ResultAsync)
      expect(awaited).toBeInstanceOf(Ok)
      expect(awaited.unwrap()).toBe('ok')
    })

    test('ok - nested 2', async () => {
      const result = $fn(async () => {
        await wait(0)

        return okAsync(okAsync('ok'))
      })()

      const awaited = await result

      expect(result).toBeInstanceOf(ResultAsync)
      expect(awaited).toBeInstanceOf(Ok)
      expect(awaited.unwrap()).toBe('ok')
    })

    test('ok - nested 3', async () => {
      const result = $fn(async () => {
        await wait(0)

        return okAsync(okAsync(okAsync('ok')))
      })()

      const awaited = await result

      expect(result).toBeInstanceOf(ResultAsync)
      expect(awaited).toBeInstanceOf(Ok)
      expect(awaited.unwrap()).toBe('ok')
    })

    test('err - not nested', async () => {
      const result = $fn(async () => {
        await wait(0)

        return errAsync('?test', 'test message')
      }, '?test-cause')()

      const awaited = await result

      expect(result).toBeInstanceOf(ResultAsync)
      expect(awaited).toBeInstanceOf(Err)
      expect(() => awaited.unwrap()).toThrow(Err)

      if (awaited.isErr()) {
        expect(awaited.name).toBe('?test')
        expect(awaited.causes).toEqual(['?test-cause'])
      }
    })

    test('err - nested 1', async () => {
      const result = $fn(async () => {
        await wait(0)

        return okAsync(errAsync('?test', 'test message'))
      }, '?test-cause')()

      const awaited = await result

      expect(result).toBeInstanceOf(ResultAsync)
      expect(awaited).toBeInstanceOf(Err)
      expect(() => awaited.unwrap()).toThrow(Err)

      if (awaited.isErr()) {
        expect(awaited.name).toBe('?test')
        expect(awaited.causes).toEqual(['?test-cause'])
      }
    })

    test('err - nested 2', async () => {
      const result = $fn(async () => {
        await wait(0)

        return okAsync(okAsync(errAsync('?test', 'test message')))
      }, '?test-cause')()

      const awaited = await result

      expect(result).toBeInstanceOf(ResultAsync)
      expect(awaited).toBeInstanceOf(Err)
      expect(() => awaited.unwrap()).toThrow(Err)

      if (awaited.isErr()) {
        expect(awaited.name).toBe('?test')
        expect(awaited.causes).toEqual(['?test-cause'])
      }
    })
  })

  describe('hybrid', () => {
    test('ok - not nested', async () => {
      const result = $fn(async () => {
        await wait(0)

        return ok('ok')
      })()

      const awaited = await result

      expect(result).toBeInstanceOf(ResultAsync)
      expect(awaited).toBeInstanceOf(Ok)
      expect(awaited.unwrap()).toBe('ok')
    })

    test('ok - nested 1', async () => {
      const result = $fn(async () => {
        await wait(0)

        return ok('ok')
      })()

      const awaited = await result

      expect(result).toBeInstanceOf(ResultAsync)
      expect(awaited).toBeInstanceOf(Ok)
      expect(awaited.unwrap()).toBe('ok')
    })

    test('ok - nested 2', async () => {
      const result = $fn(async () => {
        await wait(0)

        return ok(ok('ok'))
      })()

      const awaited = await result

      expect(result).toBeInstanceOf(ResultAsync)
      expect(awaited).toBeInstanceOf(Ok)
      expect(awaited.unwrap()).toBe('ok')
    })

    test('ok - nested 3', async () => {
      const result = $fn(async () => {
        await wait(0)

        return ok(ok(ok('ok')))
      })()

      const awaited = await result

      expect(result).toBeInstanceOf(ResultAsync)
      expect(awaited).toBeInstanceOf(Ok)
      expect(awaited.unwrap()).toBe('ok')
    })

    test('err - not nested', async () => {
      const result = $fn(async () => {
        await wait(0)

        return err('?test', 'test message')
      }, '?test-cause')()

      const awaited = await result

      expect(result).toBeInstanceOf(ResultAsync)
      expect(awaited).toBeInstanceOf(Err)
      expect(() => awaited.unwrap()).toThrow(Err)

      if (awaited.isErr()) {
        expect(awaited.name).toBe('?test')
        expect(awaited.causes).toEqual(['?test-cause'])
      }
    })

    test('err - nested 1', async () => {
      const result = $fn(async () => {
        await wait(0)

        return ok(err('?test', 'test message'))
      }, '?test-cause')()

      const awaited = await result

      expect(result).toBeInstanceOf(ResultAsync)
      expect(awaited).toBeInstanceOf(Err)
      expect(() => awaited.unwrap()).toThrow(Err)

      if (awaited.isErr()) {
        expect(awaited.name).toBe('?test')
        expect(awaited.causes).toEqual(['?test-cause'])
      }
    })

    test('err - nested 2', async () => {
      const result = $fn(async () => {
        await wait(0)

        return ok(ok(err('?test', 'test message')))
      }, '?test-cause')()

      const awaited = await result

      expect(result).toBeInstanceOf(ResultAsync)
      expect(awaited).toBeInstanceOf(Err)
      expect(() => awaited.unwrap()).toThrow(Err)

      if (awaited.isErr()) {
        expect(awaited.name).toBe('?test')
        expect(awaited.causes).toEqual(['?test-cause'])
      }
    })
  })
})
