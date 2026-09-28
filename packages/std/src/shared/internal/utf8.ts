/** The UTF-8 size of one code point (a lone surrogate encodes as U+FFFD: 3 bytes). */
export const pointBytes = (point: number): number =>
  point < 0x80 ? 1 : point < 0x8_00 ? 2 : point < 0x1_00_00 ? 3 : 4
