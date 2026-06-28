import type { PromptDef } from 'cli:core'

import { step, wrapIndex } from './list'

const isDisabled = <T>(choices: readonly PromptDef.Choice<T>[], index: number): boolean =>
  Boolean(choices[index]?.disabled)

export const labelOf = <T>(value: T, choices: readonly PromptDef.Choice<T>[]): string => {
  const found = choices.find(choice => choice.value === value)
  return found?.label ?? String(value)
}

export const firstEnabled = <T>(choices: readonly PromptDef.Choice<T>[]): number => {
  const index = choices.findIndex(choice => !choice.disabled)
  return Math.max(0, index)
}

export const resolveIndex = <T>(
  initial: number | T | undefined,
  choices: readonly PromptDef.Choice<T>[],
): number => {
  if (choices.length === 0) {
    return 0
  }

  let index = firstEnabled(choices)

  if (typeof initial === 'number') {
    index = wrapIndex(initial, choices.length)
  } else if (initial !== undefined) {
    const found = choices.findIndex(choice => choice.value === initial)
    if (found !== -1) {
      index = found
    }
  }

  return isDisabled(choices, index)
    ? step(index, 1, { length: choices.length, disabled: i => isDisabled(choices, i) })
    : index
}

export const resolveSelected = <T>(
  initial: readonly (number | T)[] | undefined,
  choices: readonly PromptDef.Choice<T>[],
): Set<number> => {
  const selected = new Set<number>()
  if (!initial) {
    return selected
  }

  for (const item of initial) {
    if (typeof item === 'number') {
      if (item >= 0 && item < choices.length) {
        selected.add(item)
      }
    } else {
      const index = choices.findIndex(choice => choice.value === item)
      if (index !== -1) {
        selected.add(index)
      }
    }
  }

  return selected
}

export const indicesToValues = <T>(
  indices: ReadonlySet<number>,
  choices: readonly PromptDef.Choice<T>[],
): T[] => [...indices].toSorted((a, b) => a - b).map(index => choices[index]!.value)
