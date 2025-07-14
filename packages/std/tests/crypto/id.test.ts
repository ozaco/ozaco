import { describe, expect, test } from 'bun:test'

describe('std/crypto/id', async () => {
  const core = await import('@ozaco/std/crypto')
  const unsafe = await import('@ozaco/std/crypto/unsafe')
  const legacy = await import('@ozaco/std/crypto/legacy')

  describe('with 0 len', () => {
    test('core', () => {
      expect(core.$id(0).unwrap()).toBe('')
    })

    test('unsafe', () => {
      expect(unsafe.$id(0).unwrap()).toBe('')
    })

    test('legacy', () => {
      expect(legacy.$id(0).unwrap()).toBe('')
    })
  })

  describe('with 16 len', () => {
    test('core', () => {
      expect(core.$id(16).unwrap().length).toBe(16)
    })

    test('unsafe', () => {
      expect(unsafe.$id(16).unwrap().length).toBe(16)
    })

    test('legacy', () => {
      expect(legacy.$id(16).unwrap().length).toBe(16)
    })
  })

  describe('with 32 len', () => {
    test('core', () => {
      expect(core.$id(32).unwrap().length).toBe(32)
    })

    test('unsafe', () => {
      expect(unsafe.$id(32).unwrap().length).toBe(32)
    })

    test('legacy', () => {
      expect(legacy.$id(32).unwrap().length).toBe(32)
    })
  })

  describe('with even len', () => {
    test('core', () => {
      expect(core.$id(7).unwrap().length).toBe(7)
    })

    test('unsafe', () => {
      expect(unsafe.$id(7).unwrap().length).toBe(7)
    })

    test('legacy', () => {
      expect(legacy.$id(7).unwrap().length).toBe(7)
    })
  })
})
