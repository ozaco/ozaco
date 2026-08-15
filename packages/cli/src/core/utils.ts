import { ansi } from './const'
import type { WrapOptions } from './types/common'

// Matches ESC [ ... <letter> (SGR colors, cursor ops). Built from ESC to avoid a literal control
// char in source.
const ANSI_PATTERN = new RegExp(`${ansi.esc}\\[[0-9;?]*[A-Za-z]`, 'gu')

/** Split a chunk into ANSI escape sequences and single visible code points. */
const tokens = (text: string): string[] =>
  text.match(new RegExp(`${ansi.esc}\\[[0-9;?]*[A-Za-z]|[\\s\\S]`, 'gu')) ?? []

const hardBreak = (word: string, columns: number): string[] => {
  const parts: string[] = []
  let current = ''
  let width = 0

  for (const token of tokens(word)) {
    const size = token.startsWith(ansi.esc) ? 0 : 1

    if (width + size > columns && width > 0) {
      parts.push(current)
      current = ''
      width = 0
    }
    current += token
    width += size
  }

  if (current !== '') {
    parts.push(current)
  }

  return parts
}

/** Strip ANSI escape sequences from a string (so display width can be measured). */
export const stripAnsi = (input: string): string => input.replace(ANSI_PATTERN, '')

/**
 * Visible width of a string in terminal cells: ANSI codes stripped, counted by code point (no
 * East-Asian widening). The ONE width function every module measures with — measuring styled text
 * without stripping is what used to misalign tables.
 */
export const displayWidth = (text: string): number => {
  let width = 0

  for (const _ of stripAnsi(text)) {
    width += 1
  }

  return width
}

/**
 * Word-wrap `text` to `columns`, ANSI-aware: escape sequences are preserved and never counted or
 * split. Wrapping happens at spaces; with `hard: true` a word wider than a line is broken at the
 * column boundary (never inside an escape sequence).
 */
export const wrapAnsi = (text: string, columns: number, options: WrapOptions = {}): string => {
  const limit = Math.max(1, columns)
  const out: string[] = []

  for (const line of text.split('\n')) {
    const words = line.split(' ').flatMap(word => {
      if (options.hard && displayWidth(word) > limit) {
        return hardBreak(word, limit)
      }
      return [word]
    })

    let current = ''
    for (const word of words) {
      if (current === '') {
        current = word
        continue
      }
      if (displayWidth(current) + 1 + displayWidth(word) <= limit) {
        current += ` ${word}`
      } else {
        out.push(current)
        current = word
      }
    }
    out.push(current)
  }

  return out.join('\n')
}
