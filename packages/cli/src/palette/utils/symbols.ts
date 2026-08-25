import type { PaletteDef } from '../types'

const unicodeSymbols: PaletteDef.Symbols = {
  question: '?',
  answered: '✔',
  error: '✖',
  warning: '⚠',
  info: 'ℹ',
  pointer: '❯',
  separator: '›',
  checkboxOn: '◉',
  checkboxOff: '◯',
  barComplete: '█',
  barIncomplete: '░',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
}

const asciiSymbols: PaletteDef.Symbols = {
  question: '?',
  answered: '√',
  error: '×',
  warning: '‼',
  info: 'i',
  pointer: '>',
  separator: '>',
  checkboxOn: '(*)',
  checkboxOff: '( )',
  barComplete: '#',
  barIncomplete: '-',
  spinner: ['-', '\\', '|', '/'],
}

export const createSymbols = (unicode: boolean): PaletteDef.Symbols =>
  unicode ? { ...unicodeSymbols } : { ...asciiSymbols }
