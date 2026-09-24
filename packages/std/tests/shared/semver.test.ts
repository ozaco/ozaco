import { compareVersions, satisfies } from 'std:shared'

import { describe, expect, it } from 'bun:test'

describe('compareVersions', () => {
  it('orders by major, minor, patch', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1)
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1)
  })

  it('follows semver prerelease precedence', () => {
    // the spec §11 example chain, strictly ascending
    const chain = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ]
    for (let at = 1; at < chain.length; at += 1) {
      expect(compareVersions(chain[at - 1]!, chain[at]!)).toBe(-1)
      expect(compareVersions(chain[at]!, chain[at - 1]!)).toBe(1)
    }
    expect(chain.toReversed().toSorted(compareVersions)).toEqual(chain)
  })

  it('ignores build metadata and throws on a non-version', () => {
    expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0)
    expect(() => compareVersions('1.0', '1.0.0')).toThrow(TypeError)
  })
})

describe('satisfies', () => {
  it('exact and =', () => {
    expect(satisfies('1.2.3', '1.2.3')).toBe(true)
    expect(satisfies('1.2.3', '=1.2.3')).toBe(true)
    expect(satisfies('1.2.4', '1.2.3')).toBe(false)
  })

  it('comparison operators, combined with a space (AND)', () => {
    expect(satisfies('1.5.0', '>=1.2.0 <2.0.0')).toBe(true)
    expect(satisfies('2.0.0', '>=1.2.0 <2.0.0')).toBe(false)
    expect(satisfies('1.2.0', '>1.2.0')).toBe(false)
    expect(satisfies('1.2.0', '<=1.2.0')).toBe(true)
    expect(satisfies('1.9.9', '<2')).toBe(true)
    expect(satisfies('2.0.0', '<2')).toBe(false)
    expect(satisfies('1.3.0', '>1.2')).toBe(true)
    expect(satisfies('1.2.9', '>1.2')).toBe(false)
  })

  it('caret: no change to the leftmost non-zero field', () => {
    expect(satisfies('1.9.0', '^1.2.3')).toBe(true)
    expect(satisfies('2.0.0', '^1.2.3')).toBe(false)
    expect(satisfies('1.2.2', '^1.2.3')).toBe(false)
    expect(satisfies('0.2.9', '^0.2.3')).toBe(true)
    expect(satisfies('0.3.0', '^0.2.3')).toBe(false)
    expect(satisfies('0.0.3', '^0.0.3')).toBe(true)
    expect(satisfies('0.0.4', '^0.0.3')).toBe(false)
    expect(satisfies('1.4.0', '^1.x')).toBe(true)
  })

  it('tilde: patch-level changes', () => {
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true)
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false)
    expect(satisfies('1.2.0', '~1.2')).toBe(true)
    expect(satisfies('1.3.0', '~1.2')).toBe(false)
  })

  it('x-ranges and wildcards', () => {
    expect(satisfies('1.7.3', '1.x')).toBe(true)
    expect(satisfies('2.0.0', '1.x')).toBe(false)
    expect(satisfies('1.2.7', '1.2.*')).toBe(true)
    expect(satisfies('1.3.0', '1.2.X')).toBe(false)
    expect(satisfies('1.0.0', '1')).toBe(true)
    expect(satisfies('9.9.9', '*')).toBe(true)
    expect(satisfies('9.9.9', '')).toBe(true)
  })

  it('|| alternatives', () => {
    expect(satisfies('3.1.0', '^1.0.0 || ^3.0.0')).toBe(true)
    expect(satisfies('2.1.0', '^1.0.0 || ^3.0.0')).toBe(false)
  })

  it('prereleases compare by plain precedence', () => {
    expect(satisfies('1.0.0-rc.1', '>=0.9.0')).toBe(true)
    expect(satisfies('1.0.0-rc.1', '^1.0.0')).toBe(false)
    expect(satisfies('1.0.0-rc.2', '>=1.0.0-rc.1')).toBe(true)
    expect(satisfies('1.0.0-beta', '>=1.0.0-rc.1')).toBe(false)
  })

  it('an invalid version or comparator never matches', () => {
    expect(satisfies('nope', '*')).toBe(false)
    expect(satisfies('1.0.0', '>=banana')).toBe(false)
  })
})
