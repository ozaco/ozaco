/** The lowercase hex digits, by value. */
export const HEX = '0123456789abcdef'

// `String.fromCodePoint(...chunk)` spreads onto the stack: bounded chunks keep a large buffer safe
export const CHUNK = 0x80_00

/** What marks a string cut to a byte budget, and its UTF-8 size. */
export const ELLIPSIS = '…'
export const ELLIPSIS_BYTES = 3
