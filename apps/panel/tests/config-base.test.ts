import { describe, expect, test } from 'bun:test'

import { effectiveBase, getBaseOverride, setBaseOverride } from '../src/lib/config'

describe('config base override', () => {
  test('override roundtrips, trims trailing slashes and clears on empty', () => {
    expect(getBaseOverride()).toBe('')

    setBaseOverride('http://localhost:3000/')

    expect(getBaseOverride()).toBe('http://localhost:3000')
    expect(effectiveBase()).toBe('http://localhost:3000')

    setBaseOverride('  ')

    expect(getBaseOverride()).toBe('')
  })

  test('effectiveBase falls back to the injected global (empty here)', () => {
    setBaseOverride('')

    expect(effectiveBase()).toBe('')
  })
})
