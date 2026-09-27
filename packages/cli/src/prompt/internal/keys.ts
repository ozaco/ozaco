import type { Key } from 'cli:core'

export const isEnter = (key: Key): boolean => key.name === 'return' || key.name === 'enter'
export const isUp = (key: Key): boolean => key.name === 'up' || (key.ctrl && key.name === 'p')
export const isDown = (key: Key): boolean => key.name === 'down' || (key.ctrl && key.name === 'n')
export const isSpace = (key: Key): boolean => key.name === 'space'
export const isTab = (key: Key): boolean => key.name === 'tab'

/** ctrl+c / ctrl+d / esc — the keys that cancel any prompt. */
export const isCancelKey = (key: Key): boolean =>
  key.name === 'escape' || (key.ctrl && (key.name === 'c' || key.name === 'd'))
