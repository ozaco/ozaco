import type { Key } from 'cli:core'
import type { PaletteDef } from 'cli:palette'

import type { InputState, RenderInputOptions } from '../types/internal'

const DEL = String.fromCodePoint(127)

export const createInput = (initial = ''): InputState => ({
  value: initial,
  cursor: initial.length,
})

export const isPrintable = (key: Key): boolean =>
  !key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence >= ' ' && key.sequence !== DEL

export const editLine = (state: InputState, key: Key): InputState | undefined => {
  const { value, cursor } = state

  if (key.name === 'backspace') {
    return cursor === 0
      ? state
      : { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 }
  }
  if (key.name === 'delete') {
    return cursor >= value.length
      ? state
      : { value: value.slice(0, cursor) + value.slice(cursor + 1), cursor }
  }
  if (key.name === 'left') {
    return { value, cursor: Math.max(0, cursor - 1) }
  }
  if (key.name === 'right') {
    return { value, cursor: Math.min(value.length, cursor + 1) }
  }
  if (key.name === 'home') {
    return { value, cursor: 0 }
  }
  if (key.name === 'end') {
    return { value, cursor: value.length }
  }

  if (isPrintable(key)) {
    return {
      value: value.slice(0, cursor) + key.sequence + value.slice(cursor),
      cursor: cursor + key.sequence.length,
    }
  }

  return undefined
}

export const renderInput = (
  state: InputState,
  palette: PaletteDef.Context,
  options: RenderInputOptions = {},
): string => {
  if (state.value.length === 0 && options.placeholder) {
    const head = options.placeholder.slice(0, 1)
    return palette.colors.inverse(head) + palette.colors.muted(options.placeholder.slice(1))
  }

  let visible = state.value
  if (options.mask !== undefined) {
    visible = options.mask === '' ? '' : options.mask.repeat(state.value.length)
  }

  const cursor = Math.min(state.cursor, visible.length)
  const before = visible.slice(0, cursor)
  const at = visible.slice(cursor, cursor + 1) || ' '
  const after = visible.slice(cursor + 1)

  return before + palette.colors.inverse(at) + after
}
