import { fromBase64, toBase64, toHex } from 'std:shared'

import { describe, expect, it } from 'bun:test'

const text = (value: string) => new TextEncoder().encode(value)

describe('toHex', () => {
  it('lowercase, two chars per byte, zero-padded', () => {
    expect(toHex(new Uint8Array([0, 1, 15, 16, 171, 255]))).toBe('00010f10abff')
    expect(toHex(new Uint8Array())).toBe('')
  })
})

describe('toBase64 / fromBase64', () => {
  it('matches the standard padded alphabet', () => {
    expect(toBase64(text(''))).toBe('')
    expect(toBase64(text('f'))).toBe('Zg==')
    expect(toBase64(text('fo'))).toBe('Zm8=')
    expect(toBase64(text('foo'))).toBe('Zm9v')
    expect(toBase64(new Uint8Array([251, 255]))).toBe('+/8=')
  })

  it('round-trips arbitrary bytes, larger than one encoding chunk', () => {
    const bytes = new Uint8Array(100_000).map((_, index) => (index * 31) % 256)
    expect(fromBase64(toBase64(bytes))).toEqual(bytes)
  })

  it('accepts the url-safe alphabet, missing padding and whitespace', () => {
    expect(fromBase64('-_8')).toEqual(new Uint8Array([251, 255]))
    expect(fromBase64('Zm8')).toEqual(text('fo'))
    expect(fromBase64('Zm9v\nYmFy')).toEqual(text('foobar'))
  })

  it('throws on characters outside the alphabet', () => {
    expect(() => fromBase64('!!!!')).toThrow()
  })
})
