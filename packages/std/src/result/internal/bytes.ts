const ELLIPSIS = '…'
const ELLIPSIS_BYTES = 3

/** The UTF-8 size of one code point (U+0080, U+0800, U+10000 start the 2-, 3- and 4-byte forms;
 * a lone surrogate encodes as U+FFFD: 3 bytes). */
const pointBytes = (point: number): number =>
  point < 128 ? 1 : point < 2048 ? 2 : point < 65_536 ? 3 : 4

/** The UTF-8 byte length of `text`, without encoding it. */
export const byteLength = (text: string): number => {
  let bytes = 0

  for (const char of text) {
    bytes += pointBytes(char.codePointAt(0) ?? 0)
  }

  return bytes
}

/** `text` cut on a code-point boundary to at most `max` UTF-8 bytes, a cut marked with `…`. */
export const cutBytes = (text: string, max: number): string => {
  if (byteLength(text) <= max) {
    return text
  }

  if (max < ELLIPSIS_BYTES) {
    return ''
  }

  const budget = max - ELLIPSIS_BYTES
  let bytes = 0
  let cut = ''

  for (const char of text) {
    const size = pointBytes(char.codePointAt(0) ?? 0)
    if (bytes + size > budget) {
      break
    }
    bytes += size
    cut += char
  }

  return `${cut}${ELLIPSIS}`
}
