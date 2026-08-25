import { describe, expect, it } from 'bun:test'

import { isValidTopic, matchTopic } from 'transport:core'

describe('topics', () => {
  it('matches literals, single-segment and tail wildcards', () => {
    expect(matchTopic('a.b', 'a.b')).toBe(true)
    expect(matchTopic('a.b', 'a.b.c')).toBe(false)
    expect(matchTopic('a.*', 'a.b')).toBe(true)
    expect(matchTopic('a.*', 'a.b.c')).toBe(false)
    expect(matchTopic('a.*.c', 'a.b.c')).toBe(true)
    expect(matchTopic('a.>', 'a.b')).toBe(true)
    expect(matchTopic('a.>', 'a.b.c.d')).toBe(true)
    expect(matchTopic('a.>', 'a')).toBe(false)
    expect(matchTopic('>', 'anything.at.all')).toBe(true)
  })

  it('validates publishable topics', () => {
    expect(isValidTopic('a.b')).toBe(true)
    expect(isValidTopic('')).toBe(false)
    expect(isValidTopic('a..b')).toBe(false)
    expect(isValidTopic('a.*')).toBe(false)
    expect(isValidTopic('a.>')).toBe(false)
  })
})
