import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from '../internal/const'
import type { PaletteDef } from '../types'

export const createSymbols = (unicode: boolean): PaletteDef.Symbols =>
  unicode ? { ...UNICODE_SYMBOLS } : { ...ASCII_SYMBOLS }
