/** The lowercase hex digits, by value. */
export const HEX = '0123456789abcdef'

// `String.fromCodePoint(...chunk)` spreads onto the stack: bounded chunks keep a large buffer safe
export const CHUNK = 0x80_00
