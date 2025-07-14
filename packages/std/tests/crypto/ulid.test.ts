import { describe, expect, test } from 'bun:test'

const ULID_REGEX = new RegExp(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i)

const EXAMPLE_ULIDS = {
  '01BX5ZZKBKACTAV9WEVGEMMVRY': 1_508_808_576_371,
  '01K05F1TQHSVXE1HZXEHGF0CB2': 1_752_530_217_713,
} as const

describe('std/crypto/ulid', async () => {
  const core = await import('@ozaco/std/crypto')
  const unsafe = await import('@ozaco/std/crypto/unsafe')
  const legacy = await import('@ozaco/std/crypto/legacy')

  describe('creation', () => {
    describe('core', () => {
      test('validity', () => {
        const uuid = core.$ulid().unwrap()

        expect(uuid).toMatch(ULID_REGEX)
        expect(uuid).toBeTypeOf('string')
        expect(uuid).toHaveLength(26)
      })

      test('validity with date', () => {
        const date = new Date()
        const uuid = core.$ulid(date).unwrap()

        expect(uuid).toMatch(ULID_REGEX)
        expect(uuid).toBeTypeOf('string')
        expect(uuid).toHaveLength(26)
      })
    })

    describe('unsafe', () => {
      test('validity', () => {
        const uuid = unsafe.$ulid().unwrap()

        expect(uuid).toMatch(ULID_REGEX)
        expect(uuid).toBeTypeOf('string')
        expect(uuid).toHaveLength(26)
      })

      test('validity with date', () => {
        const date = new Date()
        const uuid = unsafe.$ulid(date).unwrap()

        expect(uuid).toMatch(ULID_REGEX)
        expect(uuid).toBeTypeOf('string')
        expect(uuid).toHaveLength(26)
      })
    })

    describe('legacy', () => {
      test('validity', () => {
        const uuid = legacy.$ulid().unwrap()

        expect(uuid).toMatch(ULID_REGEX)
        expect(uuid).toBeTypeOf('string')
        expect(uuid).toHaveLength(26)
      })

      test('validity with date', () => {
        const date = new Date()
        const uuid = legacy.$ulid(date).unwrap()

        expect(uuid).toMatch(ULID_REGEX)
        expect(uuid).toBeTypeOf('string')
        expect(uuid).toHaveLength(26)
      })
    })
  })

  describe('parsing', () => {
    test('core', () => {
      for (const [ulid, time] of Object.entries(EXAMPLE_ULIDS)) {
        const date = core.$parseUlid(ulid).unwrap()

        expect(+date).toBe(time)
      }
    })

    test('unsafe', () => {
      for (const [ulid, time] of Object.entries(EXAMPLE_ULIDS)) {
        const date = unsafe.$parseUlid(ulid).unwrap()

        expect(+date).toBe(time)
      }
    })

    test('legacy', () => {
      for (const [ulid, time] of Object.entries(EXAMPLE_ULIDS)) {
        const date = legacy.$parseUlid(ulid).unwrap()

        expect(+date).toBe(time)
      }
    })
  })
})
