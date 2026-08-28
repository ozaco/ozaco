/**
 * The byte → {@link Key} decoder every terminal binding shares: CSI sequences (arrows, home/end,
 * the `~`-terminated block, xterm modifier params), `ESC`-prefixed alt combinations, the C0
 * controls, and printable code points. Pure — it takes text, it answers keys.
 */
import type { Key } from 'cli:core'

import type { Helpers } from './types'

const ESC = String.fromCodePoint(27)

const CSI_FINAL: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
}

const TILDE: Record<string, string> = {
  '1': 'home',
  '2': 'insert',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
}

const isParam = (ch: string): boolean => (ch >= '0' && ch <= '9') || ch === ';'

const decodeOne = (input: string): [Key, number] => {
  const make = (name: string, sequence: string, mods: Helpers.Mods = {}): Key => ({
    name,
    sequence,
    ctrl: mods.ctrl ?? false,
    meta: mods.meta ?? false,
    shift: mods.shift ?? false,
  })

  const first = input[0]!

  if (first === ESC) {
    if (input.length === 1) {
      return [make('escape', ESC), 1]
    }

    const second = input[1]
    if (second === '[' || second === 'O') {
      let j = 2
      let params = ''
      while (j < input.length && isParam(input[j]!)) {
        params += input[j]
        j += 1
      }
      const final = input[j]
      if (final === undefined) {
        // Incomplete sequence (split across chunks) — surface as a bare escape.
        return [make('escape', input.slice(0, j)), j]
      }
      const consumed = j + 1
      const sequence = input.slice(0, consumed)

      if (final === '~') {
        const base = params.split(';')[0] ?? ''
        return [make(TILDE[base] ?? 'unknown', sequence), consumed]
      }
      if (final === 'Z') {
        return [make('tab', sequence, { shift: true }), consumed]
      }

      const modifier = params.includes(';') ? Number(params.split(';')[1]) : 0
      return [
        make(CSI_FINAL[final] ?? 'unknown', sequence, {
          shift: modifier === 2 || modifier === 4 || modifier === 6 || modifier === 8,
          meta: modifier === 3 || modifier === 4,
          ctrl: modifier === 5 || modifier === 6 || modifier === 7 || modifier === 8,
        }),
        consumed,
      ]
    }

    // ESC + char → alt/meta + that key.
    const [inner, innerConsumed] = decodeOne(input.slice(1))
    return [{ ...inner, meta: true, sequence: ESC + inner.sequence }, innerConsumed + 1]
  }

  const code = input.codePointAt(0)!
  const ch = String.fromCodePoint(code)

  if (code === 13 || code === 10) {
    return [make('return', ch), ch.length]
  }
  if (code === 9) {
    return [make('tab', ch), ch.length]
  }
  if (code === 127 || code === 8) {
    return [make('backspace', ch), ch.length]
  }
  if (code === 32) {
    return [make('space', ch), ch.length]
  }
  if (code >= 1 && code <= 26) {
    // Ctrl + letter (1 → a, 26 → z).
    return [make(String.fromCodePoint(code + 96), ch, { ctrl: true }), ch.length]
  }

  // Printable character (possibly a multi-code-unit codepoint).
  const shift = ch !== ch.toLowerCase() && ch === ch.toUpperCase()
  return [make(ch, ch, { shift }), ch.length]
}

/**
 * Decode one chunk of terminal input into key events. A multi-byte sequence split across chunks
 * degrades to a bare `escape` rather than blocking — the next chunk decodes on its own.
 */
export const decodeKeys = (text: string): readonly Key[] => {
  const keys: Key[] = []
  let index = 0

  while (index < text.length) {
    const [key, consumed] = decodeOne(text.slice(index))
    keys.push(key)
    index += Math.max(1, consumed)
  }

  return keys
}
