import type { Helpers } from '../types/helpers'

export const wrapIndex = (index: number, length: number): number =>
  length === 0 ? 0 : ((index % length) + length) % length

export const paginate = <T>(items: readonly T[], active: number, size: number): Helpers.Page<T> => {
  if (items.length <= size) {
    return { items, start: 0 }
  }

  const start = Math.min(Math.max(0, active - Math.floor(size / 2)), items.length - size)
  return { items: items.slice(start, start + size), start }
}

export const step = (from: number, delta: number, options: Helpers.StepOptions): number => {
  const { length, disabled } = options
  let next = wrapIndex(from + delta, length)

  for (let guard = 0; guard < length; guard += 1) {
    if (disabled?.(next) !== true) {
      return next
    }
    next = wrapIndex(next + delta, length)
  }

  return from
}
