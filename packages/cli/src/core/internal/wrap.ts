import { ansi } from '../const'

/** Split a chunk into ANSI escape sequences and single visible code points. */
const tokens = (text: string): string[] =>
  text.match(new RegExp(`${ansi.esc}\\[[0-9;?]*[A-Za-z]|[\\s\\S]`, 'gu')) ?? []

/** Break a word wider than `columns` at the column boundary, never inside an escape sequence. */
export const hardBreak = (word: string, columns: number): string[] => {
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
