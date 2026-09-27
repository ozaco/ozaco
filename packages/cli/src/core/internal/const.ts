import { ansi } from '../const'

// Matches ESC [ ... <letter> (SGR colors, cursor ops). Built from ESC to avoid a literal control
// char in source.
export const ANSI_PATTERN = new RegExp(`${ansi.esc}\\[[0-9;?]*[A-Za-z]`, 'gu')
