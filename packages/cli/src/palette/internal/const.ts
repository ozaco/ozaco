import type { PaletteDef } from '../types'

export const UNICODE_SYMBOLS: PaletteDef.Symbols = {
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

export const ASCII_SYMBOLS: PaletteDef.Symbols = {
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
