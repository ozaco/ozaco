import { describe, expect, it } from 'bun:test'

/**
 * The byte → key decoder every terminal binding shares. It is the one piece of a cli that has no
 * second chance: a mis-decoded arrow is a prompt that will not move.
 */
import { decodeKeys } from '../src/impl/shared/keys'

const ESC = String.fromCodePoint(27)
const names = (text: string): readonly string[] => decodeKeys(text).map(key => key.name)

describe('cli — key decoder', () => {
  it('decodes the CSI arrows and the home/end pair', () => {
    expect(names(`${ESC}[A${ESC}[B${ESC}[C${ESC}[D`)).toEqual(['up', 'down', 'right', 'left'])
    expect(names(`${ESC}[H${ESC}[F`)).toEqual(['home', 'end'])
  })

  it('decodes the tilde block', () => {
    expect(names(`${ESC}[3~${ESC}[5~${ESC}[6~${ESC}[2~`)).toEqual([
      'delete',
      'pageup',
      'pagedown',
      'insert',
    ])
  })

  it('reads xterm modifier parameters', () => {
    const [shifted] = decodeKeys(`${ESC}[1;2A`)
    expect(shifted).toMatchObject({ name: 'up', shift: true, ctrl: false })

    const [controlled] = decodeKeys(`${ESC}[1;5C`)
    expect(controlled).toMatchObject({ name: 'right', ctrl: true })

    const [backtab] = decodeKeys(`${ESC}[Z`)
    expect(backtab).toMatchObject({ name: 'tab', shift: true })
  })

  it('decodes the C0 controls and ctrl+letter', () => {
    expect(names('\r')).toEqual(['return'])
    expect(names('\n')).toEqual(['return'])
    expect(names('\t')).toEqual(['tab'])
    expect(names(' ')).toEqual(['space'])
    expect(names(String.fromCodePoint(127))).toEqual(['backspace'])

    const [interrupt] = decodeKeys(String.fromCodePoint(3))
    expect(interrupt).toMatchObject({ name: 'c', ctrl: true })
  })

  it('reads ESC + key as the alt/meta combination', () => {
    const [alt] = decodeKeys(`${ESC}b`)
    expect(alt).toMatchObject({ name: 'b', meta: true })
  })

  it('carries printable characters through, shift included', () => {
    expect(names('hey')).toEqual(['h', 'e', 'y'])

    const [upper] = decodeKeys('H')
    expect(upper).toMatchObject({ name: 'H', shift: true })

    // a non-BMP codepoint is ONE key, not two halves of a surrogate pair
    expect(names('🎈')).toEqual(['🎈'])
  })

  it('degrades a sequence split across chunks instead of blocking', () => {
    expect(names(`${ESC}[`)).toEqual(['escape'])
    expect(names(ESC)).toEqual(['escape'])
  })

  it('decodes a whole burst in one call', () => {
    expect(names(`ab${ESC}[A\r`)).toEqual(['a', 'b', 'up', 'return'])
  })
})
