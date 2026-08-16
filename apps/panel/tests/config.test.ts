import { describe, expect, test } from 'bun:test'

import { getTheme, getToken, panelBase, setTheme, setToken } from '../src/lib/config'

describe('config', () => {
  test('token get/set roundtrip through the store (memory fallback in bun)', () => {
    expect(getToken()).toBe('')

    setToken('secret')

    expect(getToken()).toBe('secret')

    setToken('')

    expect(getToken()).toBe('')
  })

  test('theme persistence defaults to system and roundtrips', () => {
    expect(getTheme()).toBe('system')

    setTheme('light')

    expect(getTheme()).toBe('light')

    setTheme('system')

    expect(getTheme()).toBe('system')
  })

  test('panelBase falls back to same-origin (empty) without an injected global', () => {
    expect(panelBase()).toBe('')
  })
})
