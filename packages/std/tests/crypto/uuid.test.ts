import { describe, expect, test } from 'bun:test'

const UUID_REGEX = new RegExp(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i)

describe('std/crypto/uuid', async () => {
  const core = await import('@ozaco/std/crypto')
  const unsafe = await import('@ozaco/std/crypto/unsafe')
  const legacy = await import('@ozaco/std/crypto/legacy')

  describe('validity', () => {
    test('core', () => {
      const uuid = core.$uuid().unwrap()

      expect(uuid).toMatch(UUID_REGEX)
      expect(uuid).toBeTypeOf('string')
      expect(uuid).toHaveLength(36)
    })

    test('unsafe', () => {
      const uuid = unsafe.$uuid().unwrap()

      expect(uuid).toMatch(UUID_REGEX)
      expect(uuid).toBeTypeOf('string')
      expect(uuid).toHaveLength(36)
    })

    test('legacy', () => {
      const uuid = legacy.$uuid().unwrap()

      expect(uuid).toMatch(UUID_REGEX)
      expect(uuid).toBeTypeOf('string')
      expect(uuid).toHaveLength(36)
    })
  })
})
